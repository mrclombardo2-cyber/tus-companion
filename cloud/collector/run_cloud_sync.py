from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pywebpush import WebPushException, webpush

# Allow imports from backend/app while this file lives under cloud/collector.
ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.collector.playwright_collector import SESSION_STATE, fetch_many, scrape_catalog  # noqa: E402
from app.diff import diff_snapshots  # noqa: E402
from app.models import TimetableSnapshot  # noqa: E402
from app.parser import parse_textspreadsheet  # noqa: E402

AAD = b"tus-companion-source-session-v1"


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def b64decode_any(value: str) -> bytes:
    value = value.strip()
    value += "=" * ((4 - len(value) % 4) % 4)
    try:
        return base64.urlsafe_b64decode(value.encode())
    except Exception:
        return base64.b64decode(value.encode())


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class CloudApi:
    def __init__(self, base_url: str, admin_token: str):
        self.base_url = base_url.rstrip("/")
        self.headers = {"x-admin-token": admin_token, "user-agent": "tus-companion-github-sync/1.0"}
        self.client = httpx.Client(timeout=httpx.Timeout(90.0, connect=20.0), follow_redirects=True)

    def close(self):
        self.client.close()

    def _request(self, method: str, path: str, **kwargs):
        headers = dict(self.headers)
        headers.update(kwargs.pop("headers", {}))
        r = self.client.request(method, self.base_url + path, headers=headers, **kwargs)
        if r.status_code >= 400:
            raise RuntimeError(f"cloud-api {method} {path}: {r.status_code} {r.text[:400]}")
        return r.json() if r.content else None

    def sync_plan(self, preload_missing: bool = False, limit: int = 25):
        path = "/api/admin/sync-plan"
        if preload_missing:
            path += f"?preload=missing&limit={max(1, min(50, int(limit)))}"
        return self._request("GET", path)

    def upload_catalog(self, payload: dict):
        return self._request("POST", "/api/admin/catalog", json=payload)

    def upload_result(self, payload: dict):
        return self._request("POST", "/api/admin/result", json=payload)

    def subscriptions(self, group_id: str):
        from urllib.parse import quote
        return self._request("GET", "/api/admin/subscriptions/" + quote(group_id, safe=""))

    def deactivate(self, endpoint: str):
        return self._request("POST", "/api/admin/deactivate-subscription", json={"endpoint": endpoint})

    def get_source_session(self):
        return self._request("GET", "/api/admin/source-session")

    def put_source_session(self, ciphertext: str, nonce: str):
        return self._request("PUT", "/api/admin/source-session", json={"ciphertext": ciphertext, "nonce": nonce})

    def cycle(self, payload: dict):
        return self._request("POST", "/api/admin/cycle", json=payload)


def restore_source_session(api: CloudApi, cipher_key: bytes, bootstrap_b64: str | None) -> str:
    SESSION_STATE.parent.mkdir(parents=True, exist_ok=True)
    cloud = api.get_source_session()
    if cloud and cloud.get("ciphertext") and cloud.get("nonce"):
        try:
            aes = AESGCM(cipher_key)
            plaintext = aes.decrypt(
                b64decode_any(cloud["nonce"]),
                b64decode_any(cloud["ciphertext"]),
                AAD,
            )
            json.loads(plaintext.decode("utf-8"))
            SESSION_STATE.write_bytes(plaintext)
            return "encrypted-cloud-state"
        except Exception as exc:
            print(f"[session] encrypted cloud state could not be decrypted: {exc}")

    if not bootstrap_b64:
        raise RuntimeError("no-source-session: TUS_STORAGE_STATE_B64 is empty and cloud session is unavailable")
    plaintext = b64decode_any(bootstrap_b64)
    json.loads(plaintext.decode("utf-8"))
    SESSION_STATE.write_bytes(plaintext)
    return "github-bootstrap-secret"


def persist_source_session(api: CloudApi, cipher_key: bytes) -> None:
    if not SESSION_STATE.exists():
        return
    plaintext = SESSION_STATE.read_bytes()
    json.loads(plaintext.decode("utf-8"))
    nonce = os.urandom(12)
    ciphertext = AESGCM(cipher_key).encrypt(nonce, plaintext, AAD)
    api.put_source_session(b64url(ciphertext), b64url(nonce))


