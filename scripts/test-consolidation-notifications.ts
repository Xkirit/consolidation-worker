import assert from 'node:assert/strict';
import test from 'node:test';
import type { CexConsolidationHit } from '../src/lib/cex-consolidation-scanner';
import {
  alertCooldownMs,
  createEmptyAlertCache,
  recordDeliveredCoins,
  selectUncachedApproachingCoins,
} from '../src/lib/consolidation-alert-cache';
import {
  buildApproachingNotificationChunks,
  buildTradingViewUrl,
  publishApproachingNtfyList,
} from '../src/lib/consolidation-ntfy-service';

function hit(
  symbol: string,
  distancePercent: number,
  zoneType: 'support' | 'resistance' = 'support',
): CexConsolidationHit {
  return {
    symbol,
    rawSymbol: `${symbol}USDT`,
    zoneType,
    signal: 'approaching',
    price: 100,
    priceChange24h: 0,
    volume: 1,
    zoneHigh: 98,
    zoneLow: 96,
    distancePercent,
    insideZone: false,
    zoneStatus: 'fresh',
    ageCandles: 10,
    impulsePercent: 12,
    createdAt: Date.UTC(2026, 6, 1),
  };
}

test('the notification contains every approaching result, nearest first', () => {
  const chunks = buildApproachingNotificationChunks(
    [hit('BTC', 2.5), hit('ETH', 1.2, 'resistance'), hit('SOL', 2)],
    new Date('2026-08-03T12:00:00.000Z'),
  );

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].resultCount, 3);
  assert.equal(chunks[0].title, 'ETH, SOL, BTC');
  assert.ok(chunks[0].message.indexOf('ETH ·') < chunks[0].message.indexOf('SOL ·'));
  assert.ok(chunks[0].message.indexOf('SOL ·') < chunks[0].message.indexOf('BTC ·'));
  assert.match(chunks[0].message, /ETH · nearing RESISTANCE · 1\.20% away/);
  assert.match(chunks[0].message, /price \$100/);
  assert.match(chunks[0].message, /zone \$96-\$98/);
  assert.match(chunks[0].message, /impulse 12\.00%/);
});

test('each enriched ticker has its Binance perpetual TradingView app link', () => {
  const [chunk] = buildApproachingNotificationChunks([
    hit('BTC', 1),
    hit('ETH', 2),
  ]);

  assert.match(chunk.message, /BINANCE%3ABTCUSDT\.P/);
  assert.match(chunk.message, /BINANCE%3AETHUSDT\.P/);
  assert.match(chunk.message, /BTC · nearing SUPPORT/);
  assert.match(chunk.message, /ETH · nearing SUPPORT/);
  assert.ok(chunk.message.includes(buildTradingViewUrl('BTCUSDT')));
  assert.ok(chunk.message.includes(buildTradingViewUrl('ETHUSDT')));
});

test('a delivered coin is cached for 24 hours while a different coin remains eligible', () => {
  const cache = createEmptyAlertCache();
  const now = Date.UTC(2026, 7, 10, 12);
  const cooldownMs = alertCooldownMs(24);
  const bitcoin = hit('BTC', 1);
  const ethereum = hit('ETH', 2, 'resistance');

  recordDeliveredCoins(cache, ['BTCUSDT'], now);

  assert.deepEqual(
    selectUncachedApproachingCoins(
      [bitcoin, ethereum],
      cache,
      now + cooldownMs - 1,
      cooldownMs,
    ).map((candidate) => candidate.rawSymbol),
    ['ETHUSDT'],
  );
  assert.deepEqual(
    selectUncachedApproachingCoins(
      [bitcoin],
      cache,
      now + cooldownMs,
      cooldownMs,
    ).map((candidate) => candidate.rawSymbol),
    ['BTCUSDT'],
  );
});

test('multiple zones for one coin produce one nearest cache candidate', () => {
  const selected = selectUncachedApproachingCoins(
    [hit('BTC', 2.5, 'resistance'), hit('BTC', 1.5, 'support')],
    createEmptyAlertCache(),
    Date.UTC(2026, 7, 10),
    alertCooldownMs(24),
  );

  assert.equal(selected.length, 1);
  assert.equal(selected[0].zoneType, 'support');
});

test('large result sets are split without dropping a coin', () => {
  const hits = Array.from({ length: 100 }, (_, index) =>
    hit(`COIN${index}`, index / 100),
  );
  const chunks = buildApproachingNotificationChunks(hits);

  assert.ok(chunks.length > 1);
  assert.equal(
    chunks.reduce((total, chunk) => total + chunk.resultCount, 0),
    hits.length,
  );
});

test('the publisher sends one complete multi-coin list in the normal case', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ headers: Headers; body: string }> = [];

  globalThis.fetch = (async (_input, init) => {
    requests.push({
      headers: new Headers(init?.headers),
      body: String(init?.body),
    });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    const result = await publishApproachingNtfyList(
      [hit('BTC', 1), hit('ETH', 2, 'resistance')],
      { serverUrl: 'https://ntfy.example.com', topic: 'scanner-test' },
    );

    assert.deepEqual(result, {
      notificationsSent: 1,
      deliveredRawSymbols: ['BTCUSDT', 'ETHUSDT'],
      errors: [],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 1);
  assert.match(requests[0].body, /BTC · nearing SUPPORT/);
  assert.match(requests[0].body, /ETH · nearing RESISTANCE/);
  assert.equal(requests[0].headers.get('Markdown'), 'yes');
  assert.equal(requests[0].headers.get('Click'), null);
});
