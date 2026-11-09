import { groupTimetableChanges, eventMatchesAfter, matchingChangesForEvent, teachingWeeksLabel, currentChangeBadge } from "../frontend/change-utils.js";
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
  assert.match(source, /const SOURCE_BROWSER_RECOVERY_MINUTES = 5;/);
  assert.match(source, /const SOURCE_MANUAL_RETRY_HOURS = 6;/);
  assert.match(source, /browserManualLoginDetected/);
  assert.match(source, /source_browser_manual_required_at", ""/);
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


test("snapshot validation matches compact catalog IDs to full TUS group labels", () => {
  const valid = {
    student_group: "Al_Bbstd_C_2 Higher Certificate In Business B (Sem1)",
    week_number: 41,
    week_start: "2026-10-05",
    week_end: "2026-10-11",
    events: [{
      day:"Monday", date:"2026-10-05", module:"Management Accounting", start:"09:00", end:"10:00",
      student_groups:["AL_BBSTD_C_2 Higher Certificate in Business A","AL_BBSTD_C_2 Higher Certificate in Business B (Sem1)"],
    }],
  };
  assert.equal(validateSnapshotForGroup(valid, "AL_BBSTD_C_2 B"), valid);
  const empty = { ...valid, events: [] };
  assert.equal(validateSnapshotForGroup(empty, "AL_BBSTD_C_2 B"), empty);
  const wrong = { ...valid, student_group:"Al_Bbstd_C_2 Higher Certificate In Business A" };
  assert.throws(() => validateSnapshotForGroup(wrong, "AL_BBSTD_C_2 B"), /timetable-group-mismatch/);
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


test("Scientia forces group selection and worker retries row-level validation", () => {
  const html = "<div>Student Set TextSpreadsheet Student Group: AL_BBSTD_C_2 B Weeks selected for output: 41 (5 Oct 2026 - 11 Oct 2026)</div>";
  assert.equal(timetableOutputGroup(html), "AL_BBSTD_C_2 B");
  const scientia = readFileSync(new URL("../cloud/worker/src/scientia.js", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../cloud/worker/src/index.js", import.meta.url), "utf8");
  assert.match(scientia, /postback\(html, "dlObject"/);
  assert.match(worker, /attempt < 3/);
  assert.match(worker, /validateSnapshotForGroup\(snapshot, groupId\)/);
});


test("rejected transient timetable snapshots retry quickly", () => {
  const source = readFileSync(new URL("../cloud/worker/src/index.js", import.meta.url), "utf8");
  assert.match(source, /timetable-group-mismatch\|unstable-timetable-source/);
  assert.match(source, /delaySeconds: 10/);
});


test("Cloudflare cron keeps the authenticated timetable source warm", () => {
  const source = readFileSync(new URL("../cloud/worker/src/index.js", import.meta.url), "utf8");
  assert.match(source, /const SOURCE_HTTP_KEEPALIVE_MINUTES = 8;/);
  assert.match(source, /async function keepSourceSessionWarm\(env\)/);
  assert.match(source, /await session\.ensureReady\(\)/);
  assert.match(source, /await saveSourceStorageState\(env, session\.storageState\(\)\)/);
  assert.match(source, /await keepSourceSessionWarm\(env\);/);
});

test("app shell responses are explicitly no-store at the Worker edge", () => {
  const source = readFileSync(new URL("../cloud/worker/src/index.js", import.meta.url), "utf8");
  assert.match(source, /"\/app\.js","\/styles\.css","\/manifest\.webmanifest"/);
  assert.match(source, /cache-control", "no-store, max-age=0, must-revalidate"/);
  assert.match(source, /service-worker-allowed", "\/"/);
});

test("portable recovery never needs cloud config or hard-coded credentials", () => {
  const launcher = readFileSync(new URL("../RECOVER-TUS-PORTABLE.ps1", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../.github/workflows/recover-tus-from-browser.yml", import.meta.url), "utf8");
  const uploader = readFileSync(new URL("../cloud/collector/recover_from_actions_secret.py", import.meta.url), "utf8");
  assert.match(launcher, /secret set TUS_RECOVERY_STATE_B64/);
  assert.match(launcher, /secret delete TUS_RECOVERY_STATE_B64/);
  assert.match(launcher, /app\.cli login/);
  assert.doesNotMatch(launcher, /\.cloud\.local\.json/);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /secrets\.TUS_RECOVERY_STATE_B64/);
  assert.match(workflow, /secrets\.CLOUD_ADMIN_TOKEN/);
  assert.match(uploader, /--upload-local-session/);
  assert.match(uploader, /STATE_FILE\.unlink/);
});

test("interactive browser login prints redacted stages and prevents gateway click loops", () => {
  const source = readFileSync(new URL("../backend/app/collector/playwright_collector.py", import.meta.url), "utf8");
  assert.match(source, /def _login_stage\(page: Page\)/);
  assert.match(source, /\[TUS login\] Browser stage:/);
  assert.match(source, /LOGIN_GATEWAY_RETRY_SECONDS = 60/);
  assert.match(source, /if not microsoft_open:/);
  assert.match(source, /urlparse\(page\.url\)\.hostname/);
  assert.doesNotMatch(source, /print\(page\.url\)/);
  assert.match(source, /link\.click\(timeout=min\(timeout_ms, 10_000\)\)/);
  const openStudentSet = source.split("def _open_student_set_by_name")[1].split("def _try_silent_reauth")[0];
  assert.doesNotMatch(openStudentSet, /with page\.expect_navigation\(/);
});

test("cloud session updates cannot overwrite a newer authentication state", () => {
  const worker = readFileSync(new URL("../cloud/worker/src/index.js", import.meta.url), "utf8");
  const load = worker.split("async function loadSourceStorageState(env)")[1].split("async function browserPageReady")[0];
  assert.match(load, /SELECT ciphertext,nonce,updated_at FROM source_session/);
  assert.match(load, /__tusSourceRevision/);
  assert.match(load, /UPDATE source_session SET ciphertext=\?,nonce=\?,updated_at=\? WHERE id=1 AND updated_at=\?/);
  assert.match(load, /if \(!saved\.meta\?\.changes\) return false/);
  assert.match(load, /delete|__tusSourceRevision: _revision/);
  const queue = worker.split("async function runGroupJob(env, groups)")[1].split("async function recordCycle")[0];
  assert.match(queue, /source-session-superseded/);
  assert.match(worker, /message\.retry\(\{ delaySeconds: 5 \}\)/);
});

test("source keepalive attempts continue while interactive browser recovery is throttled", () => {
  const worker = readFileSync(new URL("../cloud/worker/src/index.js", import.meta.url), "utf8");
  const keepalive = worker.split("async function keepSourceSessionWarm(env)")[1].split("async function maybeRecoverSourceSession(env)")[0];
  assert.match(keepalive, /await session\.ensureReady\(\)/);
  assert.doesNotMatch(keepalive, /manualRequired && ageMs\(manualRequired\)/);
  const browser = worker.split("async function maybeRecoverSourceSession(env)")[1].split("function pushChangeSummary")[0];
  assert.match(browser, /SOURCE_MANUAL_RETRY_HOURS/);
});

test("health makes failed source and scheduler visible without relying on HTTP errors", () => {
  const worker = readFileSync(new URL("../cloud/worker/src/index.js", import.meta.url), "utf8");
  assert.match(worker, /status: degraded \? "degraded" : "ok"/);
  assert.match(worker, /recovery_action:/);
  assert.match(worker, /check-group-sync-queue/);
});

test("Microsoft delegated login is optional and never uses unapproved Microsoft Graph tokens", () => {
  const auth=readFileSync(new URL("../cloud/worker/src/entra-delegation.js",import.meta.url),"utf8");
  const transport=readFileSync(new URL("../cloud/worker/src/scientia.js",import.meta.url),"utf8");
  const worker=readFileSync(new URL("../cloud/worker/src/index.js",import.meta.url),"utf8");
  assert.match(auth,/TUS_ENTRA_TENANT_ID/);
  assert.match(auth,/TUS_ENTRA_OPERATOR_OID/);
  assert.match(auth,/TUS_ENTRA_PROXY_SCOPE/);
  assert.match(auth,/user_impersonation/);
  assert.match(auth,/!\/graph\\\.microsoft\\\.com\/i\.test\(scope\)/);
  assert.match(auth,/code_challenge_method:"S256"/);
  assert.match(auth,/HttpOnly; Secure; SameSite=Lax/);
  assert.match(auth,/jwtVerify\(data\.id_token/);
  assert.match(auth,/payload\.oid/);
  assert.match(auth,/nonce/);
  assert.match(auth,/additionalData:AAD/);
  assert.match(auth,/refresh_token/);
  assert.match(auth,/probe\.ensureReady\(\)/);
  assert.match(auth,/WHERE id=1 AND revision=\?/);
  assert.match(transport,/new URL\(url\)\.hostname\.toLowerCase\(\) === TUS_HOST/);
  assert.match(worker,/delegationReadiness\(env\)\.configured/);
  assert.match(worker,/\/api\/entraid\/connect/);
  assert.match(worker,/\/api\/entraid\/callback/);
  assert.match(worker,/new ScientiaSession\(\{cookies:\[\],origins:\[\]\}, fetch, bearer\)/);
});

test("portable PowerShell recovery enumerates workflow runs before parsing timestamps", () => {
  const script = readFileSync(new URL("../RECOVER-TUS-PORTABLE.ps1", import.meta.url), "utf8");
  // Windows PowerShell ConvertFrom-Json may expose JSON arrays as one Object[].
  // Do not cast a projected property array to [DateTime] inside Where-Object.
  assert.doesNotMatch(script, /\[DateTime\]\$_\.createdAt/);
  assert.match(script, /ConvertFrom-Json -InputObject/);
  assert.match(script, /foreach \(\$RunGroup in @\(\$ParsedRuns\)\)/);
  assert.match(script, /foreach \(\$Run in @\(\$RunGroup\)\)/);
  assert.match(script, /\[DateTimeOffset\]::TryParse\(\[string\]\$Run\.createdAt, \[ref\]\$CreatedAt\)/);
  assert.match(script, /& \$GhExe run watch \$RunId --repo \$Repository --exit-status/);
  assert.match(script, /& \$GhExe secret delete TUS_RECOVERY_STATE_B64 --repo \$Repository/);
});

test("one Business Law change card groups room and teaching-week edits from the same source update", () => {
  const before = {
    module:"Business Law",activity:"Business law lecture",day:"Wednesday",date:"2026-11-11",
    start:"13:00",end:"14:00",room_code:"B11",room_raw:"B11",
    weeks_raw:"4-15",staff:"Lecturer",type:"Lecture",student_groups:["G1"],
  };
  const after = {...before,room_code:"C1164",room_raw:"C1164",weeks_raw:"13"};
  const detected_at="2026-11-09T09:19:00.000Z";
  const changes = [
    {change_type:"ROOM_CHANGED",module:before.module,activity:before.activity,day:before.day,detected_at,before,after},
    {change_type:"TEACHING_WEEKS_CHANGED",module:before.module,activity:before.activity,day:before.day,detected_at,before,after},
  ];
  const grouped=groupTimetableChanges(changes);
  assert.equal(grouped.length,1);
  assert.deepEqual(grouped[0].changes.map(c=>c.change_type),["ROOM_CHANGED","TEACHING_WEEKS_CHANGED"]);
  assert.equal(matchingChangesForEvent(after,changes)?.changes.length,2);
  assert.equal(currentChangeBadge(grouped[0]),"Changed");
  assert.equal(teachingWeeksLabel("4-15"),"weeks 4–15");
  assert.equal(teachingWeeksLabel("13"),"week 13");
  assert.deepEqual(before,{...after,room_code:"B11",room_raw:"B11",weeks_raw:"4-15"});
});
test("old changes cannot modify Week or badge classes whose current source snapshot differs",()=>{
  const before={module:"Business Law",activity:"Lecture",day:"Wednesday",date:"2026-11-11",
    start:"13:00",end:"14:00",room_code:"B11",weeks_raw:"4-15",
    staff:"Teacher",type:"Lecture",student_groups:["G1"]};
  const after={...before,room_code:"C1164",weeks_raw:"13"};
  const change={change_type:"ROOM_CHANGED",module:"Business Law",activity:"Lecture",day:"Wednesday",
    detected_at:"2026-11-09T09:19:00Z",before,after};
  assert.equal(eventMatchesAfter(after,after),true);
  assert.equal(eventMatchesAfter(before,after),false);
  assert.equal(matchingChangesForEvent(before,[change]),null);
  assert.equal(matchingChangesForEvent({...after,date:"2026-11-18"},[change]),null);
  assert.equal(matchingChangesForEvent({...after,start:"15:00"},[change]),null);
  assert.equal(matchingChangesForEvent({...after,room_code:"A12"},[change]),null);
  assert.equal(currentChangeBadge(groupTimetableChanges([change])[0]),"New room");
});
