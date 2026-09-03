import type { CexConsolidationHit } from './cex-consolidation-scanner';

export interface NtfyConfig {
  serverUrl: string;
  topic: string;
  token?: string;
}

export interface ApproachingNotificationChunk {
  title: string;
  message: string;
  resultCount: number;
  rawSymbols: string[];
}

export interface NtfyListPublishResult {
  notificationsSent: number;
  deliveredRawSymbols: string[];
  errors: string[];
}

const MAX_MESSAGE_BYTES = 3600;

export function buildTradingViewUrl(rawSymbol: string): string {
  const url = new URL('https://www.tradingview.com/chart/');
  url.searchParams.set('symbol', `BINANCE:${rawSymbol}.P`);
  return url.toString();
}

function messageBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function formatPrice(value: number): string {
  if (value >= 1000) {
    return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  }
  if (value >= 1) {
    return `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
  }
  return `$${value.toPrecision(5)}`;
}

/**
 * Build complete-list notifications. The normal case fits in one message;
 * unusually large result sets are split without dropping any approaching hit.
 */
export function buildApproachingNotificationChunks(
  hits: CexConsolidationHit[],
  _scanTimestamp = new Date(),
): ApproachingNotificationChunk[] {
  if (hits.length === 0) return [];

  const sorted = [...hits].sort(
    (a, b) =>
      a.distancePercent - b.distancePercent ||
      a.rawSymbol.localeCompare(b.rawSymbol),
  );
  const chunks: Array<{ lines: string[]; hits: CexConsolidationHit[] }> = [];
  let currentLines: string[] = [];
  let currentHits: CexConsolidationHit[] = [];

  for (const hit of sorted) {
    const line =
      `${hit.symbol} · nearing ${hit.zoneType.toUpperCase()} · ${hit.distancePercent.toFixed(2)}% away` +
      ` · price ${formatPrice(hit.price)} · zone ${formatPrice(hit.zoneLow)}-${formatPrice(hit.zoneHigh)}` +
      ` · impulse ${hit.impulsePercent.toFixed(2)}% · [TradingView](${buildTradingViewUrl(hit.rawSymbol)})`;
    const candidate = [...currentLines, line].join('\n');

    if (currentLines.length > 0 && messageBytes(candidate) > MAX_MESSAGE_BYTES) {
      chunks.push({ lines: currentLines, hits: currentHits });
      currentLines = [line];
      currentHits = [hit];
    } else {
      currentLines.push(line);
      currentHits.push(hit);
    }
  }

  if (currentLines.length > 0) {
    chunks.push({ lines: currentLines, hits: currentHits });
  }

  return chunks.map((chunk) => ({
    title: [...new Set(chunk.hits.map((hit) => hit.symbol))].join(', '),
    message: chunk.lines.join('\n'),
    resultCount: chunk.lines.length,
    rawSymbols: [...new Set(chunk.hits.map((hit) => hit.rawSymbol))],
  }));
}

export async function publishApproachingNtfyList(
  hits: CexConsolidationHit[],
  ntfy: NtfyConfig,
  scanTimestamp = new Date(),
): Promise<NtfyListPublishResult> {
  const chunks = buildApproachingNotificationChunks(hits, scanTimestamp);
  const errors: string[] = [];
  const deliveredRawSymbols: string[] = [];
  let notificationsSent = 0;

  for (const [index, chunk] of chunks.entries()) {
    const headers: Record<string, string> = {
      'Content-Type': 'text/markdown; charset=utf-8',
      Title: chunk.title,
      Priority: 'high',
      Tags: 'chart_with_upwards_trend',
      Markdown: 'yes',
    };

    if (ntfy.token) {
      headers.Authorization = `Bearer ${ntfy.token}`;
    }

    try {
      const response = await fetch(
        `${ntfy.serverUrl}/${encodeURIComponent(ntfy.topic)}`,
        {
          method: 'POST',
          headers,
          body: chunk.message,
        },
      );

      if (!response.ok) {
        const responseBody = (await response.text()).slice(0, 300);
        throw new Error(
          `HTTP ${response.status}${responseBody ? `: ${responseBody}` : ''}`,
        );
      }

      notificationsSent++;
      deliveredRawSymbols.push(...chunk.rawSymbols);
    } catch (error) {
      errors.push(
        `list ${index + 1}/${chunks.length}: ${
          error instanceof Error ? error.message : 'unknown notification error'
        }`,
      );
    }
  }

  return {
    notificationsSent,
    deliveredRawSymbols: [...new Set(deliveredRawSymbols)],
    errors,
  };
}
