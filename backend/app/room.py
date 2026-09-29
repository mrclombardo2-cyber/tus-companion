from __future__ import annotations
import re
from urllib.parse import quote
from .settings import MAPPEDIN_MAP_ID

MAPPEDIN_BASE = f"https://app.mappedin.com/map/{MAPPEDIN_MAP_ID}"
ROOM_CODE = re.compile(r"^([A-Za-z]+\d+[A-Za-z]?)\b(?:\s+(.*))?$")

def normalize_room(raw: str) -> tuple[str | None, str | None]:
    value = " ".join(raw.split()).strip()
    if not value:
        return None, None
    m = ROOM_CODE.match(value)
    if not m:
        return None, value
    return m.group(1).upper(), (m.group(2) or "").strip() or None

def mappedin_location_url(room_code: str) -> str:
    return f"{MAPPEDIN_BASE}?location={quote(room_code)}"

def mappedin_directions_url(room_code: str, departure: str | None = None, accessible: bool = False) -> str:
    url = f"{MAPPEDIN_BASE}/directions?location={quote(room_code)}"
    if departure:
        url += f"&departure={quote(departure)}"
    if accessible:
        url += "&accessible=true"
    return url
