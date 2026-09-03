import {
  DEFAULT_CEX_APPROACH_PERCENT,
  DEFAULT_CEX_MIN_IMPULSE_PERCENT,
  DEFAULT_CEX_ZONE_LOOKBACK,
  DEFAULT_ZONE_PARAMS,
  evaluateZones,
  type Candle,
  type ZoneScanParams,
  type ZoneSignal,
} from './consolidation-zone-service';

const BINANCE_API_URL = 'https://fapi.binance.com';

export const DEFAULT_CEX_ZONE_PARAMS: ZoneScanParams = {
  ...DEFAULT_ZONE_PARAMS,
  lookback: DEFAULT_CEX_ZONE_LOOKBACK,
  minImpulsePercent: DEFAULT_CEX_MIN_IMPULSE_PERCENT,
  approachPercent: DEFAULT_CEX_APPROACH_PERCENT,
  // Temporarily relax only the immediate wick-through gate for Binance 1D.
  // The prior-candle high/low geometry remains required.
  requireRelativeBaseStructure: true,
  rejectImmediateWickThrough: false,
};

export interface CexConsolidationHit {
  symbol: string;
  rawSymbol: string;
  zoneType: 'support' | 'resistance';
  signal: ZoneSignal;
  price: number;
  priceChange24h: number;
  volume: number;
  zoneHigh: number;
  zoneLow: number;
  distancePercent: number;
  insideZone: boolean;
  zoneStatus: 'fresh' | 'tapped';
  ageCandles: number;
  impulsePercent: number;
  lastTapAgeCandles?: number;
  createdAt: number;
  fundingRate?: number;
}

export interface CexConsolidationScanResult {
  support: CexConsolidationHit[];
  resistance: CexConsolidationHit[];
  params: ZoneScanParams;
  timestamp: string;
  totalScanned: number;
  totalSymbols: number;
  errors: string[];
}

interface ScanOptions {
  /** The admin UI uses two; the notifier uses all actionable zones. */
  maxHitsPerSymbol?: number;
  batchSize?: number;
  batchDelayMs?: number;
}

