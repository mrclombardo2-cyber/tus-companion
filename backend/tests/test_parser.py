from pathlib import Path
from app.parser import parse_textspreadsheet

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "textspreadsheet_sample.html"


def test_parse_sample():
    snap = parse_textspreadsheet(FIXTURE.read_text(encoding="utf-8", errors="replace"))
    assert snap.week_number == 7
    assert str(snap.week_start) == "2026-09-28"
    assert "Higher Certificate" in snap.student_group
    assert len(snap.events) >= 15

    first = snap.events[0]
    assert first.day == "Monday"
    assert first.start == "09:00"
    assert first.end == "11:00"
    assert first.room_code == "C74"
    assert first.module == "IT & Computer Applications 2"


def test_room_names_survive():
    snap = parse_textspreadsheet(FIXTURE.read_text(encoding="utf-8", errors="replace"))
    rooms = {e.room_code: e.room_name for e in snap.events}
    assert rooms["C1164"] == "Earl of Rosse"
    assert rooms["E51"] == "Moot Court Room"


def test_parser_accepts_browser_inserted_tbody():
    """Playwright page.content() serializes HTML tables with an inserted tbody."""
    from app.parser import parse_textspreadsheet

    html = """
    <html><head><title>Student Set TextSpreadsheet</title></head><body>
      <div>Student Group: Test Group Weeks selected for output: 7 (28 Sep 2026-4 Oct 2026)</div>
      <p><span>Monday</span></p>
      <table border="1"><tbody>
        <tr>
          <td>Activity</td><td>Module</td><td>Type</td><td>Start</td><td>End</td>
          <td>Duration</td><td>Weeks</td><td>Room</td><td>Staff</td><td>Student Groups</td>
        </tr>
        <tr>
          <td>IT &amp; Computer Applications 2</td><td>IT &amp; Computer Applications 2</td>
          <td>Lab/Prac</td><td>9:00</td><td>11:00</td><td>2:00</td><td>4-15</td>
          <td>C74 IT7</td><td>NOLAN, JARLATH</td><td>Test Group</td>
        </tr>
      </tbody></table>
    </body></html>
    """
    snap = parse_textspreadsheet(html)
    assert len(snap.events) == 1
    assert snap.events[0].room_code == "C74"
    assert snap.events[0].start == "09:00"
