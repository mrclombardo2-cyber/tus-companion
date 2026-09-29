#!/usr/bin/env bash
set -euo pipefail
if [ "${EUID}" -ne 0 ]; then echo "Run with sudo."; exit 1; fi
PROJECT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_ROOT=/opt/tus-companion/app
systemctl stop tus-companion
rsync -a --delete \
  --exclude '.venv' --exclude '.pytest_cache' --exclude '.tus-browser-profile' --exclude '.tus-session' \
  --exclude 'backend/data' --exclude 'backend/secrets' \
  "$PROJECT_SRC/" "$APP_ROOT/"
chown -R tuscompanion:tuscompanion /opt/tus-companion
/opt/tus-companion/venv/bin/pip install -r "$APP_ROOT/backend/requirements.txt"
systemctl start tus-companion
systemctl reload caddy || systemctl restart caddy
curl -fsS http://127.0.0.1:8000/health
