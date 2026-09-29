from __future__ import annotations
from datetime import datetime, timezone
import re
from .settings import DATA_DIR
from .collector.playwright_collector import fetch_html, fetch_many, scrape_catalog
from .parser import parse_textspreadsheet
from .diff import diff_snapshots
from .models import TimetableSnapshot
from .database import (
    active_interests, latest_snapshot, save_snapshot, save_changes,
    set_sync_state, replace_catalog,
)
from .notifications import send_changes


def _process_group(department_id: str, group_id: str, html: str) -> dict:
    snap = parse_textspreadsheet(html)
    snap.group_id = group_id
    snap.department_id = department_id
    if not snap.events:
        # Preserve the exact live report for diagnosis instead of losing it.
        # This file contains timetable HTML only; no passwords are written here.
        debug_dir = DATA_DIR / "debug"
        debug_dir.mkdir(parents=True, exist_ok=True)
        safe_group = re.sub(r"[^A-Za-z0-9_.-]+", "_", group_id).strip("_") or "group"
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        debug_path = debug_dir / f"empty_{safe_group}_{stamp}.html"
        debug_path.write_text(html, encoding="utf-8", errors="replace")
        raise RuntimeError(f"empty-timetable-response (saved {debug_path})")

    prev_raw = latest_snapshot(group_id)
    changes: list[dict] = []
    if prev_raw:
        prev = TimetableSnapshot.model_validate(prev_raw)
        changes = [c.model_dump(mode="json") for c in diff_snapshots(prev, snap)]

    payload = snap.model_dump(mode="json")
    save_snapshot(group_id, payload)
    new_changes = save_changes(group_id, changes)
    push = send_changes(group_id, new_changes)
    set_sync_state(group_id, "ok", success=True)
    return {"group_id": group_id, "events": len(snap.events), "changes": len(new_changes), "push": push}


def sync_group(department_id: str, group_id: str) -> dict:
    set_sync_state(group_id, "syncing")
    try:
        html = fetch_html(department_id, group_id, headless=True)
        return _process_group(department_id, group_id, html)
    except Exception as exc:
        set_sync_state(group_id, "error", str(exc))
        raise


def sync_active_groups() -> list[dict]:
    items = active_interests()
    if not items:
        return []
    for item in items:
        set_sync_state(item["group_id"], "syncing")
    try:
        fetched = fetch_many(items, headless=True)
    except Exception as exc:
        for item in items:
            set_sync_state(item["group_id"], "error", str(exc))
        return [{"group_id": item["group_id"], "error": str(exc)} for item in items]

    results = []
    for item in items:
        group = item["group_id"]
        result = fetched.get(group) or {"error": "missing-batch-result", "html": None}
        if result["error"]:
            set_sync_state(group, "error", result["error"])
            results.append({"group_id": group, "error": result["error"]})
            continue
        try:
            results.append(_process_group(item["department_id"], group, result["html"]))
        except Exception as exc:
            set_sync_state(group, "error", str(exc))
            results.append({"group_id": group, "error": str(exc)})
    return results


def refresh_catalog() -> dict:
    c = scrape_catalog(headless=True)
    replace_catalog(c)
    return {
        "departments": len(c["departments"]),
        "groups": sum(len(x["groups"]) for x in c["department_groups"]),
    }
