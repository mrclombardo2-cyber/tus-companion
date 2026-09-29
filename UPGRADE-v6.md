# Upgrade to v6

v6 is a frontend/release patch over the working v5 central collector. It does not require rebuilding the TUS session, database, virtual environment or VAPID keys.

## Changes

- Directions no longer assume the previous classroom.
- Every Directions tap asks for the departure point.
- A device-local **usual starting point** can be saved (usual entrance, bus-stop-side entrance, room, Mappedin named location, Mappedin deep link, or coordinate + floor ID).
- If a previous classroom exists it is offered as a choice, not forced.
- Other timetable rooms can be selected immediately as route origins.
- Destination-only Mappedin remains available when the user wants to choose the start manually there.
- Saved route origins are local-only; they are never stored by the TUS Companion backend.
- Removed the green sync dot. `Updated …` now sits cleanly in the top-right header.
- Added `share-online.ps1` for an immediate HTTPS test link and stable Cloudflare Tunnel support.
- Service-worker cache bumped to v6.

## Upgrade

1. Stop `run.ps1` with `Ctrl+C`.
2. Copy the v5 → v6 patch over the existing project and replace files when Windows asks.
3. Do **not** delete `backend/.tus-session`, `backend/.tus-browser-profile`, `backend/data`, `backend/.venv`, `backend/secrets`, or `config.ps1`.
4. Restart `run.ps1`.
5. Force-refresh once (`Ctrl+F5`) so the v6 PWA assets replace the cached v5 files.

## Put it online for testing

```powershell
.\share-online.ps1
```

Copy the `https://...trycloudflare.com` URL printed by Cloudflare. See `docs/PUBLISH.md` for a stable hostname.
