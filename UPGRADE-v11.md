# Upgrade v10 → v11

## Mobile Week redesign

- Phones no longer render the five-day desktop grid or require horizontal timetable scrolling.
- Week uses five large day selectors and a readable single-day schedule on screens up to 760px.
- Each class is a large touch target; tapping the class opens directions when a room exists.
- Current class remains highlighted with `NOW`.
- 24-hour / AM-PM preferences continue to apply.
- Subject colours remain deterministic across every department and course.
- Subject border accents are slightly stronger for faster visual scanning.
- Desktop/tablet-wide Week keeps the full five-day grid.

The patch changes only frontend/release files and does not overwrite TUS session state, database, Python environment, push secrets, or `config.ps1`.
