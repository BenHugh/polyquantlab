#!/usr/bin/env bash
# Install / refresh the systemd unit for the paper-trader worker.
# Run on the VPS as root after `git pull`:
#     bash /opt/stock/deploy/06_install_paper_trader.sh
#
# Idempotent — re-running just rewrites the unit and restarts.
set -euo pipefail

UNIT_PATH=/etc/systemd/system/stock-paper-trader.service

cat > "$UNIT_PATH" <<'UNIT'
[Unit]
Description=PolyQuantLab paper-trading worker
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=app
WorkingDirectory=/opt/stock
EnvironmentFile=/opt/stock/.env
ExecStart=/opt/stock/.venv/bin/python -m worker.paper_trader
Restart=always
RestartSec=5

# Resource hygiene — paper trader is light (one polling loop)
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable stock-paper-trader.service
systemctl restart stock-paper-trader.service
sleep 2
systemctl is-active stock-paper-trader.service
journalctl -u stock-paper-trader.service -n 20 --no-pager
