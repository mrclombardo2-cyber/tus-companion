from pathlib import Path
from copy import deepcopy
from app.parser import parse_textspreadsheet
from app.diff import diff_snapshots

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "textspreadsheet_sample.html"


def test_room_change():
    before = parse_textspreadsheet(FIXTURE.read_text(encoding="utf-8", errors="replace"))
    after = deepcopy(before)
    after.events[0].room_raw = "B1014"
    after.events[0].room_code = "B1014"
    after.events[0].room_name = None
    changes = diff_snapshots(before, after)
    assert len(changes) == 1
    assert changes[0].change_type == "ROOM_CHANGED"
    assert changes[0].before.room_code == "C74"
    assert changes[0].after.room_code == "B1014"


def test_type_and_teaching_weeks_changes():
    before = parse_textspreadsheet(FIXTURE.read_text(encoding="utf-8", errors="replace"))
    after = deepcopy(before)
    after.events[0].type = "Lec"
    after.events[0].weeks_raw = "5-15"
    after.events[0].weeks = list(range(5, 16))
    changes = diff_snapshots(before, after)
    types = {c.change_type for c in changes}
    assert "CLASS_TYPE_CHANGED" in types
    assert "TEACHING_WEEKS_CHANGED" in types
