#!/usr/bin/env python3
"""Build a source-attributed, course-code-keyed TUS Midlands exam index.

Reads CURRENT public TUS Excel 97-2003 .xls schedules (never student passwords).
For testing, --source-dir accepts three previously downloaded official workbooks.
Requires xlrd 2.x. Fails rather than publishing incomplete or invented exams.
"""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
from hashlib import sha256
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse, unquote
from urllib.request import Request, urlopen
import json
import re

FACULTY = "https://tus.ie/exams/midlands/timetables/business-and-hospitality/"
EXAMS = "https://tus.ie/exams/midlands/timetables/"
SOURCE_PREFIX = "https://tus.ie/app/uploads/AcademicServices/Exams/Midlands/FacultyBusinessandHospitality/"
CATEGORIES = {
    "Bus-Mgt": "Business & Management",
    "ABC": "Accounting & Business Computing",
    "HTL": "Hospitality, Tourism & Leisure",
}
HEADERS = ["Department", "Programme Code", "Programme", "Module Code",
           "Module Description", "Duration", "Day", "Date", "Start Time",
           "Finish Time", "Location", "Students", "Comment"]


class LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
    def handle_starttag(self, tag, attrs):
        if tag.lower() == "a":
            for key, val in attrs:
                if key == "href" and val:
                    self.links.append(val)


def fetch(url):
    if not url.startswith("https://tus.ie/"):
        raise ValueError("Only official TUS HTTPS sources are permitted")
    req = Request(url, headers={"User-Agent": "TUSCompanionExamSourceCheck/1.0",
                                "Accept": "text/html,application/vnd.ms-excel,*/*"})
    with urlopen(req, timeout=25) as response:
        dest = response.geturl()
        if urlparse(dest).scheme != "https" or urlparse(dest).hostname not in {"tus.ie", "www.tus.ie"}:
            raise ValueError("TUS source redirected outside the institution")
        payload = response.read(5_000_001)
        if len(payload) > 5_000_000:
            raise ValueError("TUS source exceeded 5MB limit")
        return payload


def official_links():
    parser = LinkParser()
    parser.feed(fetch(FACULTY).decode("utf-8", "replace"))
    result = {}
    for href in parser.links:
        url = urljoin(FACULTY, href)
        path = unquote(urlparse(url).path)
        if not url.startswith(SOURCE_PREFIX) or not path.lower().endswith(".xls"):
            continue
        filename = Path(path).name
        for prefix in CATEGORIES:
            if filename.lower().startswith(prefix.lower() + "_"):
                if prefix in result and result[prefix] != url:
                    raise ValueError("Ambiguous official timetable versions for " + prefix)
                result[prefix] = url
    missing = set(CATEGORIES) - set(result)
    if missing:
        raise ValueError("Missing official timetable links: " + ", ".join(sorted(missing)))
    return result


def celltext(sheet, row, col, datemode):
    import xlrd
    cell = sheet.cell(row, col)
    value = cell.value
    if cell.ctype == xlrd.XL_CELL_DATE:
        dt = xlrd.xldate_as_datetime(value, datemode)
        if col == 7:
            return dt.strftime("%d/%m/%Y")
        if col in (8, 9):
            return dt.strftime("%H:%M")
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def parse_xls(raw, source_name):
    import xlrd
    book = xlrd.open_workbook(file_contents=raw, on_demand=True)
    result = []
    for sheet in book.sheets():
        if sheet.ncols < 11:
            continue
        for row in range(sheet.nrows):
            values = [celltext(sheet, row, col, book.datemode) if col < sheet.ncols else ""
                      for col in range(13)]
            if values[1] == "Programme Code" or not values[1]:
                continue
            code = values[1].upper()
            if not re.fullmatch(r"AL_[A-Z0-9_]+", code):
                raise ValueError(f"Unknown programme code in {source_name} row {row+1}")
            if not all(values[i] for i in [2, 3, 4, 6, 7, 8, 9, 10]):
                raise ValueError(f"Missing exam fields in {source_name} row {row+1}")
            date = datetime.strptime(values[7], "%d/%m/%Y")
            if not (datetime(2026, 12, 5) <= date <= datetime(2026, 12, 18)):
                raise ValueError(f"Unexpected exam date {values[7]} in {source_name}")
            if date.strftime("%A").lower() != values[6].lower():
                raise ValueError(f"Exam day/date mismatch in {source_name} row {row+1}")
            start = datetime.strptime(values[8], "%H:%M")
            end = datetime.strptime(values[9], "%H:%M")
            if end <= start:
                raise ValueError(f"Nonpositive exam duration in {source_name} row {row+1}")
            result.append({
                "programme_code": code,
                "programme": values[2],
                "module_code": values[3],
                "module": values[4],
                "day": values[6],
                "date": date.date().isoformat(),
                "start": values[8],
                "end": values[9],
                "room": values[10],
                "note": values[12] or None,
            })
    book.release_resources()
    if not result:
        raise ValueError("Official workbook has no exam rows: " + source_name)
    return result


def compile_data(source_dir=None):
    sources = official_links() if source_dir is None else {
        prefix: SOURCE_PREFIX + next(
            p.name for p in sorted(source_dir.glob(prefix + "_*.xls"))
        ) for prefix in CATEGORIES
    }
    programmes = {}
    metadata = []
    counts = {}
    for prefix, dept in CATEGORIES.items():
        url = sources[prefix]
        filename = Path(unquote(urlparse(url).path)).name
        raw = fetch(url) if source_dir is None else (source_dir / filename).read_bytes()
        rows = parse_xls(raw, filename)
        counts[prefix] = len(rows)
        metadata.append({"department": dept, "filename": filename, "url": url,
                         "sha256": sha256(raw).hexdigest(), "exam_entries": len(rows)})
        for row in rows:
            code = row.pop("programme_code")
            name = row.pop("programme")
            entry = programmes.setdefault(code, {"name": name, "exams": []})
            if entry["name"] != name:
                raise ValueError("Ambiguous programme name for " + code)
            row["source"] = prefix
            if row not in entry["exams"]:
                entry["exams"].append(row)
    if min(counts.values()) < 10 or sum(counts.values()) < 180:
        raise ValueError("One or more TUS exam sources appears incomplete")
    for item in programmes.values():
        item["exams"].sort(key=lambda e: (e["date"], e["start"], e["module_code"]))
    return {
        "schema": 1,
        "period": "TUS Midlands Semester 1 · December 2026",
        "last_checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "official_url": EXAMS,
        "sources": metadata,
        "programmes": dict(sorted(programmes.items())),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, help="Use locally supplied official .xls files for tests")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    data = compile_data(args.source_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"TUS exam source checked: {sum(len(x['exams']) for x in data['programmes'].values())} exam rows, "
          f"{len(data['programmes'])} programmes, {len(data['sources'])} official source files.")


if __name__ == "__main__":
    main()
