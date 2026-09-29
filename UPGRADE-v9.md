# v9 update

- Week is now a real, compact Monday–Friday timetable grid instead of stacked day cards.
- The class happening now is highlighted directly in the weekly grid.
- Week respects the user's 24-hour / AM-PM preference.
- Student-facing stale/sync-delay warnings were removed. When a valid snapshot exists, the app keeps showing it and only displays the last successful `Updated` time in the header.
- Transient Scientia fetches are retried once automatically before a group refresh is marked failed.
- PWA cache bumped to v9.

The backend still records refresh failures for diagnostics/admin use. If the central Microsoft/TUS session itself expires, an administrator must reconnect it; that infrastructure condition is intentionally not shown as a technical warning over an already-valid student timetable.
