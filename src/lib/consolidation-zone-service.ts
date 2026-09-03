/**
 * Consolidation Zone (Order Block) detection service.
 *
 * Pattern definition (daily timeframe):
 * - Bullish zone (support): a short counter-trend pause — 1-3 consecutive red
 *   candles — immediately followed by an impulsive rally that breaks above the
 *   recent structure high. The pause candles' range becomes a demand zone.
 *   Tradable when price later retraces down into it for the FIRST time.
 * - Bearish zone (resistance): 1-3 consecutive green candles immediately
 *   followed by an impulsive drop through the recent structure low. Tradable
 *   when price rallies back up into it for the first time.
 *
 * Quality gates that separate real zones from chop:
 * - The impulse must confirm within a few candles (close beyond the zone AND
 *   beyond the structure extreme of the candles before the pause).
 * - Price must STAY AWAY for at least minSeparation candles before returning;
 *   an immediate return means range chop, not an impulse.
 * - The total move away (measured to the extreme reached before the first
 *   return) must be at least minImpulsePercent.
 * - A zone dies when a candle CLOSES through its far side.
 * - A zone is CONSUMED once its first retrace happened more than
 *   recentTapCandles ago — the tradable event has passed, so it is not
 *   reported anymore.
 */

export type ZoneSignal = 'at_zone' | 'approaching' | 'recent_tap' | 'new_zone';

export interface ConsolidationZone {
  type: 'support' | 'resistance';
  /** Zone boundaries: combined range of the consolidation candle(s) */
  high: number;
  low: number;
  /** Timestamp (ms) of the last consolidation candle of the pause */
  createdAt: number;
  /** Candles elapsed since the zone formed (0 = most recent candle) */
  ageCandles: number;
  /** Number of candles making up the consolidation pause (1-3) */
  baseCandles: number;
  /** Size of the impulse away from the zone (to the extreme reached before the first return), in % */
  impulsePercent: number;
  /** Furthest price reached by the impulse before the first return */
  impulseExtreme: number;
  /** fresh = never revisited; tapped = price re-entered but did not close through */
  status: 'fresh' | 'tapped';
  /** Candles ago the zone was FIRST re-entered (undefined if fresh) */
  firstTapAgeCandles?: number;
  /** Candles ago the zone was last touched (undefined if fresh) */
  lastTapAgeCandles?: number;
}

export interface ZoneHit {
  zone: ConsolidationZone;
  /** Distance from current price to nearest zone edge, in % (0 if inside zone) */
  distancePercent: number;
  /** True if the current price is inside the zone right now */
  insideZone: boolean;
  signal: ZoneSignal;
}

export interface ZoneScanParams {
  /** How many daily candles to look back for zones (shared default 120; CEX scanner default 1000) */
  lookback: number;
  /** Total move away from the zone must be at least this % (default 8) */
  minImpulsePercent: number;
  /** Candles the impulse has to confirm (close beyond zone + structure break) (default 3) */
  impulseWindow: number;
  /** Impulse must exceed the extreme of this many candles before the pause (default 5) */
  structureLookback: number;
  /** Price must stay away from the zone for at least this many candles (default 4) */
  minSeparation: number;
  /** Max consecutive counter-trend candles that form the consolidation pause (default 3) */
  maxBaseCandles: number;
  /** Flag coins whose price is within this % of a zone edge (default 3) */
  approachPercent: number;
  /** First retrace into the zone must be within the last N candles to still be tradable (default 2) */
  recentTapCandles: number;
  /** Flag zones formed within the last N candles as "new" (default 3) */
  recentZoneCandles: number;
  /** Require the base to shift both its high and low beyond the prior candle */
  requireRelativeBaseStructure: boolean;
  /** Reject a setup when the first post-base candle wicks through the far edge */
  rejectImmediateWickThrough: boolean;
}

/**
 * The Binance daily scanner uses a deeper default than the shared zone engine.
 * Keep this separate so the on-chain and forex scanners retain their own
 * history budgets.
 */
export const DEFAULT_CEX_ZONE_LOOKBACK = 1000;
export const DEFAULT_CEX_MIN_IMPULSE_PERCENT = 3;
export const DEFAULT_CEX_APPROACH_PERCENT = 4;

export const DEFAULT_ZONE_PARAMS: ZoneScanParams = {
  lookback: 120,
  minImpulsePercent: 8,
  impulseWindow: 3,
  structureLookback: 5,
  minSeparation: 4,
  maxBaseCandles: 3,
  approachPercent: 3,
  recentTapCandles: 2,
  recentZoneCandles: 3,
  requireRelativeBaseStructure: true,
  rejectImmediateWickThrough: true,
};

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Detect consolidation zones in a series of daily candles (oldest first).
 * Returns only zones that are still valid (not closed through). Overlapping
 * zones of the same type are deduped, keeping the most recent one.
 */
