#!/usr/bin/env bash
# Install systemd units that run the collector + API under user `app`.
# Must be run as root (called from 03_start.sh).

set -euo pipefail

cat > /etc/systemd/system/stock-collector.service <<'UNIT'
[Unit]
Description=Polymarket crypto Up/Down data collector
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=app
Group=app
WorkingDirectory=/opt/stock
ExecStart=/opt/stock/.venv/bin/python -m collector.main
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
# Don't restart in a tight loop forever
StartLimitIntervalSec=300
StartLimitBurst=10

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/stock-api.service <<'UNIT'
[Unit]
Description=Polymarket backtest REST API
After=docker.service network-online.target stock-collector.service
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=app
Group=app
WorkingDirectory=/opt/stock
ExecStart=/opt/stock/.venv/bin/uvicorn api.main:app --host 0.0.0.0 --port 8000 --workers 2
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable stock-collector stock-api
systemctl restart stock-collector stock-api
sleep 3
systemctl is-active stock-collector
systemctl is-active stock-api
echo "Services installed and started."
