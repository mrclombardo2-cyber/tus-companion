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
CREATE INDEX IF NOT EXISTS idx_groups_department ON groups(department_id, label);

CREATE TABLE IF NOT EXISTS interests(
  group_id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interests_seen ON interests(last_seen_at);

CREATE TABLE IF NOT EXISTS latest_snapshots(
  group_id TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL
);

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
CREATE INDEX IF NOT EXISTS idx_changes_group ON changes(group_id, id DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions(
  endpoint TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  hidden_modules TEXT NOT NULL DEFAULT '[]',
  reminder_minutes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_group ON push_subscriptions(group_id, active);
CREATE INDEX IF NOT EXISTS idx_push_reminders ON push_subscriptions(active, reminder_minutes);

CREATE TABLE IF NOT EXISTS reminder_deliveries(
  endpoint TEXT NOT NULL,
  event_key TEXT NOT NULL,
  lead_minutes INTEGER NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY(endpoint, event_key, lead_minutes)
);
CREATE INDEX IF NOT EXISTS idx_reminder_deliveries_sent ON reminder_deliveries(sent_at);

CREATE TABLE IF NOT EXISTS sync_state(
  group_id TEXT PRIMARY KEY,
  last_attempt_at TEXT,
  last_success_at TEXT,
  status TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The TUS source session is stored only as AES-GCM ciphertext. The encryption
-- key lives in GitHub Actions Secrets and is never stored in Cloudflare/D1.
CREATE TABLE IF NOT EXISTS source_session(
  id INTEGER PRIMARY KEY CHECK(id=1),
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
