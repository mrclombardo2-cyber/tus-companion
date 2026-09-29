TUS Companion v11 -> v12 patch

Copy/overwrite these files into the root of your existing project.
Do NOT delete your existing backend/data, backend/.tus-session, backend/.tus-browser-profile,
backend/.venv, backend/secrets or config.ps1.

After copying:
  1. Stop the running server with Ctrl+C.
  2. Start again with .\run.ps1
  3. Hard-refresh once (Ctrl+F5) so the v12 service-worker cache is used.
  4. Open http://127.0.0.1:8000/health and confirm interval_seconds is 300.
