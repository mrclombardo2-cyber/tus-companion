from __future__ import annotations
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.getenv("TUS_DATA_DIR", ROOT / "data"))
DB_PATH = Path(os.getenv("TUS_DB_PATH", DATA_DIR / "tus_companion.db"))
SYNC_INTERVAL_SECONDS = max(60, int(os.getenv("TUS_SYNC_INTERVAL_SECONDS", "300")))
PUSH_WORKERS = max(1, min(64, int(os.getenv("TUS_PUSH_WORKERS", "16"))))
CATALOG_REFRESH_HOURS = int(os.getenv("TUS_CATALOG_REFRESH_HOURS", "24"))
INTEREST_TTL_DAYS = int(os.getenv("TUS_INTEREST_TTL_DAYS", "30"))
SCHEDULER_ENABLED = os.getenv("TUS_SCHEDULER_ENABLED", "1").lower() not in {"0", "false", "no"}
ADMIN_TOKEN = os.getenv("TUS_ADMIN_TOKEN", "")
VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY", str(ROOT / "secrets" / "vapid_private.pem"))
VAPID_PUBLIC_FILE = ROOT / "secrets" / "vapid_public.txt"
VAPID_PUBLIC_KEY = os.getenv("VAPID_PUBLIC_KEY", "") or (VAPID_PUBLIC_FILE.read_text(encoding="utf-8").strip() if VAPID_PUBLIC_FILE.exists() else "")
VAPID_SUBJECT = os.getenv("VAPID_SUBJECT", "mailto:admin@example.com")
BASE_URL = "https://timetables.midlands.tus.ie/2627/default.aspx"
TEXT_LAYOUT = "TextSpreadsheet;swsurl;student+set+textspreadsheet"
MAPPEDIN_MAP_ID = "68b1b5dd74254a000bbf174b"

APP_VERSION = os.getenv("TUS_APP_VERSION", "1.7.0-cloud")
OPERATOR_NAME = os.getenv("TUS_OPERATOR_NAME", "Independent TUS Companion project")
CONTACT_EMAIL = os.getenv("TUS_CONTACT_EMAIL", "")
LEGAL_VERSION = os.getenv("TUS_LEGAL_VERSION", "2026-09-29")
