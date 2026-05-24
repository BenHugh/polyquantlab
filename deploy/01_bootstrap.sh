#!/usr/bin/env bash
# Bootstrap a fresh Hetzner Ubuntu 24.04 box for the PolyQuantLab backend.
# Idempotent — re-running is safe.
#
# Run on the VPS as root:
#   ssh root@<vps-ip> 'bash -s' < deploy/01_bootstrap.sh

set -euo pipefail

echo ">>> [1/7] System update"
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y

echo ">>> [2/7] Base packages"
apt-get install -y \
    ca-certificates curl gnupg lsb-release \
    git tmux htop ufw \
    python3-pip python3-venv \
    rsync zstd jq

echo ">>> [3/7] Docker"
if ! command -v docker &>/dev/null; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io \
                       docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

echo ">>> [4/7] Firewall (only allow SSH + API + healthcheck)"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp           # SSH
ufw allow 8000/tcp         # FastAPI (TODO: put behind Caddy / Cloudflare in prod)
ufw allow 8080/tcp         # /health
ufw --force enable

echo ">>> [5/7] Project user"
id -u app &>/dev/null || useradd -m -s /bin/bash app
usermod -aG docker app
mkdir -p /opt/stock
chown -R app:app /opt/stock

echo ">>> [6/7] Swap (8GB box benefits from 4GB swap when ClickHouse + Postgres run together)"
if [ ! -f /swapfile ]; then
    fallocate -l 4G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

echo ">>> [7/7] Done"
echo
echo "Box ready. Next:"
echo "  - From your laptop: ./deploy/02_sync.sh <vps-ip>"
echo "  - Then on the VPS:  cd /opt/stock && ./deploy/03_start.sh"
