#!/usr/bin/env bash
# Sync the project to the VPS + transfer the ClickHouse data we already
# collected on the laptop so the data clock doesn't reset.
#
# Usage:
#   ./deploy/02_sync.sh <vps-ip>

set -euo pipefail

VPS_IP="${1:?usage: $0 <vps-ip>}"
LOCAL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_ROOT=/opt/stock

echo ">>> [1/4] Stopping local collector so we can take a consistent dump"
[ -f "$LOCAL_ROOT/logs/collector.pid" ] && kill "$(cat "$LOCAL_ROOT/logs/collector.pid")" 2>/dev/null || true
[ -f "$LOCAL_ROOT/logs/api.pid" ]       && kill "$(cat "$LOCAL_ROOT/logs/api.pid")"       2>/dev/null || true
sleep 2

echo ">>> [2/4] Dumping local ClickHouse + Postgres data"
DUMP_DIR="$LOCAL_ROOT/data/dump"
mkdir -p "$DUMP_DIR"

# ClickHouse: export each table as Native format (fastest, preserves types).
for table in orderbook_snapshots trades underlying_prices collector_heartbeats \
             candles_5m_data candles_15m_data candles_1h_data \
             candles_4h_data candles_24h_data; do
    echo "    - clickhouse:$table"
    docker exec stock_clickhouse clickhouse-client \
        --user stock --password changeme --database stock \
        --query "SELECT * FROM $table FORMAT Native" \
        > "$DUMP_DIR/ch_${table}.native" 2>/dev/null || echo "      (table empty or missing, skipping)"
done

# Postgres: full dump (small, just metadata).
echo "    - postgres:full"
docker exec stock_postgres pg_dump -U stock -d stock --no-owner > "$DUMP_DIR/pg_full.sql"

# Compress dumps for transfer
echo ">>> [3/4] Compressing dump (zstd)"
tar -C "$LOCAL_ROOT/data" -cf - dump | zstd -3 -o "$LOCAL_ROOT/data/dump.tar.zst"
rm -rf "$DUMP_DIR"
DUMP_SIZE=$(du -h "$LOCAL_ROOT/data/dump.tar.zst" | cut -f1)
echo "    dump size: $DUMP_SIZE"

echo ">>> [4/4] Rsyncing project + dump to $VPS_IP"
# Sync project (exclude local-only artifacts)
rsync -avz --delete \
    --exclude '.venv*' \
    --exclude 'data/clickhouse' \
    --exclude 'data/postgres' \
    --exclude 'data/redis' \
    --exclude 'data/dump' \
    --exclude '__pycache__' \
    --exclude '.git' \
    --exclude 'logs' \
    -e "ssh -o StrictHostKeyChecking=accept-new" \
    "$LOCAL_ROOT/" "root@$VPS_IP:$REMOTE_ROOT/"

# Chown only project files — NOT data/, which contains container-owned
# files (clickhouse uid 101, postgres uid 70, redis uid 999). Touching
# those breaks the running databases.
ssh "root@$VPS_IP" "
    find $REMOTE_ROOT -mindepth 1 -maxdepth 1 ! -name data -exec chown -R app:app {} +
    chmod +x $REMOTE_ROOT/deploy/*.sh
"

echo
echo "Sync complete."
echo "Next (on VPS):"
echo "  ssh root@$VPS_IP"
echo "  sudo -u app bash /opt/stock/deploy/03_start.sh"
