# Test report — v5

Executed in the build environment:

- Backend pytest suite: **12 passed**.
- Python compilation for modified backend modules: **passed**.
- Frontend `app.js` syntax (`node --check`): **passed**.
- Service worker syntax (`node --check`): **passed**.
- FastAPI TestClient `/health`: **HTTP 200**.
- Static PWA `/`: **HTTP 200**.
- `/manifest.webmanifest`: **HTTP 200**.
- `/api/meta`: **HTTP 200**.
- Security-header smoke test: **passed** (`nosniff` verified).
- Unknown Department/Group watch request: **rejected with HTTP 400**.
- VAPID P-256 key generation: **passed** (87-character URL-safe public key).
- Mocked Playwright mobile UI smoke: **passed** for onboarding, Today hero, current-class Week highlight/NOW badge, AM/PM preference, Terms/Privacy modal and install modal.

Not executable end-to-end from the build environment because they depend on external/account/device infrastructure:

- Live TUS/Microsoft session authentication.
- Live TUS batch polling after deployment.
- Delivery through Apple/Google/Mozilla Push providers to a real handset.
- iOS Home-Screen Web Push behavior.
- Android PWA installation UI on a real device.
- Exact room-name resolution across the full TUS Mappedin dataset.
- Arbitrary indoor GPS/floor/nearest-node positioning (requires map floor context and potentially licensed SDK/IPS capability).

The user's prior live test confirmed a real TUS sync returning **26 timetable events**. v5 keeps that collector/parser pipeline and adds the UX/security/notification work around it.
