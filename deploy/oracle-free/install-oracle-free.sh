#!/usr/bin/env bash
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
  echo "Run with sudo: sudo bash deploy/oracle-free/install-oracle-free.sh"
  exit 1
fi

PROJECT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_ROOT=/opt/tus-companion
APP_ROOT="$INSTALL_ROOT/app"
SERVICE_USER=tuscompanion

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer targets Ubuntu/Debian."
  exit 1
fi

read -rp "DuckDNS subdomain (without .duckdns.org): " DUCKDNS_DOMAIN
if [ -z "$DUCKDNS_DOMAIN" ]; then echo "DuckDNS subdomain is required."; exit 1; fi
read -rsp "DuckDNS token: " DUCKDNS_TOKEN; echo
if [ -z "$DUCKDNS_TOKEN" ]; then echo "DuckDNS token is required."; exit 1; fi
read -rp "Operator/contact name shown in Privacy/Terms: " OPERATOR_NAME
read -rp "Contact email: " CONTACT_EMAIL
if [ -z "$CONTACT_EMAIL" ]; then echo "Contact email is required for public release."; exit 1; fi

HOSTNAME_FQDN="${DUCKDNS_DOMAIN}.duckdns.org"
ADMIN_TOKEN="$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
)"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3 python3-venv python3-pip curl ca-certificates gnupg rsync ufw

# Install Caddy from its official Debian/Ubuntu repository if not already present.
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  chmod o+r /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$INSTALL_ROOT" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
mkdir -p "$INSTALL_ROOT" "$APP_ROOT" "$INSTALL_ROOT/playwright-browsers"
rsync -a --delete \
  --exclude '.venv' --exclude '.pytest_cache' --exclude '.tus-browser-profile' --exclude '.tus-session' \
  --exclude 'backend/data' --exclude 'backend/secrets' \
  "$PROJECT_SRC/" "$APP_ROOT/"
mkdir -p "$APP_ROOT/backend/data" "$APP_ROOT/backend/secrets" "$APP_ROOT/backend/.tus-session" "$APP_ROOT/backend/.tus-browser-profile"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_ROOT"

python3 -m venv "$INSTALL_ROOT/venv"
"$INSTALL_ROOT/venv/bin/pip" install --upgrade pip wheel
"$INSTALL_ROOT/venv/bin/pip" install -r "$APP_ROOT/backend/requirements.txt"
# System libraries need root; browser download is owned by the service account.
"$INSTALL_ROOT/venv/bin/python" -m playwright install-deps chromium
sudo -u "$SERVICE_USER" env PLAYWRIGHT_BROWSERS_PATH="$INSTALL_ROOT/playwright-browsers" \
  "$INSTALL_ROOT/venv/bin/python" -m playwright install chromium

cat > /etc/tus-companion.env <<ENV
TUS_SYNC_INTERVAL_SECONDS=300
TUS_SCHEDULER_ENABLED=1
TUS_CATALOG_REFRESH_HOURS=24
TUS_INTEREST_TTL_DAYS=30
TUS_PUSH_WORKERS=16
TUS_ADMIN_TOKEN=${ADMIN_TOKEN}
TUS_OPERATOR_NAME=${OPERATOR_NAME:-Independent TUS Companion project}
TUS_CONTACT_EMAIL=${CONTACT_EMAIL}
TUS_LEGAL_VERSION=2026-09-29
TUS_APP_VERSION=1.6.0
VAPID_SUBJECT=mailto:${CONTACT_EMAIL}
ENV
chmod 600 /etc/tus-companion.env

# Generate VAPID only once.
if [ ! -s "$APP_ROOT/backend/secrets/vapid_private.pem" ]; then
  sudo -u "$SERVICE_USER" env \
    PLAYWRIGHT_BROWSERS_PATH="$INSTALL_ROOT/playwright-browsers" \
    bash -lc "cd '$APP_ROOT/backend' && '$INSTALL_ROOT/venv/bin/python' -m app.cli vapid-generate"
fi

cat > /etc/tus-companion-duckdns.env <<ENV
DUCKDNS_DOMAIN=${DUCKDNS_DOMAIN}
DUCKDNS_TOKEN=${DUCKDNS_TOKEN}
ENV
chmod 600 /etc/tus-companion-duckdns.env
install -m 755 "$APP_ROOT/deploy/oracle-free/duckdns-update.sh" /usr/local/bin/tus-duckdns-update
install -m 644 "$APP_ROOT/deploy/oracle-free/duckdns-update.service" /etc/systemd/system/tus-duckdns-update.service
install -m 644 "$APP_ROOT/deploy/oracle-free/duckdns-update.timer" /etc/systemd/system/tus-duckdns-update.timer

cat > /etc/caddy/Caddyfile <<CADDY
${HOSTNAME_FQDN} {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8000
    header {
        Strict-Transport-Security "max-age=31536000"
    }
}
CADDY

install -m 644 "$APP_ROOT/deploy/oracle-free/tus-companion.service" /etc/systemd/system/tus-companion.service
systemctl daemon-reload
systemctl enable tus-duckdns-update.timer tus-companion caddy
systemctl restart tus-duckdns-update.timer
/usr/local/bin/tus-duckdns-update || true
systemctl restart tus-companion
systemctl restart caddy

# OS firewall. OCI's cloud Security List / NSG must ALSO allow TCP 80 and 443.
ufw allow OpenSSH >/dev/null || true
ufw allow 80/tcp >/dev/null || true
ufw allow 443/tcp >/dev/null || true
ufw --force enable >/dev/null || true

sleep 2
printf '\nLocal health:\n'
curl -fsS http://127.0.0.1:8000/health || true
printf '\n\nInstalled. Public hostname: https://%s\n' "$HOSTNAME_FQDN"
printf 'IMPORTANT: upload a valid TUS session before timetable sync will work.\n'
printf 'Admin token saved in /etc/tus-companion.env (root only).\n'
