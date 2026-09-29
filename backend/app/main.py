from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
import threading
import time

from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import database as db
from .settings import (
    SCHEDULER_ENABLED,
    SYNC_INTERVAL_SECONDS,
    CATALOG_REFRESH_HOURS,
    ADMIN_TOKEN,
    VAPID_PUBLIC_KEY,
    APP_VERSION, OPERATOR_NAME, CONTACT_EMAIL, LEGAL_VERSION,
)
from .sync_service import sync_active_groups, refresh_catalog, sync_group
from .room import mappedin_directions_url, mappedin_location_url
from .notifications import send_test

_stop = threading.Event()
_worker: threading.Thread | None = None
_FIRST_SYNC_RETRY_SECONDS = 30
_TRANSIENT_RECOVERY_SECONDS = 60
_scheduler_lock = threading.Lock()
_scheduler_state = {
    "started_at": None,
    "last_cycle_started_at": None,
    "last_cycle_finished_at": None,
    "last_cycle_duration_seconds": None,
    "last_cycle_groups": 0,
    "last_cycle_errors": 0,
}


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _scheduler_update(**values) -> None:
    with _scheduler_lock:
        _scheduler_state.update(values)


def _scheduler_snapshot() -> dict:
    with _scheduler_lock:
        return dict(_scheduler_state)


def _seconds_since(iso_value: str | None) -> float | None:
    if not iso_value:
        return None
    try:
        dt = datetime.fromisoformat(iso_value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return max(0.0, (datetime.now(timezone.utc) - dt.astimezone(timezone.utc)).total_seconds())
    except Exception:
        return None


def _may_start_first_sync(sync: dict) -> bool:
    status = sync.get("status")
    if status in {"queued", "syncing"}:
        return False
    age = _seconds_since(sync.get("last_attempt_at"))
    if status == "error" and age is not None and age < _FIRST_SYNC_RETRY_SECONDS:
        return False
    return True


def _may_retry_failed_sync(sync: dict) -> bool:
    if sync.get("status") != "error":
        return False
    # An expired central TUS session needs an administrator reconnect; hammering
    # the upstream login page from every student device would not help.
    error = str(sync.get("error") or "").lower()
    if "source-session-expired" in error or "login-required" in error:
        return False
    age = _seconds_since(sync.get("last_attempt_at"))
    return age is None or age >= _TRANSIENT_RECOVERY_SECONDS


def _background_loop() -> None:
    """Run the source poller 24/7 on a start-to-start cadence.

    There is intentionally no evening/night quiet window. A five-minute interval
    means a successful cycle starts every five minutes while the process and TUS
    source session are available. Only groups with recent interest or active push
    subscriptions are polled; any catalogued course is synced immediately when a
    student selects it.
    """
    has_catalog = bool(db.catalog().get("departments"))
    next_catalog = time.monotonic() + (CATALOG_REFRESH_HOURS * 3600 if has_catalog else 0)
    next_sync = time.monotonic() + 2.0
    _scheduler_update(started_at=_utc_iso())

    while not _stop.is_set():
        wait_for = max(0.0, next_sync - time.monotonic())
        if _stop.wait(wait_for):
            break

        cycle_started_mono = time.monotonic()
        cycle_started_iso = _utc_iso()
        _scheduler_update(last_cycle_started_at=cycle_started_iso)
        results = []
        try:
            results = sync_active_groups()
        except Exception as exc:
            print(f"[sync] {exc}")
            results = [{"error": str(exc)}]

        cycle_finished_mono = time.monotonic()
        errors = sum(1 for item in results if item.get("error"))
        _scheduler_update(
            last_cycle_finished_at=_utc_iso(),
            last_cycle_duration_seconds=round(cycle_finished_mono - cycle_started_mono, 3),
            last_cycle_groups=len(results),
            last_cycle_errors=errors,
        )

        # Anchor to the intended cadence rather than sleeping five more minutes
        # after a long batch. If a batch overruns one or more slots, resume at the
        # next future slot instead of spinning in a tight catch-up loop.
        next_sync += SYNC_INTERVAL_SECONDS
        now_mono = time.monotonic()
        while next_sync <= now_mono:
            next_sync += SYNC_INTERVAL_SECONDS

        # Catalogue discovery is low-frequency and never changes the 24/7 sync policy.
        if now_mono >= next_catalog:
            try:
                refresh_catalog()
            except Exception as exc:
                print(f"[catalog] {exc}")
            next_catalog = time.monotonic() + CATALOG_REFRESH_HOURS * 3600


@asynccontextmanager
async def lifespan(app):
    global _worker
    db.init_db()
    if SCHEDULER_ENABLED:
        _stop.clear()
        _worker = threading.Thread(target=_background_loop, name="tus-sync-worker", daemon=True)
        _worker.start()
    yield
    _stop.set()
    if _worker and _worker.is_alive():
        _worker.join(timeout=2)


app = FastAPI(title="TUS Companion API", version="1.7.0-cloud", lifespan=lifespan)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(self), camera=(), microphone=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; connect-src 'self' https://*.push.services.mozilla.com "
        "https://fcm.googleapis.com https://updates.push.services.mozilla.com; "
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    )
    return response


