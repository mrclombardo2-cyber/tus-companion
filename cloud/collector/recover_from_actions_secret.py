"""One-time GitHub Actions recovery. Do not print or commit session credentials.

The Windows launcher submits the browser state as an encrypted GitHub Actions
repository secret (gh encrypts locally). This job converts that temporary secret
into the encrypted Cloudflare session and checks the source with the catalog sync.
The launcher deletes the temporary GitHub secret when the job completes.
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
STATE_FILE = BACKEND / ".tus-session" / "storage_state.json"


def main() -> int:
    encoded = os.environ.get("TUS_RECOVERY_STATE_B64", "").strip()
    if not encoded:
        print("Missing temporary session secret. Rerun the Windows recovery launcher.")
        return 1
    try:
        decoded = base64.b64decode(encoded, validate=True)
        if len(decoded) > 250_000:
            raise ValueError("browser state exceeds safe transfer size")
        state = json.loads(decoded.decode("utf-8"))
        if not isinstance(state, dict) or not isinstance(state.get("cookies"), list) or not state["cookies"]:
            raise ValueError("browser state has no authenticated cookies")
    except Exception as exc:
        print(f"Invalid recovery session state: {type(exc).__name__}")
        return 1

    STATE_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        STATE_FILE.write_bytes(decoded)
        if os.name != "nt":
            os.chmod(STATE_FILE, 0o600)
        # Existing cloud uploader AES-GCM encrypts the state, queues catalog sync,
        # and verifies a newly updated catalog before reporting recovery success.
        cmd = [sys.executable, str(ROOT / "cloud/collector/run_cloud_sync.py"), "--upload-local-session"]
        return subprocess.call(cmd, cwd=ROOT)
    finally:
        try:
            STATE_FILE.unlink(missing_ok=True)
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