export function detectZones(candles: Candle[], params: ZoneScanParams = DEFAULT_ZONE_PARAMS): ConsolidationZone[] {
  if (candles.length < params.structureLookback + 5) return [];

  const last = candles.length - 1;
  const zones: ConsolidationZone[] = [];

  // Find maximal runs of consecutive same-color candles. A short red run is a
  // bullish (support) candidate, a short green run a bearish (resistance) one.
  let runStart = -1;
  let runColor: 'red' | 'green' | null = null;

  const flushRun = (start: number, end: number, color: 'red' | 'green') => {
    const length = end - start + 1;
    // Longer runs are trends, not consolidation pauses
    if (length > params.maxBaseCandles) return;
    // Need candles before (structure) and after (impulse)
    if (start < 1 || end >= last) return;
    const zone = evaluateZone(candles, start, end, color === 'red' ? 'up' : 'down', params);
    if (zone) zones.push(zone);
  };

  // The final candle is still forming — exclude it from pause detection
  for (let i = 0; i < last; i++) {
    const c = candles[i];
    const color: 'red' | 'green' | null = c.close < c.open ? 'red' : c.close > c.open ? 'green' : null;
    if (color === runColor && runColor !== null) continue;
    if (runColor !== null && runStart >= 0) flushRun(runStart, i - 1, runColor);
    runColor = color;
    runStart = color === null ? -1 : i;
  }
  if (runColor !== null && runStart >= 0) flushRun(runStart, last - 1, runColor);

  // Dedupe overlapping zones of the same type, keeping the most recent
  zones.sort((a, b) => b.createdAt - a.createdAt);
  const kept: ConsolidationZone[] = [];
  for (const z of zones) {
    const overlaps = kept.some(
      (k) => k.type === z.type && z.low <= k.high && z.high >= k.low
    );
    if (!overlaps) kept.push(z);
  }
  return kept;
}

/**
 * Evaluate a consolidation pause (candles start..end) for a valid impulse and
 * zone survival. direction 'up' = support zone (red pause, rally after),
 * 'down' = resistance zone (green pause, dump after).
 */
function evaluateZone(
  candles: Candle[],
  start: number,
  end: number,
  direction: 'up' | 'down',
  params: ZoneScanParams,
): ConsolidationZone | null {
  const last = candles.length - 1;

  let zoneHigh = -Infinity;
  let zoneLow = Infinity;
  for (let i = start; i <= end; i++) {
    zoneHigh = Math.max(zoneHigh, candles[i].high);
    zoneLow = Math.min(zoneLow, candles[i].low);
  }
  const mid = (zoneHigh + zoneLow) / 2;
  if (!(mid > 0)) return null;

  if (params.requireRelativeBaseStructure) {
    // Optional strict shape gate: the pause must shift both extremes beyond
    // the preceding candle in the trend direction.
    const prev = candles[start - 1];
    if (direction === 'up') {
      if (!(zoneHigh > prev.high && zoneLow > prev.low)) return null;
    } else {
      if (!(zoneLow < prev.low && zoneHigh < prev.high)) return null;
    }
  }

  if (params.rejectImmediateWickThrough) {
    // Optional strict shape gate: the first post-base candle must not sweep
    // through the far edge before the impulse leaves.
    const next = candles[end + 1];
    if (direction === 'up') {
      if (next.low < zoneLow) return null;
    } else {
      if (next.high > zoneHigh) return null;
    }
  }

  // Structure extreme of the candles before the pause: the impulse must take
  // this out to count as "a big move", not a wiggle inside the range.
  const structStart = Math.max(0, start - params.structureLookback);
  let structHigh = -Infinity;
  let structLow = Infinity;
  for (let i = structStart; i < start; i++) {
    structHigh = Math.max(structHigh, candles[i].high);
    structLow = Math.min(structLow, candles[i].low);
  }

  // 1) Confirmation: within impulseWindow candles after the pause, a candle
  //    must close beyond the zone AND take out the structure extreme.
  const windowEnd = Math.min(end + params.impulseWindow, last);
  let confirmedAt = -1;

  for (let j = end + 1; j <= windowEnd; j++) {
    const cj = candles[j];
    if (direction === 'up') {
      if (cj.close < zoneLow) return null; // failed before confirming
      if (cj.close > zoneHigh && cj.high > structHigh) {
        confirmedAt = j;
        break;
      }
    } else {
      if (cj.close > zoneHigh) return null;
      if (cj.close < zoneLow && cj.low < structLow) {
        confirmedAt = j;
        break;
      }
    }
  }

  if (confirmedAt === -1) return null;

  // 2) Walk forward: track the impulse extreme (frozen at the first return),
  //    the first/last taps, and invalidation (close through the far side).
  let impulseExtreme = direction === 'up' ? -Infinity : Infinity;
  let firstTapIndex = -1;
  let lastTapIndex = -1;

  for (let j = end + 1; j <= last; j++) {
    const cj = candles[j];
    if (direction === 'up') {
      if (cj.close < zoneLow) return null; // broken
      const tapped = j > confirmedAt && cj.low <= zoneHigh;
      if (tapped) {
        if (firstTapIndex === -1) firstTapIndex = j;
        lastTapIndex = j;
      }
      // Extreme only counts up to the first return — after that it's a new leg
      if (firstTapIndex === -1 || j <= firstTapIndex) {
        impulseExtreme = Math.max(impulseExtreme, cj.high);
      }
    } else {
      if (cj.close > zoneHigh) return null;
      const tapped = j > confirmedAt && cj.high >= zoneLow;
      if (tapped) {
        if (firstTapIndex === -1) firstTapIndex = j;
        lastTapIndex = j;
      }
      if (firstTapIndex === -1 || j <= firstTapIndex) {
        impulseExtreme = Math.min(impulseExtreme, cj.low);
      }
    }
  }

  // 3) Separation: an immediate return to the zone means chop, not an impulse
  if (firstTapIndex !== -1 && firstTapIndex - end < params.minSeparation) return null;

  // 4) Impulse size: total move away before the first return
  const impulsePercent = direction === 'up'
    ? ((impulseExtreme - zoneHigh) / mid) * 100
    : ((zoneLow - impulseExtreme) / mid) * 100;
  if (impulsePercent < params.minImpulsePercent) return null;

  return {
    type: direction === 'up' ? 'support' : 'resistance',
    high: zoneHigh,
    low: zoneLow,
    createdAt: candles[end].timestamp,
    ageCandles: last - end,
    baseCandles: end - start + 1,
    impulsePercent: Math.round(impulsePercent * 100) / 100,
    impulseExtreme,
    status: firstTapIndex === -1 ? 'fresh' : 'tapped',
    firstTapAgeCandles: firstTapIndex !== -1 ? last - firstTapIndex : undefined,
    lastTapAgeCandles: lastTapIndex !== -1 ? last - lastTapIndex : undefined,
  };
}