interface Ticker {
  lastPrice: number;
  priceChange24h: number;
  quoteVolume: number;
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function sanitizeCexZoneParams(body: Record<string, unknown> = {}): ZoneScanParams {
  const num = (value: unknown, fallback: number, min: number, max: number) => {
    const parsed = typeof value === 'number' ? value : parseFloat(String(value));
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  const defaults = DEFAULT_CEX_ZONE_PARAMS;
  const bool = (value: unknown, fallback: boolean) =>
    typeof value === 'boolean' ? value : fallback;

  return {
    lookback: Math.round(
      num(body.lookback, defaults.lookback, 20, DEFAULT_CEX_ZONE_LOOKBACK),
    ),
    minImpulsePercent: num(body.minImpulsePercent, defaults.minImpulsePercent, 1, 50),
    impulseWindow: Math.round(num(body.impulseWindow, defaults.impulseWindow, 1, 10)),
    structureLookback: Math.round(
      num(body.structureLookback, defaults.structureLookback, 1, 20),
    ),
    minSeparation: Math.round(num(body.minSeparation, defaults.minSeparation, 0, 15)),
    maxBaseCandles: Math.round(
      num(body.maxBaseCandles, defaults.maxBaseCandles, 1, 5),
    ),
    approachPercent: num(body.approachPercent, defaults.approachPercent, 0.5, 20),
    recentTapCandles: Math.round(
      num(body.recentTapCandles, defaults.recentTapCandles, 0, 10),
    ),
    recentZoneCandles: Math.round(
      num(body.recentZoneCandles, defaults.recentZoneCandles, 0, 10),
    ),
    requireRelativeBaseStructure: bool(
      body.requireRelativeBaseStructure,
      defaults.requireRelativeBaseStructure,
    ),
    rejectImmediateWickThrough: bool(
      body.rejectImmediateWickThrough,
      defaults.rejectImmediateWickThrough,
    ),
  };
}

async function fetchAllSymbols(): Promise<string[]> {
  const response = await fetch(`${BINANCE_API_URL}/fapi/v1/exchangeInfo`, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Binance symbols: HTTP ${response.status}`);
  }

  const data = await response.json();
  const symbols: string[] = [];

  for (const item of data.symbols || []) {
    if (
      item.symbol &&
      item.symbol.endsWith('USDT') &&
      item.contractType === 'PERPETUAL' &&
      item.status === 'TRADING'
    ) {
      symbols.push(item.symbol);
    }
  }

  return symbols.sort();
}

async function fetchKlinePage(
  symbol: string,
  limit: number,
  endTime?: number,
): Promise<Candle[]> {
  const endTimeParam = endTime === undefined ? '' : `&endTime=${endTime}`;
  const url =
    `${BINANCE_API_URL}/fapi/v1/klines?symbol=${symbol}` +
    `&interval=1d&limit=${limit}${endTimeParam}`;
  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;

    try {
      response = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch {
      if (attempt < maxRetries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw new Error('network error after retries');
    }

    if (response.ok) {
      const data = await response.json();
      return (data || []).map((kline: (string | number)[]) => ({
        timestamp: Number(kline[0]),
        open: parseFloat(String(kline[1])),
        high: parseFloat(String(kline[2])),
        low: parseFloat(String(kline[3])),
        close: parseFloat(String(kline[4])),
      }));
    }

    const retryable =
      response.status === 429 || response.status === 418 || response.status >= 500;
    if (retryable && attempt < maxRetries) {
      const retryAfter = parseInt(response.headers.get('Retry-After') || '0', 10);
      const waitMs =
        retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 500 * 2 ** attempt;
      await sleep(waitMs);
      continue;
    }

    throw new Error(`HTTP ${response.status}`);
  }

  throw new Error('request failed after retries');
}

/**
 * Two 500-candle pages are cheaper than one 1,000-candle request under
 * Binance Futures request weights, while returning the same chronological
 * history.
 */
async function fetchDailyCandles(symbol: string, limit: number): Promise<Candle[]> {
  const target = Math.min(Math.max(1, limit), DEFAULT_CEX_ZONE_LOOKBACK);
  const pages: Candle[][] = [];
  let remaining = target;
  let endTime: number | undefined;

  while (remaining > 0) {
    const pageLimit = Math.min(remaining, 500);
    const page = await fetchKlinePage(symbol, pageLimit, endTime);
    if (page.length === 0) break;

    pages.unshift(page);
    remaining -= page.length;

    if (page.length < pageLimit) break;
    endTime = page[0].timestamp - 1;
  }

  return Array.from(
    new Map(pages.flat().map((candle) => [candle.timestamp, candle])).values(),
  )
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-target);
}

async function fetch24hTickers(): Promise<Map<string, Ticker>> {
  const tickers = new Map<string, Ticker>();

  try {
    const response = await fetch(`${BINANCE_API_URL}/fapi/v1/ticker/24hr`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return tickers;

    const data = await response.json();
    for (const item of data) {
      if (!item.symbol) continue;
      tickers.set(item.symbol, {
        lastPrice: parseFloat(item.lastPrice),
        priceChange24h: parseFloat(item.priceChangePercent),
        quoteVolume: parseFloat(item.quoteVolume),
      });
    }
  } catch {
    // Non-fatal: the most recent daily close is a safe fallback.
  }

  return tickers;
}

async function fetchFundingRates(): Promise<Map<string, number>> {
  const rates = new Map<string, number>();

  try {
    const response = await fetch(`${BINANCE_API_URL}/fapi/v1/premiumIndex`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return rates;

    const data = await response.json();
    for (const item of data) {
      if (item.symbol && item.lastFundingRate) {
        rates.set(item.symbol, parseFloat(item.lastFundingRate) * 100);
      }
    }
  } catch {
    // Funding is display-only and must not fail a scan.
  }

  return rates;
}

export async function scanCexConsolidation(
  requestedParams: Partial<ZoneScanParams> = {},
  options: ScanOptions = {},
): Promise<CexConsolidationScanResult> {
  const params = sanitizeCexZoneParams(requestedParams as Record<string, unknown>);
  const maxHitsPerSymbol = options.maxHitsPerSymbol ?? 2;
  const batchSize = options.batchSize ?? 10;
  const batchDelayMs = options.batchDelayMs ?? 200;

  const [symbols, tickers, fundingRates] = await Promise.all([
    fetchAllSymbols(),
    fetch24hTickers(),
    fetchFundingRates(),
  ]);

  if (symbols.length === 0) {
    throw new Error('Binance returned no active USDT perpetual symbols');
  }

  const support: CexConsolidationHit[] = [];
  const resistance: CexConsolidationHit[] = [];
  const errors: string[] = [];
  let totalScanned = 0;

  const processSymbol = async (rawSymbol: string) => {
    const candles = await fetchDailyCandles(rawSymbol, params.lookback);
    if (candles.length < 10) return;

    const ticker = tickers.get(rawSymbol);
    const price = ticker?.lastPrice || candles[candles.length - 1].close;
    const hits = evaluateZones(candles, price, params).slice(0, maxHitsPerSymbol);

    for (const hit of hits) {
      const result: CexConsolidationHit = {
        symbol: rawSymbol.replace(/USDT$/, ''),
        rawSymbol,
        zoneType: hit.zone.type,
        signal: hit.signal,
        price,
        priceChange24h: ticker?.priceChange24h ?? 0,
        volume: ticker?.quoteVolume ?? 0,
        zoneHigh: hit.zone.high,
        zoneLow: hit.zone.low,
        distancePercent: hit.distancePercent,
        insideZone: hit.insideZone,
        zoneStatus: hit.zone.status,
        ageCandles: hit.zone.ageCandles,
        impulsePercent: hit.zone.impulsePercent,
        lastTapAgeCandles: hit.zone.lastTapAgeCandles,
        createdAt: hit.zone.createdAt,
        fundingRate: fundingRates.get(rawSymbol),
      };

      (hit.zone.type === 'support' ? support : resistance).push(result);
    }
  };

  const failed: string[] = [];
  for (let index = 0; index < symbols.length; index += batchSize) {
    const batch = symbols.slice(index, index + batchSize);

    await Promise.all(
      batch.map(async (symbol) => {
        totalScanned++;
        try {
          await processSymbol(symbol);
        } catch {
          failed.push(symbol);
        }
      }),
    );

    if (index + batchSize < symbols.length) {
      await sleep(batchDelayMs);
    }
  }

  if (failed.length > 0) {
    await sleep(2000);
    for (const symbol of failed) {
      try {
        await processSymbol(symbol);
      } catch (error) {
        errors.push(
          `${symbol}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
      await sleep(batchDelayMs);
    }
  }

  const signalRank: Record<ZoneSignal, number> = {
    at_zone: 0,
    approaching: 1,
    recent_tap: 2,
    new_zone: 3,
  };
  const sortHits = (hits: CexConsolidationHit[]) =>
    hits.sort(
      (a, b) =>
        signalRank[a.signal] - signalRank[b.signal] ||
        a.distancePercent - b.distancePercent,
    );

  return {
    support: sortHits(support),
    resistance: sortHits(resistance),
    params,
    timestamp: new Date().toISOString(),
    totalScanned,
    totalSymbols: symbols.length,
    errors,
  };
}
