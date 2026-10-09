import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compactWeekSnapshot, diffSnapshots, enrichChanges, suppressTransientReversals, validateSnapshotForGroup } from "../cloud/worker/src/timetable.js";
import { timetableOutputGroup } from "../cloud/worker/src/scientia.js";

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


test("source-session expiry triggers immediate bounded recovery", () => {
  const source = readFileSync(new URL("../cloud/worker/src/index.js", import.meta.url), "utf8");
  assert.match(source, /const SOURCE_BROWSER_RECOVERY_MINUTES = 1;/);
  assert.match(source, /recovery = await maybeRecoverSourceSession\(env\)/);
  assert.match(source, /delaySeconds: recovery\.recovered \? 5 : 60/);
});


test("scheduler keeps queue jobs small for responsive first loads", () => {
  const source = readFileSync(new URL("../cloud/worker/src/index.js", import.meta.url), "utf8");
  assert.match(source, /const GROUPS_PER_QUEUE_JOB = 1;/);
});


test("valid empty weeks are not rejected by the worker sync path", () => {
  const source = readFileSync(new URL("../cloud/worker/src/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /empty-timetable-response/);
});


test("all timetable source access is serialized through one queue", () => {
  const worker = readFileSync(new URL("../cloud/worker/src/index.js", import.meta.url), "utf8");
  const wrangler = readFileSync(new URL("../cloud/worker/wrangler.toml", import.meta.url), "utf8");
  assert.match(worker, /const queue = env\.SYNC_QUEUE;/);
  assert.doesNotMatch(worker, /PRIORITY_QUEUE/);
  assert.doesNotMatch(wrangler, /PRIORITY_QUEUE/);
  assert.equal((wrangler.match(/\[\[queues\.consumers\]\]/g) || []).length, 1);
});


test("snapshot validation rejects cross-group source races but allows an empty valid week", () => {
  const valid = {
    student_group: "AL_BBSTD_C_2 B",
    week_number: 41,
    week_start: "2026-10-05",
    week_end: "2026-10-11",
    events: [],
  };
  assert.equal(validateSnapshotForGroup(valid, "AL_BBSTD_C_2 B"), valid);
  assert.throws(() => validateSnapshotForGroup({ ...valid, student_group: "AL_OTHER_1 A" }, "AL_BBSTD_C_2 B"), /timetable-group-mismatch/);
});

test("week rollover never generates timetable change notifications", () => {
  const before = {
    week_number: 41, week_start: "2026-10-05",
    events: [{ day:"Monday", module:"A", activity:"Lecture", student_groups:["G"], start:"09:00", end:"10:00" }],
  };
  const after = {
    week_number: 42, week_start: "2026-10-12",
    events: [{ day:"Monday", module:"B", activity:"Lecture", student_groups:["G"], start:"11:00", end:"12:00" }],
  };
  assert.deepEqual(diffSnapshots(before, after), []);
});

test("change dedupe hash ignores detection timestamp", async () => {
  const base = {
    change_type:"CLASS_ADDED", module:"A", activity:"Lecture", day:"Monday", before:null,
    after:{ day:"Monday", module:"A", activity:"Lecture", start:"09:00", end:"10:00" },
  };
  const [a] = await enrichChanges("G1", [{ ...base, detected_at:"2026-10-09T15:36:00.000Z" }]);
  const [b] = await enrichChanges("G1", [{ ...base, detected_at:"2026-10-09T15:38:00.000Z" }]);
  assert.equal(a.dedupe_hash, b.dedupe_hash);
});

test("short-lived add/remove reversals are suppressed from the Changes feed", () => {
  const event = { day:"Wednesday", module:"Management Accounting", activity:"Lecture", start:"15:00", end:"16:00" };
  const rows = [
    { id:1, detected_at:"2026-10-09T15:36:00.000Z", change_type:"CLASS_ADDED", before:null, after:event },
    { id:2, detected_at:"2026-10-09T15:37:00.000Z", change_type:"CLASS_REMOVED", before:event, after:null },
    { id:3, detected_at:"2026-10-09T15:40:00.000Z", change_type:"ROOM_CHANGED", before:{...event,room_code:"C74"}, after:{...event,room_code:"C75"} },
  ];
  const out = suppressTransientReversals(rows);
  assert.deepEqual(out.map((x) => x.id), [3]);
});

test("worker confirms changed snapshots before saving or pushing them", () => {
  const source = readFileSync(new URL("../cloud/worker/src/index.js", import.meta.url), "utf8");
  assert.match(source, /confirmChangedSnapshot/);
  assert.match(source, /secondHash === thirdHash/);
  assert.match(source, /unstable-timetable-source/);
});


test("Scientia output group is extracted and verified before snapshots can be saved", () => {
  const html = "<div>Student Set TextSpreadsheet Student Group: AL_BBSTD_C_2 B Weeks selected for output: 41 (5 Oct 2026 - 11 Oct 2026)</div>";
  assert.equal(timetableOutputGroup(html), "AL_BBSTD_C_2 B");
  const source = readFileSync(new URL("../cloud/worker/src/scientia.js", import.meta.url), "utf8");
  assert.match(source, /postback\(html, "dlObject"/);
  assert.match(source, /timetableMatchesGroup\(timetable, group\)/);
  assert.match(source, /attempt < 3/);
});


test("rejected transient timetable snapshots retry quickly", () => {
  const source = readFileSync(new URL("../cloud/worker/src/index.js", import.meta.url), "utf8");
  assert.match(source, /timetable-group-mismatch\|unstable-timetable-source/);
  assert.match(source, /delaySeconds: 10/);
});
