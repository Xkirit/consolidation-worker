import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_ZONE_PARAMS,
  detectZones,
  type Candle,
  type ZoneScanParams,
} from '../src/lib/consolidation-zone-service';
import { DEFAULT_CEX_ZONE_PARAMS } from '../src/lib/cex-consolidation-scanner';

function supportFixture(baseLow: number, nextLow: number): Candle[] {
  return [
    { timestamp: 1, open: 99, high: 101, low: 98, close: 100 },
    { timestamp: 2, open: 100, high: 103, low: 99, close: 102 },
    { timestamp: 3, open: 104, high: 105, low: baseLow, close: 103 },
    { timestamp: 4, open: 103, high: 111, low: nextLow, close: 110 },
    { timestamp: 5, open: 110, high: 112, low: 108, close: 111 },
    { timestamp: 6, open: 111, high: 113, low: 109, close: 112 },
    { timestamp: 7, open: 112, high: 113, low: 110, close: 111 },
  ];
}

const strictParams: ZoneScanParams = {
  ...DEFAULT_ZONE_PARAMS,
  lookback: 100,
  minImpulsePercent: 1,
  structureLookback: 2,
  minSeparation: 0,
  maxBaseCandles: 1,
};

const cexShapeParams: ZoneScanParams = {
  ...strictParams,
  requireRelativeBaseStructure: true,
  rejectImmediateWickThrough: false,
};

test('CEX defaults require prior-candle geometry and disable only the wick gate', () => {
  assert.equal(DEFAULT_CEX_ZONE_PARAMS.requireRelativeBaseStructure, true);
  assert.equal(DEFAULT_CEX_ZONE_PARAMS.rejectImmediateWickThrough, false);
  assert.equal(DEFAULT_CEX_ZONE_PARAMS.approachPercent, 4);
  assert.equal(DEFAULT_ZONE_PARAMS.approachPercent, 3);
  assert.equal(DEFAULT_CEX_ZONE_PARAMS.minImpulsePercent, 3);
  assert.equal(DEFAULT_ZONE_PARAMS.minImpulsePercent, 8);
  assert.equal(DEFAULT_CEX_ZONE_PARAMS.impulseWindow, DEFAULT_ZONE_PARAMS.impulseWindow);
  assert.equal(DEFAULT_CEX_ZONE_PARAMS.minSeparation, DEFAULT_ZONE_PARAMS.minSeparation);
});

test('CEX prior-candle geometry rejects a support base without a higher low', () => {
  const candles = supportFixture(98, 99);
  assert.equal(detectZones(candles, strictParams).some((zone) => zone.type === 'support'), false);
  assert.equal(
    detectZones(candles, cexShapeParams).some((zone) => zone.type === 'support'),
    false,
  );
});

test('CEX rules still accept an immediate wick below a valid support base', () => {
  const candles = supportFixture(100, 99);
  assert.equal(detectZones(candles, strictParams).some((zone) => zone.type === 'support'), false);
  assert.equal(
    detectZones(candles, cexShapeParams).some((zone) => zone.type === 'support'),
    true,
  );
});
