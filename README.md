# Consolidation Worker

Standalone Binance Futures 1-day consolidation-zone scanner with NTFY alerts.
It is designed to run on a Linux VPS every five minutes without the Next.js
dashboard or Redis.

## Current scanner settings

- Market: active Binance USDT perpetual contracts
- Timeframe: `1d`
- Candle lookback: `1000`
- Minimum impulse: `3%`
- Approaching distance: `4%`
- Alerted signal: newly eligible `approaching` zones only
- Per-coin notification cooldown: `24` hours by default

The monitor stores only its per-coin notification cooldown in a local JSON
file. It does not persist scan results and does not use Redis.

## Local verification

Use Node.js 22 or newer. Node.js 24 LTS is recommended for the VPS.

```bash
npm ci
npm run check
npm run scan:dry-run
```

The dry run calls Binance but does not send NTFY messages or update the alert
cache.

## Upload to an Ubuntu or Debian VPS

From the folder containing `consolidation-worker`:

```bash
tar --exclude='consolidation-worker/node_modules' \
  --exclude='consolidation-worker/.env' \
  --exclude='consolidation-worker/.env.local' \
  --exclude='consolidation-worker/data/*' \
  -czf consolidation-worker.tar.gz consolidation-worker

scp consolidation-worker.tar.gz YOUR_USER@YOUR_VPS_IP:/tmp/
```

On the VPS, install it under `/opt`:

```bash
sudo useradd --system --home /opt/consolidation-worker --shell /usr/sbin/nologin consolidation || true
sudo mkdir -p /opt/consolidation-worker /var/lib/consolidation-worker
sudo tar -xzf /tmp/consolidation-worker.tar.gz \
  -C /opt/consolidation-worker \
  --strip-components=1
sudo chown -R consolidation:consolidation \
  /opt/consolidation-worker \
  /var/lib/consolidation-worker

cd /opt/consolidation-worker
sudo -u consolidation npm ci --omit=dev
```

Confirm that Node is at `/usr/bin/node`:

```bash
command -v node
```

If it prints a different path, replace `/usr/bin/node` in
`deploy/consolidation-worker.service` before installing that file.

## Configure NTFY

Create the protected environment file:

```bash
sudo cp deploy/consolidation-worker.env.example /etc/consolidation-worker.env
sudo chown root:consolidation /etc/consolidation-worker.env
sudo chmod 640 /etc/consolidation-worker.env
sudo nano /etc/consolidation-worker.env
```

At minimum, replace `NTFY_TOPIC` with the same private topic used by the NTFY
phone app. Add `NTFY_TOKEN` when the topic is protected. No inbound VPS port is
required; the worker makes outbound HTTPS requests to Binance and NTFY.

If the local cooldown should carry over to the VPS, copy the existing
`data/consolidation-ntfy-cache.json` to:

```text
/var/lib/consolidation-worker/ntfy-cache.json
```

Otherwise, every coin approaching during the first VPS scan is treated as new.

## Install the five-minute systemd timer

```bash
sudo cp deploy/consolidation-worker.service /etc/systemd/system/
sudo cp deploy/consolidation-worker.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now consolidation-worker.timer
```

Start one immediate scan and inspect it:

```bash
sudo systemctl start consolidation-worker.service
sudo systemctl status consolidation-worker.service
sudo journalctl -u consolidation-worker.service -n 100 --no-pager
```

Verify the schedule or follow future scans:

```bash
systemctl list-timers consolidation-worker.timer
sudo journalctl -u consolidation-worker.service -f
```

A completed service normally becomes `inactive (dead)` because it is a one-shot
scan. The timer remains active and launches the next scan at the next five-minute
boundary.

## Stop or resume

```bash
sudo systemctl disable --now consolidation-worker.timer
sudo systemctl enable --now consolidation-worker.timer
```

## Updating the worker

Stop the timer before replacing code, then reinstall production dependencies
and run the checks before resuming it:

```bash
sudo systemctl stop consolidation-worker.timer
cd /opt/consolidation-worker
sudo -u consolidation npm ci --omit=dev
sudo -u consolidation npm run scan:dry-run
sudo systemctl start consolidation-worker.timer
```
