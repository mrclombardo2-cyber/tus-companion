ALTER TABLE push_subscriptions
ADD COLUMN reminder_minutes INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_push_reminders
ON push_subscriptions(active, reminder_minutes);

CREATE TABLE IF NOT EXISTS reminder_deliveries(
  endpoint TEXT NOT NULL,
  event_key TEXT NOT NULL,
  lead_minutes INTEGER NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY(endpoint, event_key, lead_minutes)
);

CREATE INDEX IF NOT EXISTS idx_reminder_deliveries_sent
ON reminder_deliveries(sent_at);