def canonical_hash(payload: dict) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def change_payload(group_id: str, ch: dict) -> dict:
    raw = json.dumps(ch, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    out = dict(ch)
    out["dedupe_hash"] = hashlib.sha256((group_id + "|" + raw).encode("utf-8")).hexdigest()
    return out


def notification_body(ch: dict) -> str:
    a = ch.get("after") or {}
    b = ch.get("before") or {}
    name = ch.get("module") or ch.get("activity") or "Class"
    typ = ch.get("change_type")
    if typ == "ROOM_CHANGED":
        return f"{name}: {(b.get('room_code') or b.get('room_raw') or '?')} → {(a.get('room_code') or a.get('room_raw') or '?')}"
    if typ == "TIME_CHANGED":
        return f"{name}: {b.get('start', '?')} → {a.get('start', '?')}"
    if typ == "CLASS_ADDED":
        return f"New class: {name} {a.get('start', '')}".strip()
    if typ == "CLASS_REMOVED":
        return f"Class removed: {name} {b.get('start', '')}".strip()
    if typ == "LECTURER_CHANGED":
        return f"{name}: lecturer changed"
    if typ == "CLASS_TYPE_CHANGED":
        return f"{name}: {b.get('type', '?')} → {a.get('type', '?')}"
    if typ == "TEACHING_WEEKS_CHANGED":
        return f"{name}: teaching weeks changed"
    return name


def send_pushes(api: CloudApi, group_id: str, changes: list[dict], private_key: str, subject: str, workers: int = 16) -> dict:
    if not changes or not private_key or not subject:
        return {"sent": 0, "reason": "no-changes-or-vapid"}
    subs = api.subscriptions(group_id)
    jobs: list[tuple[dict, dict]] = []
    for sub in subs:
        hidden = {str(x).casefold() for x in sub.get("hidden_modules", [])}
        for ch in changes:
            if str(ch.get("module") or "").casefold() in hidden:
                continue
            jobs.append((sub, {
                "title": "TUS timetable changed",
                "body": notification_body(ch),
                "url": "/?tab=changes",
                "tag": f"{group_id}:{ch.get('change_type','')}:{ch.get('module','')}",
            }))
    if not jobs:
        return {"sent": 0, "reason": "no-targets"}

    def send_one(sub: dict, payload: dict):
        try:
            webpush(
                subscription_info={
                    "endpoint": sub["endpoint"],
                    "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
                },
                data=json.dumps(payload, ensure_ascii=False),
                vapid_private_key=private_key,
                vapid_claims={"sub": subject},
                ttl=300,
            )
            return (True, sub["endpoint"], None)
        except WebPushException as exc:
            response = getattr(exc, "response", None)
            status = getattr(response, "status_code", None)
            return (False, sub["endpoint"], status)
        except Exception:
            return (False, sub["endpoint"], None)

    sent = 0
    pool_size = min(max(1, workers), len(jobs))
    with ThreadPoolExecutor(max_workers=pool_size, thread_name_prefix="webpush") as pool:
        futures = [pool.submit(send_one, sub, payload) for sub, payload in jobs]
        for future in as_completed(futures):
            ok, endpoint, status = future.result()
            if ok:
                sent += 1
            elif status in (404, 410):
                try:
                    api.deactivate(endpoint)
                except Exception as exc:
                    print(f"[push] could not deactivate dead subscription: {exc}")
    return {"sent": sent, "jobs": len(jobs), "workers": pool_size}


def process_group(api: CloudApi, item: dict, html: str, vapid_private: str, vapid_subject: str, push_workers: int = 16) -> dict:
    snap = parse_textspreadsheet(html)
    snap.group_id = item["group_id"]
    snap.department_id = item["department_id"]
    if not snap.events:
        raise RuntimeError("empty-timetable-response")

    previous = item.get("snapshot")
    changes: list[dict] = []
    if previous:
        prev_model = TimetableSnapshot.model_validate(previous)
        changes = [c.model_dump(mode="json") for c in diff_snapshots(prev_model, snap)]

    payload = snap.model_dump(mode="json")
    enriched = [change_payload(item["group_id"], ch) for ch in changes]
    result = api.upload_result({
        "group_id": item["group_id"],
        "department_id": item["department_id"],
        "snapshot": payload,
        "payload_hash": canonical_hash(payload),
        "changes": enriched,
    })
    push = send_pushes(api, item["group_id"], changes, vapid_private, vapid_subject, workers=push_workers) if changes else {"sent": 0, "reason": "no-changes"}
    return {
        "group_id": item["group_id"],
        "events": len(snap.events),
        "changes": len(changes),
        "saved_changes": result.get("saved_changes", 0),
        "push": push,
    }


def main() -> int:
    base_url = os.environ.get("CLOUD_API_URL", "").strip()
    admin_token = os.environ.get("CLOUD_ADMIN_TOKEN", "").strip()
    cipher_key_raw = os.environ.get("SESSION_CIPHER_KEY_B64", "").strip()
    bootstrap = os.environ.get("TUS_STORAGE_STATE_B64", "").strip() or None
    vapid_private = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    vapid_subject = os.environ.get("VAPID_SUBJECT", "mailto:admin@example.com").strip()
    push_workers = int(os.environ.get("TUS_PUSH_WORKERS", "16"))
    preload_missing = os.environ.get("TUS_PRELOAD_MISSING", "").strip().lower() in {"1", "true", "yes"}
    preload_limit = int(os.environ.get("TUS_PRELOAD_LIMIT", "25"))

    if not base_url or not admin_token or not cipher_key_raw:
        raise RuntimeError("CLOUD_API_URL, CLOUD_ADMIN_TOKEN and SESSION_CIPHER_KEY_B64 are required")
    cipher_key = b64decode_any(cipher_key_raw)
    if len(cipher_key) != 32:
        raise RuntimeError("SESSION_CIPHER_KEY_B64 must decode to exactly 32 bytes")

    os.environ["TUS_EPHEMERAL_BROWSER"] = "1"
    started = utc_iso()
    started_mono = time.monotonic()
    errors = 0
    group_count = 0
    api = CloudApi(base_url, admin_token)

    try:
        session_source = restore_source_session(api, cipher_key, bootstrap)
        print(f"[session] restored from {session_source}")

        plan = api.sync_plan(preload_missing=preload_missing, limit=preload_limit)
        if plan.get("catalog_refresh_due"):
            print("[catalog] refresh due")
            catalog_payload = scrape_catalog(headless=True)
            summary = api.upload_catalog(catalog_payload)
            print(f"[catalog] {summary}")
            # scrape_catalog updates storage_state; persist immediately so any
            # upstream cookie rotation survives even if later group sync fails.
            persist_source_session(api, cipher_key)
            plan = api.sync_plan(preload_missing=preload_missing, limit=preload_limit)

        groups = plan.get("groups") or []
        group_count = len(groups)
        if groups:
            mode = "uncached" if preload_missing else "active"
            print(f"[sync] fetching {group_count} {mode} group(s)")
            fetched = fetch_many(groups, headless=True)
            for item in groups:
                group_id = item["group_id"]
                result = fetched.get(group_id) or {"html": None, "error": "missing-batch-result"}
                if result.get("error"):
                    errors += 1
                    api.upload_result({"group_id": group_id, "error": result["error"]})
                    print(f"[sync:{group_id}] ERROR {result['error']}")
                    continue
                try:
                    out = process_group(api, item, result["html"], vapid_private, vapid_subject, push_workers)
                    print(f"[sync:{group_id}] {out}")
                except Exception as exc:
                    errors += 1
                    api.upload_result({"group_id": group_id, "error": str(exc)})
                    print(f"[sync:{group_id}] ERROR {exc}")
        else:
            print("[sync] no active groups yet")

        persist_source_session(api, cipher_key)
        return 0 if errors == 0 else 2
    except Exception as exc:
        errors += 1
        print(f"[fatal] {exc}")
        return 1
    finally:
        finished = utc_iso()
        duration = round(time.monotonic() - started_mono, 3)
        try:
            api.cycle({
                "started_at": started,
                "finished_at": finished,
                "duration_seconds": duration,
                "groups": group_count,
                "errors": errors,
            })
        except Exception as exc:
            print(f"[cycle] could not report cycle status: {exc}")
        api.close()


if __name__ == "__main__":
    raise SystemExit(main())
