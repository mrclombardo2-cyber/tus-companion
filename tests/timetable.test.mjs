import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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


test("scheduler keeps recently viewed groups ahead of stale background interests", () => {
  const source = readFileSync(new URL("../cloud/worker/src/index.js", import.meta.url), "utf8");
  assert.match(source, /const INTEREST_TTL_HOURS = 6;/);
  assert.match(source, /const INTEREST_TOUCH_MINUTES = 15;/);
  assert.match(source, /const QUEUED_STALE_MINUTES = 2;/);
  assert.match(source, /WHEN i\.last_seen_at >= \? THEN 0 WHEN COALESCE\(p\.has_push,0\)=1 THEN 1 ELSE 2/);
});
