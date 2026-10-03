import test from "node:test";
import assert from "node:assert/strict";
import { compactWeekSnapshot } from "../cloud/worker/src/timetable.js";

test("compactWeekSnapshot keeps only week metadata and events", () => {
  const input = {
    student_group: "G1",
    group_id: "g1",
    department_id: "d1",
    week_number: 41,
    week_start: "2026-10-05",
    week_end: "2026-10-11",
    fetched_at: "2026-10-03T18:00:00.000Z",
    events: [{ module: "IT & Computer Applications 2", start: "09:00" }],
    future_weeks: [{ should: "not leak" }],
  };
  assert.deepEqual(compactWeekSnapshot(input), {
    week_number: 41,
    week_start: "2026-10-05",
    week_end: "2026-10-11",
    fetched_at: "2026-10-03T18:00:00.000Z",
    events: [{ module: "IT & Computer Applications 2", start: "09:00" }],
  });
});

test("compactWeekSnapshot handles null and missing arrays safely", () => {
  assert.equal(compactWeekSnapshot(null), null);
  const out = compactWeekSnapshot({ week_number: 42 }, "2026-10-03T18:30:00.000Z");
  assert.equal(out.week_number, 42);
  assert.equal(out.fetched_at, "2026-10-03T18:30:00.000Z");
  assert.deepEqual(out.events, []);
});
