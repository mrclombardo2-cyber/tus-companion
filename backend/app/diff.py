from __future__ import annotations
from collections import defaultdict
from .models import TimetableEvent, TimetableSnapshot, TimetableChange


def stable_key(e: TimetableEvent) -> tuple:
    # Deliberately excludes room, staff, start and end so those fields can change
    # without turning one class into a spurious remove+add pair.
    return (
        e.day.lower(),
        e.module.strip().lower(),
        e.activity.strip().lower(),
        tuple(sorted(g.lower() for g in e.student_groups)),
    )


def _time_minutes(value: str) -> int:
    h, m = [int(x) for x in value.split(":")]
    return h * 60 + m


def _pair(before: list[TimetableEvent], after: list[TimetableEvent]):
    # Pair duplicates by closest start time.
    remaining = after[:]
    pairs = []
    for b in before:
        if not remaining:
            pairs.append((b, None))
            continue
        a = min(remaining, key=lambda x: abs(_time_minutes(x.start) - _time_minutes(b.start)))
        remaining.remove(a)
        pairs.append((b, a))
    pairs.extend((None, a) for a in remaining)
    return pairs


def diff_snapshots(before: TimetableSnapshot, after: TimetableSnapshot) -> list[TimetableChange]:
    bmap: dict[tuple, list[TimetableEvent]] = defaultdict(list)
    amap: dict[tuple, list[TimetableEvent]] = defaultdict(list)
    for e in before.events:
        bmap[stable_key(e)].append(e)
    for e in after.events:
        amap[stable_key(e)].append(e)

    changes: list[TimetableChange] = []
    for key in sorted(set(bmap) | set(amap), key=str):
        for b, a in _pair(bmap.get(key, []), amap.get(key, [])):
            exemplar = a or b
            assert exemplar is not None
            base = dict(module=exemplar.module, activity=exemplar.activity, day=exemplar.day)
            if b is None:
                changes.append(TimetableChange(change_type="CLASS_ADDED", before=None, after=a, **base))
                continue
            if a is None:
                changes.append(TimetableChange(change_type="CLASS_REMOVED", before=b, after=None, **base))
                continue
            if (b.start, b.end) != (a.start, a.end):
                changes.append(TimetableChange(change_type="TIME_CHANGED", before=b, after=a, **base))
            if (b.room_code or b.room_raw) != (a.room_code or a.room_raw):
                changes.append(TimetableChange(change_type="ROOM_CHANGED", before=b, after=a, **base))
            if b.staff.strip().casefold() != a.staff.strip().casefold():
                changes.append(TimetableChange(change_type="LECTURER_CHANGED", before=b, after=a, **base))
            if b.type.strip().casefold() != a.type.strip().casefold():
                changes.append(TimetableChange(change_type="CLASS_TYPE_CHANGED", before=b, after=a, **base))
            if b.weeks_raw.strip().casefold() != a.weeks_raw.strip().casefold():
                changes.append(TimetableChange(change_type="TEACHING_WEEKS_CHANGED", before=b, after=a, **base))
    return changes
