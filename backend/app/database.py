from __future__ import annotations
import hashlib
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from .settings import DATA_DIR, DB_PATH, INTEREST_TTL_DAYS


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH, timeout=30) as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        c.execute("PRAGMA busy_timeout=30000")
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS departments(
              id TEXT PRIMARY KEY,
              label TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS groups(
              id TEXT PRIMARY KEY,
              department_id TEXT NOT NULL,
              label TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS interests(
              group_id TEXT PRIMARY KEY,
              department_id TEXT NOT NULL,
              last_seen_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS snapshots(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              group_id TEXT NOT NULL,
              fetched_at TEXT NOT NULL,
              payload TEXT NOT NULL,
              payload_hash TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_snapshots_group ON snapshots(group_id,id DESC);
            CREATE TABLE IF NOT EXISTS changes(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              group_id TEXT NOT NULL,
              detected_at TEXT NOT NULL,
              change_type TEXT NOT NULL,
              module TEXT,
              activity TEXT,
              day TEXT,
              before_json TEXT,
              after_json TEXT,
              dedupe_hash TEXT UNIQUE
            );
            CREATE INDEX IF NOT EXISTS idx_changes_group ON changes(group_id,id DESC);
            CREATE TABLE IF NOT EXISTS push_subscriptions(
              endpoint TEXT PRIMARY KEY,
              group_id TEXT NOT NULL,
              p256dh TEXT NOT NULL,
              auth TEXT NOT NULL,
              created_at TEXT NOT NULL,
              active INTEGER NOT NULL DEFAULT 1
            );
            CREATE INDEX IF NOT EXISTS idx_push_group ON push_subscriptions(group_id,active);
            CREATE TABLE IF NOT EXISTS sync_state(
              group_id TEXT PRIMARY KEY,
              last_attempt_at TEXT,
              last_success_at TEXT,
              status TEXT,
              error TEXT
            );
            """
        )
        cols = {row[1] for row in c.execute("PRAGMA table_info(push_subscriptions)")}
        if "hidden_modules" not in cols:
            c.execute("ALTER TABLE push_subscriptions ADD COLUMN hidden_modules TEXT NOT NULL DEFAULT '[]'")


@contextmanager
def conn():
    init_db()
    c = sqlite3.connect(DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=30000")
    c.execute("PRAGMA synchronous=NORMAL")
    try:
        yield c
        c.commit()
    finally:
        c.close()


def replace_catalog(catalog: dict) -> None:
    ts = now_iso()
    with conn() as c:
        for d in catalog.get("departments", []):
            c.execute(
                "INSERT INTO departments(id,label,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET label=excluded.label,updated_at=excluded.updated_at",
                (d["value"], d["label"], ts),
            )
        for item in catalog.get("department_groups", []):
            dep = item["department_id"]
            for g in item["groups"]:
                c.execute(
                    "INSERT INTO groups(id,department_id,label,updated_at) VALUES(?,?,?,?) "
                    "ON CONFLICT(id) DO UPDATE SET department_id=excluded.department_id,label=excluded.label,updated_at=excluded.updated_at",
                    (g["value"], dep, g["label"], ts),
                )


def catalog() -> dict:
    with conn() as c:
        deps = [dict(r) for r in c.execute("SELECT id,label FROM departments ORDER BY label")]
        groups = [dict(r) for r in c.execute("SELECT id,department_id,label FROM groups ORDER BY label")]
    by: dict[str, list[dict]] = {}
    for g in groups:
        by.setdefault(g["department_id"], []).append(g)
    return {"departments": [{"id": d["id"], "label": d["label"], "groups": by.get(d["id"], [])} for d in deps]}


def touch_interest(group_id: str, department_id: str) -> None:
    with conn() as c:
        c.execute(
            "INSERT INTO interests(group_id,department_id,last_seen_at) VALUES(?,?,?) "
            "ON CONFLICT(group_id) DO UPDATE SET department_id=excluded.department_id,last_seen_at=excluded.last_seen_at",
            (group_id, department_id, now_iso()),
        )


def active_interests() -> list[dict]:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=INTEREST_TTL_DAYS)).isoformat()
    with conn() as c:
        rows = c.execute(
            """
            SELECT i.group_id,i.department_id,g.label
            FROM interests i LEFT JOIN groups g ON g.id=i.group_id
            WHERE i.last_seen_at>=?
            UNION
            SELECT DISTINCT p.group_id,g.department_id,g.label
            FROM push_subscriptions p JOIN groups g ON g.id=p.group_id
            WHERE p.active=1
            """,
            (cutoff,),
        ).fetchall()
    return [dict(r) for r in rows]


def latest_snapshot(group_id: str) -> dict | None:
    with conn() as c:
        r = c.execute("SELECT payload FROM snapshots WHERE group_id=? ORDER BY id DESC LIMIT 1", (group_id,)).fetchone()
    return json.loads(r["payload"]) if r else None


def save_snapshot(group_id: str, payload: dict) -> bool:
    """Persist only a changed timetable payload.

    Successful refresh time belongs in sync_state; storing an identical full JSON
    snapshot every five minutes would grow the production database for no benefit.
    Returns True when a new snapshot row was written.
    """
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    h = hashlib.sha256(raw.encode()).hexdigest()
    with conn() as c:
        latest = c.execute(
            "SELECT payload_hash FROM snapshots WHERE group_id=? ORDER BY id DESC LIMIT 1",
            (group_id,),
        ).fetchone()
        if latest and latest["payload_hash"] == h:
            return False
        c.execute(
            "INSERT INTO snapshots(group_id,fetched_at,payload,payload_hash) VALUES(?,?,?,?)",
            (group_id, now_iso(), raw, h),
        )
    return True


def save_changes(group_id: str, changes: list[dict]) -> list[dict]:
    saved: list[dict] = []
    with conn() as c:
        for ch in changes:
            raw = json.dumps(ch, ensure_ascii=False, sort_keys=True, default=str)
            dh = hashlib.sha256((group_id + "|" + raw).encode()).hexdigest()
            try:
                c.execute(
                    "INSERT INTO changes(group_id,detected_at,change_type,module,activity,day,before_json,after_json,dedupe_hash) "
                    "VALUES(?,?,?,?,?,?,?,?,?)",
                    (
                        group_id,
                        ch.get("detected_at") or now_iso(),
                        ch["change_type"],
                        ch.get("module"),
                        ch.get("activity"),
                        ch.get("day"),
                        json.dumps(ch.get("before"), ensure_ascii=False, default=str),
                        json.dumps(ch.get("after"), ensure_ascii=False, default=str),
                        dh,
                    ),
                )
                saved.append(ch)
            except sqlite3.IntegrityError:
                pass
    return saved


def get_changes(group_id: str, limit: int = 50) -> list[dict]:
    with conn() as c:
        rows = c.execute("SELECT * FROM changes WHERE group_id=? ORDER BY id DESC LIMIT ?", (group_id, limit)).fetchall()
    out = []
    for row in rows:
        d = dict(row)
        d["before"] = json.loads(d.pop("before_json") or "null")
        d["after"] = json.loads(d.pop("after_json") or "null")
        d.pop("dedupe_hash", None)
        out.append(d)
    return out


def set_sync_state(group_id: str, status: str, error: str | None = None, success: bool = False) -> None:
    ts = now_iso()
    with conn() as c:
        c.execute(
            "INSERT INTO sync_state(group_id,last_attempt_at,last_success_at,status,error) VALUES(?,?,?,?,?) "
            "ON CONFLICT(group_id) DO UPDATE SET "
            "last_attempt_at=excluded.last_attempt_at, "
            "last_success_at=CASE WHEN ? THEN excluded.last_attempt_at ELSE sync_state.last_success_at END, "
            "status=excluded.status,error=excluded.error",
            (group_id, ts, ts if success else None, status, error, 1 if success else 0),
        )


def get_sync_state(group_id: str) -> dict:
    with conn() as c:
        r = c.execute("SELECT * FROM sync_state WHERE group_id=?", (group_id,)).fetchone()
    return dict(r) if r else {"group_id": group_id, "status": "never-synced", "last_attempt_at": None, "last_success_at": None, "error": None}


def upsert_subscription(group_id: str, endpoint: str, p256dh: str, auth: str, hidden_modules: list[str] | None = None) -> None:
    hidden = json.dumps(sorted(set(hidden_modules or [])), ensure_ascii=False)
    with conn() as c:
        c.execute(
            "INSERT INTO push_subscriptions(endpoint,group_id,p256dh,auth,created_at,active,hidden_modules) VALUES(?,?,?,?,?,1,?) "
            "ON CONFLICT(endpoint) DO UPDATE SET group_id=excluded.group_id,p256dh=excluded.p256dh,auth=excluded.auth,active=1,hidden_modules=excluded.hidden_modules",
            (endpoint, group_id, p256dh, auth, now_iso(), hidden),
        )


def subscriptions(group_id: str) -> list[dict]:
    with conn() as c:
        rows = c.execute("SELECT endpoint,p256dh,auth,hidden_modules FROM push_subscriptions WHERE group_id=? AND active=1", (group_id,)).fetchall()
    out = []
    for row in rows:
        d = dict(row)
        try:
            d["hidden_modules"] = json.loads(d.get("hidden_modules") or "[]")
        except Exception:
            d["hidden_modules"] = []
        out.append(d)
    return out

def deactivate_subscription(endpoint: str) -> None:
    with conn() as c:
        c.execute("UPDATE push_subscriptions SET active=0 WHERE endpoint=?", (endpoint,))


def group_exists(group_id: str, department_id: str | None = None) -> bool:
    with conn() as c:
        if department_id is None:
            r = c.execute("SELECT 1 FROM groups WHERE id=? LIMIT 1", (group_id,)).fetchone()
        else:
            r = c.execute("SELECT 1 FROM groups WHERE id=? AND department_id=? LIMIT 1", (group_id, department_id)).fetchone()
    return r is not None


def get_subscription(endpoint: str) -> dict | None:
    with conn() as c:
        r = c.execute(
            "SELECT endpoint,group_id,p256dh,auth,hidden_modules,active FROM push_subscriptions WHERE endpoint=? LIMIT 1",
            (endpoint,),
        ).fetchone()
    if not r:
        return None
    d = dict(r)
    try:
        d["hidden_modules"] = json.loads(d.get("hidden_modules") or "[]")
    except Exception:
        d["hidden_modules"] = []
    return d
