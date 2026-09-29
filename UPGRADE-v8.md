# Upgrade v7 → v8

- Removes the alarming transient refresh banner while a valid snapshot is available.
- Keeps `Updated …` in the header; only warns when the last successful timetable is over two hours old.
- Retries transient failed refreshes after 60 seconds while the app is being viewed. Session-expiry errors still require admin reconnect.
- Today hero now shows `NEXT CLASS (WEEKDAY)`; an active class shows `HAPPENING NOW (WEEKDAY)`.
- PWA cache bumped to v8.
