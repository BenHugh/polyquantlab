#!/usr/bin/env bash
# Install + start the ARQ backtest worker as a systemd service.
# Call from 03_start.sh after install, or run manually after a code update.

set -euo pipefail

cat > /etc/systemd/system/stock-backtest-worker.service <<'UNIT'
[Unit]
Description=Backtest queue worker (ARQ)
After=docker.service network-online.target stock-api.service
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=app
Group=app
WorkingDirectory=/opt/stock
ExecStart=/opt/stock/.venv/bin/arq worker.backtest_worker.WorkerSettings
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable stock-backtest-worker
systemctl restart stock-backtest-worker
sleep 3
systemctl is-active stock-backtest-worker
echo "Backtest worker installed and started."
