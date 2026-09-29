# Upgrade v12 → v13 — free cloud deployment

- Adds a zero-cost deployment target for Oracle Cloud Always Free.
- Adds free DuckDNS hostname + automatic Caddy HTTPS.
- Adds systemd service for 24/7 FastAPI/scheduler operation independent of a personal PC.
- Adds DuckDNS update timer.
- Adds Windows helper to transfer the authenticated TUS Playwright storage state securely over SSH.
- Keeps a single Uvicorn worker so the in-process scheduler is not duplicated.
- PWA cache bumped to v13.
