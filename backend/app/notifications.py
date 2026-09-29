from __future__ import annotations
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from .settings import VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY, VAPID_SUBJECT, PUSH_WORKERS
from .database import subscriptions, deactivate_subscription, get_subscription


def push_configured() -> bool:
    return bool(VAPID_PUBLIC_KEY and Path(VAPID_PRIVATE_KEY).exists())


def _body(ch: dict) -> str:
    a = ch.get("after") or {}
    b = ch.get("before") or {}
    name = ch.get("module") or ch.get("activity") or "Class"
    typ = ch["change_type"]
    if typ == "ROOM_CHANGED":
        return f"{name}: {(b.get('room_code') or b.get('room_raw') or '?')} → {(a.get('room_code') or a.get('room_raw') or '?')}"
    if typ == "TIME_CHANGED":
        return f"{name}: {b.get('start', '?')} → {a.get('start', '?')}"
    if typ == "CLASS_ADDED":
        return f"New class: {name} {a.get('start', '')}"
    if typ == "CLASS_REMOVED":
        return f"Class removed: {name} {b.get('start', '')}"
    if typ == "LECTURER_CHANGED":
        return f"{name}: lecturer changed"
    if typ == "CLASS_TYPE_CHANGED":
        return f"{name}: {b.get('type', '?')} → {a.get('type', '?')}"
    if typ == "TEACHING_WEEKS_CHANGED":
        return f"{name}: teaching weeks changed"
    return name


def _send(sub: dict, payload: dict, ttl: int = 300) -> bool:
    from pywebpush import webpush, WebPushException
    try:
        webpush(
            subscription_info={
                "endpoint": sub["endpoint"],
                "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
            },
            data=json.dumps(payload),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={"sub": VAPID_SUBJECT},
            ttl=ttl,
        )
        return True
    except WebPushException as exc:
        response = getattr(exc, "response", None)
        if response is not None and response.status_code in (404, 410):
            deactivate_subscription(sub["endpoint"])
        raise


def send_changes(group_id: str, changes: list[dict]) -> dict:
    if not push_configured():
        return {"sent": 0, "disabled": True, "reason": "vapid-not-configured"}
    if not changes:
        return {"sent": 0, "disabled": False, "reason": "no-changes"}

    jobs = []
    for sub in subscriptions(group_id):
        hidden = {str(x).casefold() for x in sub.get("hidden_modules", [])}
        for ch in changes:
            if str(ch.get("module") or "").casefold() in hidden:
                continue
            payload = {
                "title": "TUS timetable changed",
                "body": _body(ch),
                "url": "/?tab=changes",
                "tag": f"{group_id}:{ch['change_type']}:{ch.get('module','')}",
            }
            jobs.append((sub, payload))

    if not jobs:
        return {"sent": 0, "disabled": False, "reason": "no-targets"}

    # Push delivery is network-bound. Sending concurrently prevents a large course
    # (hundreds of subscribed devices) from blocking the timetable collector.
    sent = 0
    workers = min(PUSH_WORKERS, len(jobs))
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="webpush") as pool:
        futures = {pool.submit(_send, sub, payload): sub for sub, payload in jobs}
        for future in as_completed(futures):
            try:
                if future.result():
                    sent += 1
            except Exception as exc:
                print(f"[push:{group_id}] {exc}")
    return {"sent": sent, "disabled": False, "workers": workers}


def send_test(endpoint: str) -> dict:
    if not push_configured():
        return {"sent": 0, "disabled": True, "reason": "vapid-not-configured"}
    sub = get_subscription(endpoint)
    if not sub or not sub.get("active"):
        return {"sent": 0, "disabled": False, "reason": "subscription-not-found"}
    payload = {
        "title": "TUS Companion test",
        "body": "Notifications are working on this device.",
        "url": "/?tab=settings",
        "tag": "tus-companion-test",
    }
    try:
        _send(sub, payload, ttl=60)
        return {"sent": 1, "disabled": False}
    except Exception as exc:
        return {"sent": 0, "disabled": False, "reason": str(exc)}
