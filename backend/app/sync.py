from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from .diff import diff_snapshots
from .models import TimetableSnapshot
from .parser import parse_textspreadsheet

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
HISTORY = DATA / "history"
LATEST_HTML = DATA / "latest_textspreadsheet.html"
LATEST_JSON = DATA / "latest_timetable.json"
PREVIOUS_JSON = DATA / "previous_timetable.json"
LATEST_CHANGES = DATA / "latest_changes.json"


def _dump_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _load_snapshot(path: Path) -> TimetableSnapshot | None:
    if not path.exists():
        return None
    try:
        return TimetableSnapshot.model_validate_json(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def process_html(path: Path = LATEST_HTML) -> tuple[TimetableSnapshot, list]:
    if not path.exists():
        raise FileNotFoundError(f"Timetable HTML not found: {path}")

    html = path.read_text(encoding="utf-8", errors="replace")
    snapshot = parse_textspreadsheet(html)
    if not snapshot.events:
        raise RuntimeError("The TUS timetable HTML was parsed, but no events were found.")

    before = _load_snapshot(LATEST_JSON)
    changes = diff_snapshots(before, snapshot) if before else []

    DATA.mkdir(parents=True, exist_ok=True)
    HISTORY.mkdir(parents=True, exist_ok=True)

    if before:
        _dump_json(PREVIOUS_JSON, before.model_dump(mode="json"))

    _dump_json(LATEST_JSON, snapshot.model_dump(mode="json"))
    _dump_json(LATEST_CHANGES, [c.model_dump(mode="json") for c in changes])

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    _dump_json(HISTORY / f"{stamp}.json", snapshot.model_dump(mode="json"))

    return snapshot, changes


def print_summary(snapshot: TimetableSnapshot, changes: list) -> None:
    print(f"Student group: {snapshot.student_group}")
    if snapshot.week_number is not None:
        print(f"Week: {snapshot.week_number} ({snapshot.week_start} -> {snapshot.week_end})")
    print(f"Events parsed: {len(snapshot.events)}")
    print(f"Changes detected vs previous snapshot: {len(changes)}")
    print(f"Saved JSON: {LATEST_JSON}")
    print(f"Saved changes: {LATEST_CHANGES}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Process the latest TUS TextSpreadsheet HTML into JSON")
    ap.add_argument("command", nargs="?", default="process", choices=["process", "show"])
    ap.add_argument("--input", type=Path, default=LATEST_HTML)
    args = ap.parse_args()

    if args.command == "show":
        snapshot = _load_snapshot(LATEST_JSON)
        if not snapshot:
            raise SystemExit("No live timetable JSON yet. Run the collector fetch first.")
        print_summary(snapshot, [])
        return

    snapshot, changes = process_html(args.input)
    print_summary(snapshot, changes)


if __name__ == "__main__":
    main()