app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class WatchReq(BaseModel):
    department_id: str
    group_id: str


class PushKeys(BaseModel):
    p256dh: str
    auth: str


class PushReq(BaseModel):
    group_id: str
    endpoint: str
    keys: PushKeys
    hidden_modules: list[str] = []


class PushEndpointReq(BaseModel):
    endpoint: str


def require_admin(token: str | None) -> None:
    if not ADMIN_TOKEN or token != ADMIN_TOKEN:
        raise HTTPException(403, "admin-disabled-or-invalid-token")


@app.get("/health")
def health():
    return {
        "status": "ok",
        "scheduler": {
            "enabled": SCHEDULER_ENABLED,
            "interval_seconds": SYNC_INTERVAL_SECONDS,
            **_scheduler_snapshot(),
        },
    }


@app.get("/api/meta")
def meta():
    return {"version": APP_VERSION, "operator_name": OPERATOR_NAME, "contact_email": CONTACT_EMAIL, "legal_version": LEGAL_VERSION}


@app.get("/api/catalog")
def get_catalog():
    return db.catalog()


@app.post("/api/watch")
def watch(req: WatchReq):
    """Register interest and kick off the first snapshot without blocking the UI."""
    if not db.group_exists(req.group_id, req.department_id):
        raise HTTPException(400, "unknown-course-group")
    db.touch_interest(req.group_id, req.department_id)
    current = db.latest_snapshot(req.group_id)
    sync = db.get_sync_state(req.group_id)

    if current is None and _may_start_first_sync(sync):
        # Mark queued BEFORE the thread starts. Repeated browser polling therefore
        # cannot spawn multiple collectors for the same first snapshot.
        db.set_sync_state(req.group_id, "queued")
        threading.Thread(
            target=lambda: _safe_sync_one(req.department_id, req.group_id),
            name=f"first-sync-{req.group_id}",
            daemon=True,
        ).start()
        sync = db.get_sync_state(req.group_id)
    elif current is not None and _may_retry_failed_sync(sync):
        # A transient refresh failure should recover quickly while the timetable is
        # being viewed instead of leaving a scary error banner around until the
        # five-minute scheduler tick. The queued state gates duplicate browser polls.
        db.set_sync_state(req.group_id, "queued")
        threading.Thread(
            target=lambda: _safe_sync_one(req.department_id, req.group_id),
            name=f"recovery-sync-{req.group_id}",
            daemon=True,
        ).start()
        sync = db.get_sync_state(req.group_id)

    return {
        "ok": True,
        "has_snapshot": current is not None,
        "sync": sync,
    }


def _safe_sync_one(department_id: str, group_id: str) -> None:
    try:
        sync_group(department_id, group_id)
    except Exception as exc:
        print(f"[first-sync:{group_id}] {exc}")


@app.get("/api/timetable/{group_id}")
def timetable(group_id: str):
    snap = db.latest_snapshot(group_id)
    if not snap:
        raise HTTPException(404, "not-synced-yet")
    return {"snapshot": snap, "sync": db.get_sync_state(group_id)}


@app.get("/api/changes/{group_id}")
def changes(group_id: str, limit: int = 50):
    return db.get_changes(group_id, min(max(limit, 1), 200))


@app.get("/api/sync-status/{group_id}")
def sync_status(group_id: str):
    return db.get_sync_state(group_id)


@app.get("/api/map/{room_code}")
def map_room(room_code: str, departure: str | None = None, accessible: bool = False):
    return {
        "location_url": mappedin_location_url(room_code),
        "directions_url": mappedin_directions_url(room_code, departure, accessible),
    }


@app.get("/api/push/public-key")
def push_key():
    return {"publicKey": VAPID_PUBLIC_KEY or None}


@app.post("/api/push/subscribe")
def push_subscribe(req: PushReq):
    if not db.group_exists(req.group_id):
        raise HTTPException(400, "unknown-course-group")
    db.upsert_subscription(req.group_id, req.endpoint, req.keys.p256dh, req.keys.auth, req.hidden_modules)
    return {"ok": True}


@app.post("/api/push/test")
def push_test(req: PushEndpointReq):
    result = send_test(req.endpoint)
    if result.get("reason") == "subscription-not-found":
        raise HTTPException(404, "subscription-not-found")
    if result.get("disabled"):
        raise HTTPException(503, result.get("reason") or "push-disabled")
    return result


@app.post("/api/push/unsubscribe")
def push_unsubscribe(req: PushEndpointReq):
    db.deactivate_subscription(req.endpoint)
    return {"ok": True}


@app.post("/api/admin/catalog/refresh")
def admin_catalog(x_admin_token: str | None = Header(None)):
    require_admin(x_admin_token)
    return refresh_catalog()


@app.post("/api/admin/sync")
def admin_sync(req: WatchReq, x_admin_token: str | None = Header(None)):
    require_admin(x_admin_token)
    return sync_group(req.department_id, req.group_id)


# Static PWA is mounted last so /api and /health keep priority.
FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
if FRONTEND.exists():
    app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
