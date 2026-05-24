# Deploying to a Hetzner CPX32

One-shot path from a fresh box to a running collector + API. Total time
~10 minutes including the rsync transfer.

## Prerequisites

- A CPX32 (or larger) Ubuntu 24.04 instance, IP known. Hetzner location should
  be Nuremberg / Falkenstein / Helsinki (EU), or Ashburn (US). **Not Asia**
  (Binance futures geo-blocked from JP/SG networks).
- Your SSH key uploaded to the box during creation (so `ssh root@<ip>` works
  with no password prompt).
- Local `stock_clickhouse` / `stock_postgres` containers running with the
  data you've collected so far (so it can be migrated forward, not lost).

## One-time setup

```bash
# Replace <ip> with your VPS IPv4.
IP=<ip>

# 1. Bootstrap the box (root, ~3 min: apt, Docker, ufw, swap, app user)
ssh root@$IP 'bash -s' < deploy/01_bootstrap.sh

# 2. Stop local collector, dump CH+PG, rsync to /opt/stock on VPS (~2-5 min)
./deploy/02_sync.sh $IP

# 3. Bring everything up on the VPS (compose up, restore dumps, install
#    systemd services). Run as root on the box.
ssh root@$IP "sudo -u app bash /opt/stock/deploy/03_start.sh"
```

After step 3 the box is collecting 24/7 even when your laptop is off.

## Verifying

```bash
# Service health
ssh root@$IP "systemctl is-active stock-collector stock-api"

# Live collector log
ssh root@$IP "journalctl -u stock-collector -f"

# Data is landing
ssh root@$IP "docker exec stock_clickhouse clickhouse-client \
    --user stock --password changeme --database stock \
    --query 'SELECT count() FROM orderbook_snapshots WHERE ts > now() - INTERVAL 1 MINUTE'"

# API
curl http://$IP:8000/health
```

## Re-deploying after a code change

```bash
./deploy/02_sync.sh $IP
ssh root@$IP "systemctl restart stock-collector stock-api"
```

`02_sync.sh` re-runs the local data dump every time — that's fine for a few
weeks but later you should disable that block once VPS data depth exceeds
your laptop's.

## Daily ops cheatsheet

| Want to... | Command |
|---|---|
| Restart collector | `systemctl restart stock-collector` |
| See last 100 lines of log | `journalctl -u stock-collector -n 100 --no-pager` |
| ClickHouse shell | `docker exec -it stock_clickhouse clickhouse-client -u stock --password changeme -d stock` |
| Postgres shell | `docker exec -it stock_postgres psql -U stock -d stock` |
| Disk usage | `du -sh /opt/stock/data/*` |
| Free RAM | `free -h` |

## What's NOT in this script (deliberately deferred)

- TLS / HTTPS: API runs on plain :8000. Put it behind Caddy or Cloudflare
  before charging customers.
- Domain: bind `api.your-domain.com` to the VPS IP.
- Backups: ClickHouse + Postgres dumps to Hetzner Object Storage (€5/mo).
- Double-region redundancy: a second box in Falkenstein.
- Auto-update: `unattended-upgrades` is on by default in Ubuntu 24.04 but
  not for Docker — handle separately.
