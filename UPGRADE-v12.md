# Upgrade v11 → v12 — production cadence and scale

- Source polling is explicitly 24/7; there is no evening or overnight quiet window.
- Default source interval remains 300 seconds (5 minutes).
- Scheduler is now start-to-start: batch duration is deducted from the five-minute cadence instead of adding five minutes after every batch.
- `/health` exposes scheduler heartbeat/cycle duration/group/error counts for deployment monitoring.
- Windows `run.ps1` prevents system sleep while the collector is running (display may still turn off).
- SQLite uses WAL + busy timeout and identical timetable snapshots are no longer duplicated every five minutes.
- Web Push sends concurrently with a configurable worker pool so large groups do not block the source collector.
- Any group in the TUS catalog can be selected; unused groups are not polled. A newly selected group gets an immediate first sync, then joins the five-minute 24/7 cycle.
- PWA cache bumped to v12.
