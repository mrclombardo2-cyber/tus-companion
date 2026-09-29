# Upgrade to v7

v7 simplifies the usual-start and route-origin UX. It is a frontend-only patch over v6 and does not replace the TUS session, database, virtual environment, VAPID keys or config.

## Changes
- One-tap usual-start presets: Main entrance, Bus stop, University Road entrance.
- Classroom start remains available with a simple dropdown.
- Advanced Mappedin place/link input is hidden under “Another place”.
- Directions now shows only: usual start, previous class, another classroom, or manual campus map.
- Service-worker cache bumped to v7.

After copying the patch, restart the server and force-refresh once with Ctrl+F5.
