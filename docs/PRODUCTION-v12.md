# Production deployment — v12

## Freshness model

The collector runs every 300 seconds, 24/7. There is no evening cut-off. Polling is per distinct active Student Group, not per student. A course becomes active when selected in the PWA or when it has an active push subscription. This keeps upstream load proportional to the number of distinct groups actually used.

## Capacity

For roughly 10–500 users on one deployment, the public API/static PWA workload is small. The main capacity constraint is the single authenticated Scientia session, because Student Groups must be fetched sequentially. Watch `/health`: `last_cycle_duration_seconds` should stay comfortably below `interval_seconds` (300). If the batch approaches five minutes, split the collector into more authorized source sessions/workers rather than increasing per-user polling.

## Test link

Run `./share-online.ps1` for a temporary HTTPS `trycloudflare.com` URL. This is for device/PWA/push testing only.

## Stable public URL

Use a dedicated always-on machine (or Windows VPS) for the collector, then create a remotely managed Cloudflare Tunnel and map a hostname such as `timetable.example.com` to `http://localhost:8000`. Put only the tunnel token in `config.ps1`, never in source control. Install cloudflared as a Windows service so the tunnel starts at boot.

The application itself should also start automatically at boot under the same Windows account that owns the Playwright/TUS session. Keep one Uvicorn application process because the scheduler is in-process; multiple Uvicorn workers would duplicate the source poller.

## Before public release

1. Set real operator/contact details and VAPID subject in `config.ps1`.
2. Use `TUS_SYNC_INTERVAL_SECONDS=300`.
3. Confirm `/health` shows cycles continuing through evening/night and cycle duration < 300s.
4. Test iPhone/Android install + push + Mappedin from the final HTTPS hostname.
5. Back up `backend/data`, `backend/secrets`, `.tus-session`, `.tus-browser-profile`, and `config.ps1` securely.
6. Do not publish those files.
