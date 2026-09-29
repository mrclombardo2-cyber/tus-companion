#!/usr/bin/env bash
set -euo pipefail
source /etc/tus-companion-duckdns.env
curl -fsS "https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&ip=" >/dev/null
