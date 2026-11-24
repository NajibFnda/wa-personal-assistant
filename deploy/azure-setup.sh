#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/alarm-bot}"
PUBLIC_IP="${1:-}"

echo "========================================================"
echo "  Setup Server Azure Ubuntu untuk Personal Assistant"
echo "========================================================"

# 1. Set timezone ke WIB (Asia/Jakarta)
sudo timedatectl set-timezone Asia/Jakarta || true

# 2. Tambah 2GB swap agar VM B1s (1GB RAM) aman saat build better-sqlite3 & jalan 24/7
if ! swapon --show | grep -q '/swapfile'; then
  echo "[1/6] Membuat 2GB swap file..."
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  if ! grep -q '/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  fi
fi

# 3. Install build tools, curl, git, sqlite3
echo "[2/6] Menginstall dependensi sistem..."
sudo apt-get update -y
sudo apt-get install -y curl git build-essential python3 ca-certificates gnupg

# 4. Install Node.js 24 LTS (jika belum ada / versi < 22)
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
fi
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "[3/6] Menginstall Node.js 24 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "[3/6] Node.js $(node -v) sudah terpasang."
fi

# 5. Install PM2 secara global
if ! command -v pm2 >/dev/null 2>&1; then
  echo "[4/6] Menginstall PM2..."
  sudo npm install -g pm2
fi

# 6. Install dependensi project & jalankan via PM2
echo "[5/6] Menginstall package Node.js di $APP_DIR..."
mkdir -p "$APP_DIR/logs" "$APP_DIR/uploads/memori" "$APP_DIR/uploads/vault"
cd "$APP_DIR"
npm install --omit=dev

if pm2 describe personal-assistant >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi
pm2 save

# Aktifkan PM2 auto-start saat VM reboot
STARTUP_CMD=$(pm2 startup systemd -u "$USER" --hp "$HOME" 2>/dev/null | grep -E '^sudo ' | tail -n 1 || true)
if [ -n "$STARTUP_CMD" ]; then
  eval "$STARTUP_CMD" || true
  pm2 save
fi

# 7. Install & konfigurasi Caddy untuk HTTPS otomatis (gratis via sslip.io -> Web Push PWA langsung aktif!)
echo "[6/6] Mengkonfigurasi Caddy (HTTPS otomatis)..."
if ! command -v caddy >/dev/null 2>&1; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP=$(curl -4 -sS https://ifconfig.me || curl -4 -sS https://api.ipify.org || true)
fi

if [ -n "$PUBLIC_IP" ]; then
  DOMAIN="${PUBLIC_IP//./-}.sslip.io"
  sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
${DOMAIN} {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
EOF
  sudo systemctl enable caddy
  sudo systemctl restart caddy
  echo ""
  echo "========================================================"
  echo "  DEPLOY SELESAI! Bot Aktif 24 Jam di Azure"
  echo "  Dashboard HTTPS : https://${DOMAIN}"
  echo "  Cek log bot     : pm2 logs personal-assistant"
  echo "========================================================"
else
  echo ""
  echo "========================================================"
  echo "  DEPLOY SELESAI! Bot berjalan di port 3000 (PM2)"
  echo "  Cek log bot     : pm2 logs personal-assistant"
  echo "========================================================"
fi
