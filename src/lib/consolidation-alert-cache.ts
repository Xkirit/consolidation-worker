import type { CexConsolidationHit } from './cex-consolidation-scanner';

export const DEFAULT_ALERT_COOLDOWN_HOURS = 24;

export interface CoinAlertRecord {
  lastNotifiedAt: number;
}

export interface ConsolidationAlertCache {
  version: 1;
  coins: Record<string, CoinAlertRecord>;
}

export function createEmptyAlertCache(): ConsolidationAlertCache {
  return { version: 1, coins: {} };
}

export function alertCooldownMs(hours = DEFAULT_ALERT_COOLDOWN_HOURS): number {
  return Math.min(168, Math.max(1, hours)) * 60 * 60 * 1000;
}

/**
 * Select one nearest approaching result per coin and suppress coins delivered
 * inside the rolling cooldown window.
 */
export function selectUncachedApproachingCoins(
  hits: CexConsolidationHit[],
  cache: ConsolidationAlertCache,
  now: number,
  cooldownMs: number,
): CexConsolidationHit[] {
  const selected: CexConsolidationHit[] = [];
  const seenSymbols = new Set<string>();
  const sorted = [...hits].sort(
    (a, b) =>
      a.distancePercent - b.distancePercent ||
      a.rawSymbol.localeCompare(b.rawSymbol),
  );

  for (const hit of sorted) {
    if (seenSymbols.has(hit.rawSymbol)) continue;
    seenSymbols.add(hit.rawSymbol);

    const lastNotifiedAt = cache.coins[hit.rawSymbol]?.lastNotifiedAt ?? 0;
    if (now - lastNotifiedAt < cooldownMs) continue;
    selected.push(hit);
  }

  return selected;
}

export function recordDeliveredCoins(
  cache: ConsolidationAlertCache,
  rawSymbols: string[],
  now: number,
): void {
  for (const rawSymbol of new Set(rawSymbols)) {
    cache.coins[rawSymbol] = { lastNotifiedAt: now };
  }
}

export function pruneExpiredAlertCache(
  cache: ConsolidationAlertCache,
  now: number,
  cooldownMs: number,
): void {
  for (const [rawSymbol, record] of Object.entries(cache.coins)) {
    if (now - record.lastNotifiedAt >= cooldownMs) {
      delete cache.coins[rawSymbol];
    }
  }
}
