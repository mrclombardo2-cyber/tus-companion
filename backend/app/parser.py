from __future__ import annotations
import re
from datetime import date, timedelta
from bs4 import BeautifulSoup, Tag
from .models import TimetableEvent, TimetableSnapshot
from .room import normalize_room

DAY_INDEX = {
    "Monday": 0, "Tuesday": 1, "Wednesday": 2,
    "Thursday": 3, "Friday": 4, "Saturday": 5, "Sunday": 6,
}

HEADER = ["Activity", "Module", "Type", "Start", "End", "Duration", "Weeks", "Room", "Staff", "Student Groups"]


def parse_weeks(raw: str) -> list[int]:
    raw = raw.strip()
    if not raw:
        return []
    values: list[int] = []
    for part in re.split(r"[;,]", raw):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r"(\d+)\s*-\s*(\d+)", part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            values.extend(range(min(a, b), max(a, b) + 1))
        elif part.isdigit():
            values.append(int(part))
    return sorted(set(values))


def _parse_header(text: str) -> tuple[str, int | None, date | None, date | None]:
    normalized = " ".join(text.split())
    group = "Unknown"
    gm = re.search(r"Student Group:\s*(.*?)\s+Weeks selected for output:", normalized, re.I)
    if gm:
        group = gm.group(1).strip()

    week_number = None
    week_start = None
    week_end = None
    wm = re.search(r"Weeks selected for output:\s*(\d+)\s*\(\s*(\d{1,2}\s+\w+\s+\d{4})\s*-\s*(\d{1,2}\s+\w+\s+\d{4})\s*\)", normalized, re.I)
    if wm:
        week_number = int(wm.group(1))
        for idx, target in [(2, "start"), (3, "end")]:
            try:
                parsed = __import__("datetime").datetime.strptime(wm.group(idx), "%d %b %Y").date()
            except ValueError:
                parsed = None
            if target == "start":
                week_start = parsed
            else:
                week_end = parsed
    return group, week_number, week_start, week_end


def _event_date(day: str, week_start: date | None) -> date | None:
    if not week_start or day not in DAY_INDEX:
        return None
    return week_start + timedelta(days=DAY_INDEX[day])


def parse_textspreadsheet(html: str) -> TimetableSnapshot:
    soup = BeautifulSoup(html, "html.parser")
    group, week_number, week_start, week_end = _parse_header(soup.get_text(" ", strip=True))
    events: list[TimetableEvent] = []

    for p in soup.find_all("p"):
        day = p.get_text(" ", strip=True)
        if day not in DAY_INDEX:
            continue
        table = p.find_next_sibling("table")
        if not isinstance(table, Tag):
            continue
        # Raw Scientia HTML places <tr> directly under <table>, but browsers
        # normalize that markup and insert a <tbody>. Playwright page.content()
        # therefore often serializes the live response as <table><tbody><tr>...
        # Support both representations so live collector output parses exactly
        # like the raw DevTools response/fixture.
        rows = table.find_all("tr", recursive=False)
        if not rows:
            rows = []
            for section_name in ("thead", "tbody", "tfoot"):
                for section in table.find_all(section_name, recursive=False):
                    rows.extend(section.find_all("tr", recursive=False))
        if not rows:
            continue

        def row_cells(row: Tag) -> list[str]:
            # Accept <th> too, even though current Scientia output uses <td>.
            return [cell.get_text(" ", strip=True) for cell in row.find_all(["td", "th"], recursive=False)]

        header = row_cells(rows[0])
        if header != HEADER:
            continue
        for row in rows[1:]:
            cells = row_cells(row)
            if len(cells) != 10:
                continue
            room_code, room_name = normalize_room(cells[7])
            groups = [g.strip() for g in cells[9].split(";") if g.strip()]
            events.append(TimetableEvent(
                day=day,
                date=_event_date(day, week_start),
                activity=cells[0],
                module=cells[1],
                type=cells[2],
                start=cells[3].zfill(5),
                end=cells[4].zfill(5),
                duration=cells[5],
                weeks_raw=cells[6],
                weeks=parse_weeks(cells[6]),
                room_raw=cells[7],
                room_code=room_code,
                room_name=room_name,
                staff=cells[8],
                student_groups=groups,
            ))

    return TimetableSnapshot(
        student_group=group,
        week_number=week_number,
        week_start=week_start,
        week_end=week_end,
        events=events,
    )
