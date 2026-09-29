from __future__ import annotations
from datetime import date as Date, datetime, timezone
from typing import Literal
from pydantic import BaseModel, Field

class TimetableEvent(BaseModel):
    day: str
    date: Date | None = None
    activity: str
    module: str
    type: str
    start: str
    end: str
    duration: str
    weeks_raw: str
    weeks: list[int] = Field(default_factory=list)
    room_raw: str
    room_code: str | None = None
    room_name: str | None = None
    staff: str
    student_groups: list[str] = Field(default_factory=list)

class TimetableSnapshot(BaseModel):
    student_group: str
    group_id: str | None = None
    department_id: str | None = None
    week_number: int | None = None
    week_start: Date | None = None
    week_end: Date | None = None
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    events: list[TimetableEvent] = Field(default_factory=list)

ChangeType = Literal[
    "ROOM_CHANGED", "TIME_CHANGED", "CLASS_ADDED", "CLASS_REMOVED", "LECTURER_CHANGED",
    "CLASS_TYPE_CHANGED", "TEACHING_WEEKS_CHANGED"
]

class TimetableChange(BaseModel):
    change_type: ChangeType
    module: str
    activity: str
    day: str
    before: TimetableEvent | None = None
    after: TimetableEvent | None = None
    detected_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
