# Upgrade to v5 without losing your working TUS session

1. Stop `run.ps1` with `Ctrl+C`.
2. Extract the v4-to-v5 patch.
3. Copy its contents over your existing project folder and choose **Replace all**.
4. Do **not** delete `backend/.tus-session`, `backend/.tus-browser-profile`, `backend/data`, `backend/.venv` or `backend/secrets`.
5. Start again with `run.ps1`.
6. In Chrome/Edge press `Ctrl+F5` once so the v5 service worker/assets replace the old cache.
7. Open Settings and test: time format, Terms, Privacy, Install guidance and notifications.

If notifications had already been enabled, v5 keeps the existing VAPID keys. Do not rerun a command that deliberately regenerates them unless you are prepared to resubscribe devices.
