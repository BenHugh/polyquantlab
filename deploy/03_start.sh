#!/usr/bin/env bash
# Bring everything up on the VPS for the first time.
# Run as user `app` (or via `sudo -u app`) inside /opt/stock.

set -euo pipefail

cd /opt/stock

echo ">>> [1/6] .env"
[ -f .env ] || cp .env.example .env

echo ">>> [2/6] Docker compose up"
docker compose up -d
echo "    waiting 15s for containers to become healthy..."
sleep 15
docker compose ps

echo ">>> [3/6] Restore data from laptop dump (if present)"
if [ -f /opt/stock/data/dump.tar.zst ]; then
    rm -rf /tmp/dump
    mkdir -p /tmp/dump
    zstd -d -c /opt/stock/data/dump.tar.zst | tar -C /tmp -xf -

    # ClickHouse restore
    for f in /tmp/dump/ch_*.native; do
        [ -s "$f" ] || continue
        tbl="$(basename "$f" .native)"
        tbl="${tbl#ch_}"
        echo "    restoring clickhouse:$tbl"
        docker exec -i stock_clickhouse clickhouse-client \
            --user stock --password changeme --database stock \
            --query "INSERT INTO $tbl FORMAT Native" < "$f"
    done

    # Postgres restore
    if [ -s /tmp/dump/pg_full.sql ]; then
        echo "    restoring postgres metadata"
        docker exec -i stock_postgres psql -U stock -d stock < /tmp/dump/pg_full.sql > /dev/null 2>&1 || true
    fi

    rm -rf /tmp/dump
else
    echo "    (no dump file found, starting fresh)"
fi

echo ">>> [4/6] Python venv + deps"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -e ".[api]"

echo ">>> [5/6] Apply candle migration to fresh ClickHouse (idempotent)"
docker exec -i stock_clickhouse clickhouse-client \
    --user stock --password changeme --multiquery \
    < db/migrations/001_candles.sql || true

echo ">>> [6/6] Install + start systemd services"
sudo bash deploy/04_install_services.sh

echo
echo "Done. Live status:"
sudo systemctl status stock-collector --no-pager | head -10
echo
sudo systemctl status stock-api --no-pager | head -10
echo
echo "Tail collector logs:  journalctl -u stock-collector -f"
echo "Tail API logs:        journalctl -u stock-api -f"
echo "Healthcheck:          curl http://localhost:8000/health"