/**
 * Evaluate a symbol's zones against the current price and return actionable
 * hits only:
 * - at_zone:     the first retrace into the zone is happening right now
 * - approaching: untouched zone with price within approachPercent of its edge
 * - recent_tap:  first touch happened within the last recentTapCandles candles
 * - new_zone:    zone formed within the last recentZoneCandles candles
 *
 * Zones whose first retrace happened longer ago are consumed — the tradable
 * event has passed — and are not reported.
 */
export function evaluateZones(
  candles: Candle[],
  currentPrice: number,
  params: ZoneScanParams = DEFAULT_ZONE_PARAMS,
): ZoneHit[] {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return [];
  const zones = detectZones(candles, params);
  const hits: ZoneHit[] = [];

  for (const zone of zones) {
    // Consumed: the retrace already happened, too long ago to trade now
    if (zone.firstTapAgeCandles !== undefined && zone.firstTapAgeCandles > params.recentTapCandles) {
      continue;
    }

    const insideZone = currentPrice >= zone.low && currentPrice <= zone.high;

    let distancePercent = 0;
    if (!insideZone) {
      if (zone.type === 'support' && currentPrice > zone.high) {
        distancePercent = ((currentPrice - zone.high) / currentPrice) * 100;
      } else if (zone.type === 'resistance' && currentPrice < zone.low) {
        distancePercent = ((zone.low - currentPrice) / currentPrice) * 100;
      } else {
        // Intra-candle beyond the far edge: about to break, not tradable
        continue;
      }
    }

    let signal: ZoneSignal | null = null;
    if (insideZone) {
      signal = 'at_zone';
    } else if (zone.status === 'tapped') {
      // Touched within the last recentTapCandles (older taps were filtered above)
      signal = 'recent_tap';
    } else if (distancePercent <= params.approachPercent) {
      signal = 'approaching';
    } else if (zone.ageCandles <= params.recentZoneCandles) {
      signal = 'new_zone';
    }

    if (!signal) continue;

    hits.push({
      zone,
      distancePercent: Math.round(distancePercent * 100) / 100,
      insideZone,
      signal,
    });
  }

  // Most actionable first
  const rank: Record<ZoneSignal, number> = { at_zone: 0, approaching: 1, recent_tap: 2, new_zone: 3 };
  hits.sort((a, b) => rank[a.signal] - rank[b.signal] || a.distancePercent - b.distancePercent);
  return hits;
}
