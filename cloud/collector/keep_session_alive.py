from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.collector.playwright_collector import SESSION_STATE, status  # noqa: E402

AAD = b"tus-companion-source-session-v1"


def b64decode_any(value: str) -> bytes:
    value = value.strip()
    value += "=" * ((4 - len(value) % 4) % 4)
    try:
        return base64.urlsafe_b64decode(value.encode())
    except Exception:
        return base64.b64decode(value.encode())


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing-env:{name}")
    return value


def cloud_request(client: httpx.Client, method: str, base: str, token: str, path: str, **kwargs) -> dict:
    headers = {"x-admin-token": token, "user-agent": "tus-companion-session-keeper/1.0"}
    headers.update(kwargs.pop("headers", {}))
    response = client.request(method, base.rstrip("/") + path, headers=headers, **kwargs)
    if response.status_code >= 400:
        raise RuntimeError(f"cloud-api:{method}:{path}:{response.status_code}:{response.text[:300]}")
    return response.json() if response.content else {}


def restore_cloud_session(client: httpx.Client, base: str, token: str, key: bytes) -> None:
    payload = cloud_request(client, "GET", base, token, "/api/admin/source-session")
    ciphertext = str(payload.get("ciphertext") or "")
    nonce = str(payload.get("nonce") or "")
    if not ciphertext or not nonce:
        raise RuntimeError("source-session-not-configured")

    plaintext = AESGCM(key).decrypt(b64decode_any(nonce), b64decode_any(ciphertext), AAD)
    parsed = json.loads(plaintext.decode("utf-8"))
    if not isinstance(parsed, dict) or not isinstance(parsed.get("cookies"), list):
        raise RuntimeError("source-session-invalid-json")

    SESSION_STATE.parent.mkdir(parents=True, exist_ok=True)
    SESSION_STATE.write_bytes(plaintext)


def upload_cloud_session(client: httpx.Client, base: str, token: str, key: bytes) -> None:
    if not SESSION_STATE.exists():
        raise RuntimeError("local-session-missing-after-keepalive")
    plaintext = SESSION_STATE.read_bytes()
    json.loads(plaintext.decode("utf-8"))
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, AAD)
    cloud_request(
        client,
        "PUT",
        base,
        token,
        "/api/admin/source-session",
        json={"ciphertext": b64url(ciphertext), "nonce": b64url(nonce)},
    )


def main() -> int:
    base = require_env("CLOUD_API_URL").rstrip("/")
    token = require_env("CLOUD_ADMIN_TOKEN")
    key = b64decode_any(require_env("SESSION_CIPHER_KEY_B64"))
    if len(key) != 32:
        raise RuntimeError("SESSION_CIPHER_KEY_B64 must decode to 32 bytes")

    os.environ["TUS_EPHEMERAL_BROWSER"] = "1"

    with httpx.Client(timeout=httpx.Timeout(45.0, connect=15.0), follow_redirects=True) as client:
        health_before = client.get(base + "/health", params={"keeper": os.getpid()}).json()
        source_error_before = (health_before.get("collector") or {}).get("source_session_error")

        restore_cloud_session(client, base, token, key)
        ok = status()
        if not ok:
            print("[session-keeper] silent renewal failed; interactive Microsoft/MFA may be required")
            return 2

        upload_cloud_session(client, base, token, key)
        print("[session-keeper] TUS/Microsoft session renewed and re-uploaded")

        if source_error_before:
            cloud_request(client, "POST", base, token, "/api/admin/run-catalog", json={})
            print("[session-keeper] recovery verification queued")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
