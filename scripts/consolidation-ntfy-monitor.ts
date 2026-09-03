import { closeSync, openSync } from 'node:fs';
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { config } from 'dotenv';
import { scanCexConsolidation } from '../src/lib/cex-consolidation-scanner';
import {
  DEFAULT_ALERT_COOLDOWN_HOURS,
  alertCooldownMs,
  createEmptyAlertCache,
  pruneExpiredAlertCache,
  recordDeliveredCoins,
  selectUncachedApproachingCoins,
  type ConsolidationAlertCache,
} from '../src/lib/consolidation-alert-cache';
import {
  publishApproachingNtfyList,
  type NtfyConfig,
} from '../src/lib/consolidation-ntfy-service';

const projectRoot = resolve(import.meta.dirname, '..');
config({
  path: [resolve(projectRoot, '.env.local'), resolve(projectRoot, '.env')],
  quiet: true,
});

const lockPath = resolve(projectRoot, 'data/consolidation-ntfy-monitor.lock');
const cachePath = resolve(
  process.env.CONSOLIDATION_ALERT_CACHE_PATH ||
    resolve(projectRoot, 'data/consolidation-ntfy-cache.json'),
);
const dryRun = process.argv.includes('--dry-run');
const staleLockMs = 60 * 60 * 1000;
const configuredCooldownHours = Number.parseFloat(
  process.env.CONSOLIDATION_ALERT_COOLDOWN_HOURS || '',
);
const cooldownHours = Number.isFinite(configuredCooldownHours)
  ? Math.min(168, Math.max(1, configuredCooldownHours))
  : DEFAULT_ALERT_COOLDOWN_HOURS;
const cooldownMs = alertCooldownMs(cooldownHours);

function getNtfyConfig(): NtfyConfig | null {
  const topic = process.env.NTFY_TOPIC?.trim();
  if (!topic) {
    if (dryRun) return null;
    throw new Error(
      'NTFY_TOPIC is missing. Add it to .env.local before enabling notifications.',
    );
  }

  const serverUrl = (process.env.NTFY_SERVER_URL || 'https://ntfy.sh').replace(
    /\/+$/,
    '',
  );
  const parsedServer = new URL(serverUrl);
  if (parsedServer.protocol !== 'https:' && parsedServer.protocol !== 'http:') {
    throw new Error('NTFY_SERVER_URL must use http or https');
  }

  return {
    serverUrl,
    topic,
    token: process.env.NTFY_TOKEN?.trim() || undefined,
  };
}

async function acquireLock(): Promise<number> {
  await mkdir(dirname(lockPath), { recursive: true });

  try {
    return openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

    const lockStats = await stat(lockPath);
    if (Date.now() - lockStats.mtimeMs <= staleLockMs) {
      throw new Error('A consolidation notification scan is already running');
    }

    await unlink(lockPath);
    return openSync(lockPath, 'wx', 0o600);
  }
}

async function loadAlertCache(): Promise<ConsolidationAlertCache> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, 'utf8'));
    if (
      parsed?.version === 1 &&
      parsed.coins &&
      typeof parsed.coins === 'object'
    ) {
      return parsed as ConsolidationAlertCache;
    }
    throw new Error('cache schema is invalid');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return createEmptyAlertCache();
    }
    throw new Error(
      `Could not read alert cache: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }
}

async function saveAlertCache(cache: ConsolidationAlertCache): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, cachePath);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const ntfy = getNtfyConfig();
  const lockDescriptor = await acquireLock();

  try {
    console.log(
      `[${new Date().toISOString()}] Starting 1D consolidation scan (lookback 1000, dryRun=${dryRun})`,
    );

    const scan = await scanCexConsolidation({}, { maxHitsPerSymbol: Infinity });
    const hits = [...scan.support, ...scan.resistance];
    const approaching = hits
      .filter((hit) => hit.signal === 'approaching')
      .sort((a, b) => a.distancePercent - b.distancePercent);
    const uniqueApproachingCoins = new Set(
      approaching.map((hit) => hit.rawSymbol),
    ).size;
    const cache = await loadAlertCache();
    const now = Date.now();
    pruneExpiredAlertCache(cache, now, cooldownMs);
    const eligible = selectUncachedApproachingCoins(
      approaching,
      cache,
      now,
      cooldownMs,
    );
    const cachedCoins = uniqueApproachingCoins - eligible.length;
    let notificationsSent = 0;
    let notificationErrors: string[] = [];

    if (dryRun) {
      for (const hit of eligible) {
        console.log(
          `[dry-run] new ${hit.rawSymbol} nearing ${hit.zoneType}: ${hit.distancePercent.toFixed(2)}%`,
        );
      }
    } else if (eligible.length > 0) {
      if (!ntfy) throw new Error('NTFY configuration unexpectedly missing');
      const delivery = await publishApproachingNtfyList(
        eligible,
        ntfy,
        new Date(scan.timestamp),
      );
      notificationsSent = delivery.notificationsSent;
      notificationErrors = delivery.errors;
      recordDeliveredCoins(cache, delivery.deliveredRawSymbols, now);

      console.log(
        `Published new approaching coins: ${delivery.deliveredRawSymbols.length} coin(s), ${notificationsSent} NTFY message(s)`,
      );
    }

    if (!dryRun) {
      await saveAlertCache(cache);
    }

    console.log(
      JSON.stringify({
        finishedAt: new Date().toISOString(),
        durationSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
        totalSymbols: scan.totalSymbols,
        totalScanned: scan.totalScanned,
        scanErrors: scan.errors.length,
        supportHits: scan.support.length,
        resistanceHits: scan.resistance.length,
        approachingResults: approaching.length,
        approachingCoins: uniqueApproachingCoins,
        eligibleCoins: eligible.length,
        cachedCoins,
        cooldownHours,
        notificationsSent,
        notificationErrors: notificationErrors.length,
        dryRun,
      }),
    );

    if (scan.errors.length > 0) {
      console.error(`Scan completed with ${scan.errors.length} symbol errors:`);
      console.error(scan.errors.join('\n'));
      process.exitCode = 2;
    }
    if (notificationErrors.length > 0) {
      console.error(notificationErrors.join('\n'));
      process.exitCode = 2;
    }
  } finally {
    closeSync(lockDescriptor);
    await unlink(lockPath).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(
    `[${new Date().toISOString()}] Consolidation monitor failed: ${
      error instanceof Error ? error.message : error
    }`,
  );
  process.exitCode = 1;
});
