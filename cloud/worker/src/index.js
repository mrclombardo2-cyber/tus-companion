import webpush from "web-push";
import { launch } from "@cloudflare/playwright";
import { ScientiaSession, TUS_BASE_URL } from "./scientia.js";
import { parseTextSpreadsheet, diffSnapshots, snapshotContentHash, enrichChanges } from "./timetable.js";

const APP_VERSION = "1.8.8-cloud";
const LEGAL_VERSION = "2026-09-30";
const INTEREST_TTL_DAYS = 30;
const INTEREST_TOUCH_MINUTES = 60;
const CATALOG_REFRESH_HOURS = 24;
const GROUP_SYNC_MIN_SECONDS = 50;
const QUEUED_STALE_MINUTES = 5;
const GROUPS_PER_QUEUE_JOB = 7;
const MAX_SCHEDULED_QUEUE_MESSAGES = 1;
const PRELOAD_GROUPS_PER_CYCLE = 1;
const PRELOAD_ERROR_RETRY_HOURS = 6;
const PUSH_SUBSCRIPTIONS_PER_JOB = 40;
const REMINDER_SUBSCRIPTIONS_PER_JOB = 40;
const REMINDER_WINDOW_MINUTES = 3;
const SOURCE_BROWSER_RECOVERY_MINUTES = 10;
const SOURCE_BROWSER_RECOVERY_TIMEOUT_MS = 45_000;
const NEXT_WEEK_REFRESH_MINUTES = 10;
const MAP_URL = "https://app.mappedin.com/map/68b1b5dd74254a000bbf174b";
const SESSION_AAD = new TextEncoder().encode("tus-companion-source-session-v1");

function nowIso() { return new Date().toISOString(); }

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });
}

function apiError(status, detail) { return json({ detail }, status); }

async function bodyJson(request, maxBytes = 65536) {
  const length = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > maxBytes) throw new Error("payload-too-large");
  const text = await request.text();
  if (text.length > maxBytes) throw new Error("payload-too-large");
  try { return JSON.parse(text); } catch { throw new Error("invalid-json"); }
}

function adminAuthorized(request, env) {
  const token = request.headers.get("x-admin-token") || "";
  return Boolean(env.ADMIN_TOKEN && token && token === env.ADMIN_TOKEN);
}

function safeParse(value, fallback = null) {
  if (value == null || value === "") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function parseHidden(value) {
  const parsed = safeParse(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

let reminderSchemaReady = false;
let reminderSchemaPromise = null;

async function ensureReminderSchema(env) {
  if (reminderSchemaReady) return;
  if (reminderSchemaPromise) return reminderSchemaPromise;
  reminderSchemaPromise = (async () => {
    try {
      await env.DB.prepare("ALTER TABLE push_subscriptions ADD COLUMN reminder_minutes INTEGER NOT NULL DEFAULT 0").run();
    } catch (err) {
      const message = String(err?.message || err);
      if (!/duplicate column|already exists/i.test(message)) throw err;
    }
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_push_reminders ON push_subscriptions(active, reminder_minutes)").run();
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS reminder_deliveries(" +
      "endpoint TEXT NOT NULL,event_key TEXT NOT NULL,lead_minutes INTEGER NOT NULL,sent_at TEXT NOT NULL," +
      "PRIMARY KEY(endpoint,event_key,lead_minutes))",
    ).run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_reminder_deliveries_sent ON reminder_deliveries(sent_at)").run();
    reminderSchemaReady = true;
  })();
  try {
    await reminderSchemaPromise;
  } finally {
    if (!reminderSchemaReady) reminderSchemaPromise = null;
  }
}

function securityHeaders(response) {
  const h = new Headers(response.headers);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  h.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}

async function getMetaValue(env, key) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key=?").bind(key).first();
  return row?.value ?? null;
}

async function setMetaValue(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
  ).bind(key, String(value), nowIso()).run();
}

async function health(env) {
  const [lastCycle, lastCycleErrors, catalogAt, sourceError, browserAttempt, browserSuccess, browserError, manualRequired] = await Promise.all([
    getMetaValue(env, "last_cycle_finished_at"),
    getMetaValue(env, "last_cycle_errors"),
    getMetaValue(env, "catalog_updated_at"),
    getMetaValue(env, "source_session_error"),
    getMetaValue(env, "source_browser_last_attempt_at"),
    getMetaValue(env, "source_browser_last_success_at"),
    getMetaValue(env, "source_browser_last_error"),
    getMetaValue(env, "source_browser_manual_required_at"),
  ]);
  return json({
    status: "ok",
    platform: "cloudflare-workers-d1-queues-browser-run",
    version: APP_VERSION,
    collector: {
      schedule_target_seconds: 60,
      source_browser_recovery_minutes: SOURCE_BROWSER_RECOVERY_MINUTES,
      next_week_refresh_minutes: NEXT_WEEK_REFRESH_MINUTES,
      last_cycle_finished_at: lastCycle,
      last_cycle_errors: lastCycleErrors == null ? null : Number(lastCycleErrors),
      catalog_updated_at: catalogAt,
      source_session_error: sourceError || null,
      source_browser_last_attempt_at: browserAttempt || null,
      source_browser_last_success_at: browserSuccess || null,
      source_browser_last_error: browserError || null,
      source_browser_manual_required_at: manualRequired || null,
    },
  });
}

async function catalog(env) {
  const [depsRes, groupsRes] = await Promise.all([
    env.DB.prepare("SELECT id,label FROM departments ORDER BY label").all(),
    env.DB.prepare("SELECT id,department_id,label FROM groups ORDER BY label").all(),
  ]);
  const by = new Map();
  for (const g of groupsRes.results || []) {
    if (!by.has(g.department_id)) by.set(g.department_id, []);
    by.get(g.department_id).push({ id: g.id, label: g.label });
  }
  return json({ departments: (depsRes.results || []).map((d) => ({ id: d.id, label: d.label, groups: by.get(d.id) || [] })) });
}

async function groupExists(env, groupId, departmentId = null) {
  const query = departmentId
    ? env.DB.prepare("SELECT 1 AS ok FROM groups WHERE id=? AND department_id=? LIMIT 1").bind(groupId, departmentId)
    : env.DB.prepare("SELECT 1 AS ok FROM groups WHERE id=? LIMIT 1").bind(groupId);
  return Boolean(await query.first());
}

function ageMs(iso) {
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) ? Date.now() - ms : Infinity;
}

async function queueSingleGroupIfNeeded(env, groupId, departmentId, currentSync = null) {
  if (!env.SYNC_QUEUE) return currentSync;
  const sync = currentSync || await env.DB.prepare("SELECT * FROM sync_state WHERE group_id=?").bind(groupId).first();
  const recentlyQueued = sync && ["queued", "syncing"].includes(sync.status) && ageMs(sync.last_attempt_at) < QUEUED_STALE_MINUTES * 60_000;
  const recentlySynced = sync?.last_success_at && ageMs(sync.last_success_at) < GROUP_SYNC_MIN_SECONDS * 1000;
  if (recentlyQueued || recentlySynced) return sync;

  const stamp = nowIso();
  await env.DB.prepare(
    "INSERT INTO sync_state(group_id,last_attempt_at,last_success_at,status,error) VALUES(?,?,?,?,?) " +
    "ON CONFLICT(group_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,status=excluded.status,error=NULL",
  ).bind(groupId, stamp, sync?.last_success_at || null, "queued", null).run();
  await env.SYNC_QUEUE.send({ type: "groups", groups: [{ group_id: groupId, department_id: departmentId }] });
  return { ...(sync || {}), group_id: groupId, last_attempt_at: stamp, status: "queued", error: null };
}

async function publicWatch(request, env) {
  let req;
  try { req = await bodyJson(request); } catch { return apiError(400, "invalid-json"); }
  const departmentId = String(req.department_id || "");
  const groupId = String(req.group_id || "");
  if (!departmentId || !groupId || departmentId.length > 256 || groupId.length > 256 || !(await groupExists(env, groupId, departmentId))) {
    return apiError(400, "unknown-course-group");
  }

  const existing = await env.DB.prepare("SELECT last_seen_at FROM interests WHERE group_id=?").bind(groupId).first();
  const oldMs = existing?.last_seen_at ? Date.parse(existing.last_seen_at) : 0;
  if (!existing || !Number.isFinite(oldMs) || Date.now() - oldMs >= INTEREST_TOUCH_MINUTES * 60_000) {
    await env.DB.prepare(
      "INSERT INTO interests(group_id,department_id,last_seen_at) VALUES(?,?,?) ON CONFLICT(group_id) DO UPDATE SET department_id=excluded.department_id,last_seen_at=excluded.last_seen_at",
    ).bind(groupId, departmentId, nowIso()).run();
  }

  const snap = await env.DB.prepare("SELECT 1 AS ok FROM latest_snapshots WHERE group_id=?").bind(groupId).first();
  let sync = await env.DB.prepare("SELECT * FROM sync_state WHERE group_id=?").bind(groupId).first();
  const sourceError = await getMetaValue(env, "source_session_error");
  if (sourceError) {
    // Recovery is centralized in the Cloudflare cron. Public clients should never
    // create extra failing queue jobs while the central source session is being renewed.
    sync = { ...(sync || {}), group_id: groupId, status: "error", error: "source-session-unavailable" };
  } else {
    try { sync = await queueSingleGroupIfNeeded(env, groupId, departmentId, sync); } catch (err) { console.error("queue watch", err); }
  }
  if (!sync) sync = { group_id: groupId, last_attempt_at: null, last_success_at: null, status: "never-synced", error: null };
  return json({ ok: true, has_snapshot: Boolean(snap), sync });
}

async function timetable(env, groupId) {
  const row = await env.DB.prepare("SELECT payload FROM latest_snapshots WHERE group_id=?").bind(groupId).first();
  if (!row) return apiError(404, "not-synced-yet");
  const sync = await env.DB.prepare("SELECT * FROM sync_state WHERE group_id=?").bind(groupId).first();
  return json({ snapshot: safeParse(row.payload, {}), sync: sync || { group_id: groupId, status: "ok" } });
}

async function syncStatus(env, groupId) {
  const row = await env.DB.prepare("SELECT * FROM sync_state WHERE group_id=?").bind(groupId).first();
  return json(row || { group_id: groupId, status: "never-synced", last_attempt_at: null, last_success_at: null, error: null });
}

async function changes(env, groupId, url) {
  const raw = Number(url.searchParams.get("limit") || 50);
  const limit = Math.max(1, Math.min(200, Number.isFinite(raw) ? raw : 50));
  const res = await env.DB.prepare(
    "SELECT id,group_id,detected_at,change_type,module,activity,day,before_json,after_json FROM changes WHERE group_id=? ORDER BY id DESC LIMIT ?",
  ).bind(groupId, limit).all();
  return json((res.results || []).map((r) => ({
    id: r.id, group_id: r.group_id, detected_at: r.detected_at, change_type: r.change_type,
    module: r.module, activity: r.activity, day: r.day,
    before: safeParse(r.before_json, null), after: safeParse(r.after_json, null),
  })));
}

async function pushSubscribe(request, env) {
  let req;
  try { req = await bodyJson(request); } catch { return apiError(400, "invalid-json"); }
  const groupId = String(req.group_id || "");
  const endpoint = String(req.endpoint || "");
  const p256dh = String(req.keys?.p256dh || "");
  const auth = String(req.keys?.auth || "");
  const hidden = Array.isArray(req.hidden_modules) ? [...new Set(req.hidden_modules.slice(0, 100).map((x) => String(x).slice(0, 256)))].sort() : [];
  const reminderMinutes = Number(req.reminder_minutes ?? 0);
  let endpointUrl = null;
  try { endpointUrl = new URL(endpoint); } catch {}
  if (!groupId || groupId.length > 256 || !endpoint || endpoint.length > 4096 || endpointUrl?.protocol !== "https:" ||
      !p256dh || p256dh.length > 512 || !auth || auth.length > 256 || ![0,15,30,60].includes(reminderMinutes) ||
      !(await groupExists(env, groupId))) {
    return apiError(400, "invalid-subscription");
  }
  await env.DB.prepare(
    "INSERT INTO push_subscriptions(endpoint,group_id,p256dh,auth,created_at,active,hidden_modules,reminder_minutes) VALUES(?,?,?,?,?,1,?,?) " +
    "ON CONFLICT(endpoint) DO UPDATE SET group_id=excluded.group_id,p256dh=excluded.p256dh,auth=excluded.auth,active=1,hidden_modules=excluded.hidden_modules,reminder_minutes=excluded.reminder_minutes",
  ).bind(endpoint, groupId, p256dh, auth, nowIso(), JSON.stringify(hidden), reminderMinutes).run();
  return json({ ok: true });
}

async function pushUnsubscribe(request, env) {
  let req;
  try { req = await bodyJson(request); } catch { return apiError(400, "invalid-json"); }
  const endpoint = String(req.endpoint || "");
  if (endpoint && endpoint.length <= 4096) await env.DB.prepare("UPDATE push_subscriptions SET active=0 WHERE endpoint=?").bind(endpoint).run();
  return json({ ok: true });
}

async function pushTest(request, env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return apiError(503, "push-disabled");
  let req;
  try { req = await bodyJson(request); } catch { return apiError(400, "invalid-json"); }
  const endpoint = String(req.endpoint || "");
  if (!endpoint || endpoint.length > 4096) return apiError(400, "invalid-subscription");
  const row = await env.DB.prepare("SELECT 1 AS ok FROM push_subscriptions WHERE endpoint=? AND active=1 LIMIT 1").bind(endpoint).first();
  if (!row) return apiError(404, "subscription-not-found");
  await env.SYNC_QUEUE.send({ type: "push-test", endpoint });
  return json({ queued: true });
}

async function sendTestPush(env, endpoint) {
  const row = await env.DB.prepare("SELECT endpoint,p256dh,auth,active FROM push_subscriptions WHERE endpoint=? LIMIT 1").bind(endpoint).first();
  if (!row || !row.active) return { sent: 0, reason: "subscription-not-found" };
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  try {
    await webpush.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      JSON.stringify({ title: "TUS Companion test", body: "Notifications are working on this device.", url: "/?tab=settings", tag: "tus-companion-test" }),
      { TTL: 60 },
    );
    return { sent: 1 };
  } catch (err) {
    const statusCode = Number(err?.statusCode || 0);
    if (statusCode === 404 || statusCode === 410) {
      await env.DB.prepare("UPDATE push_subscriptions SET active=0 WHERE endpoint=?").bind(endpoint).run();
      return { sent: 0, disabled: true, status: statusCode };
    }
    throw err;
  }
}

async function activeGroups(env) {
  const cutoff = new Date(Date.now() - INTEREST_TTL_DAYS * 86400_000).toISOString();
  const res = await env.DB.prepare(
    `WITH active AS (
       SELECT group_id, department_id FROM interests WHERE last_seen_at >= ?
       UNION
       SELECT DISTINCT p.group_id, g.department_id
       FROM push_subscriptions p JOIN groups g ON g.id=p.group_id
       WHERE p.active=1
     )
     SELECT a.group_id,a.department_id,g.label,s.payload,s.payload_hash,st.last_attempt_at,st.last_success_at,st.status
     FROM active a
     LEFT JOIN groups g ON g.id=a.group_id
     LEFT JOIN latest_snapshots s ON s.group_id=a.group_id
     LEFT JOIN sync_state st ON st.group_id=a.group_id
     ORDER BY CASE WHEN st.last_success_at IS NULL THEN 0 ELSE 1 END, st.last_success_at, g.label`,
  ).bind(cutoff).all();
  return res.results || [];
}


async function preloadCandidates(env, limit = PRELOAD_GROUPS_PER_CYCLE) {
  const retryBefore = new Date(Date.now() - PRELOAD_ERROR_RETRY_HOURS * 3600_000).toISOString();
  const res = await env.DB.prepare(
    `SELECT g.id AS group_id,g.department_id,g.label,d.label AS department_label,st.last_attempt_at,st.status
     FROM groups g
     JOIN departments d ON d.id=g.department_id
     LEFT JOIN latest_snapshots s ON s.group_id=g.id
     LEFT JOIN sync_state st ON st.group_id=g.id
     WHERE s.group_id IS NULL
       AND (st.status IS NULL OR st.status <> 'error' OR st.last_attempt_at IS NULL OR st.last_attempt_at < ?)
       AND (st.status IS NULL OR st.status NOT IN ('queued','syncing') OR st.last_attempt_at IS NULL OR st.last_attempt_at < ?)
     ORDER BY CASE WHEN lower(d.label) LIKE '%business%' OR lower(g.label) LIKE '%business%' THEN 0 ELSE 1 END,
              d.label,g.label
     LIMIT ?`,
  ).bind(retryBefore, new Date(Date.now() - QUEUED_STALE_MINUTES * 60_000).toISOString(), Math.max(0, Number(limit) || 0)).all();
  return res.results || [];
}

async function adminSyncPlan(env) {
  const groups = await activeGroups(env);
  const catalogAt = await getMetaValue(env, "catalog_updated_at");
  const refreshDue = !catalogAt || ageMs(catalogAt) >= CATALOG_REFRESH_HOURS * 3600_000;
  return json({
    catalog_refresh_due: refreshDue,
    groups: groups.map((r) => ({
      group_id: r.group_id, department_id: r.department_id, label: r.label,
      snapshot: safeParse(r.payload, null), payload_hash: r.payload_hash || null,
      last_success_at: r.last_success_at || null, status: r.status || null,
    })),
  });
}

async function saveCatalogPayload(env, payload) {
  const deps = Array.isArray(payload.departments) ? payload.departments : [];
  const departmentGroups = Array.isArray(payload.department_groups) ? payload.department_groups : [];
  const stamp = nowIso();
  const statements = [];
  for (const d of deps) {
    if (!d?.value || !d?.label) continue;
    statements.push(env.DB.prepare(
      "INSERT INTO departments(id,label,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,updated_at=excluded.updated_at",
    ).bind(String(d.value), String(d.label), stamp));
  }
  for (const item of departmentGroups) {
    const dep = String(item?.department_id || "");
    for (const g of Array.isArray(item?.groups) ? item.groups : []) {
      if (!dep || !g?.value || !g?.label) continue;
      statements.push(env.DB.prepare(
        "INSERT INTO groups(id,department_id,label,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET department_id=excluded.department_id,label=excluded.label,updated_at=excluded.updated_at",
      ).bind(String(g.value), dep, String(g.label), stamp));
    }
  }
  for (let i = 0; i < statements.length; i += 40) await env.DB.batch(statements.slice(i, i + 40));
  await setMetaValue(env, "catalog_updated_at", stamp);
  await setMetaValue(env, "source_session_error", "");
  await setMetaValue(env, "source_session_last_retry_at", "");
  return { departments: deps.length, groups: departmentGroups.reduce((n, x) => n + (Array.isArray(x.groups) ? x.groups.length : 0), 0) };
}

async function adminCatalog(request, env) {
  let payload;
  try { payload = await bodyJson(request, 2_000_000); } catch { return apiError(400, "invalid-json"); }
  return json(await saveCatalogPayload(env, payload));
}

async function saveResultPayload(env, req) {
  const groupId = String(req.group_id || "");
  if (!groupId) throw new Error("missing-group-id");
  const stamp = nowIso();
  if (req.error) {
    await env.DB.prepare(
      "INSERT INTO sync_state(group_id,last_attempt_at,last_success_at,status,error) VALUES(?,?,?,?,?) " +
      "ON CONFLICT(group_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,status=excluded.status,error=excluded.error",
    ).bind(groupId, stamp, null, "error", String(req.error).slice(0, 1000)).run();
    return { ok: true, saved_snapshot: false, saved_changes: 0, inserted_changes: [] };
  }
  if (!req.snapshot || !req.payload_hash) throw new Error("missing-snapshot");

  let savedSnapshot = false;
  const existing = await env.DB.prepare("SELECT payload_hash FROM latest_snapshots WHERE group_id=?").bind(groupId).first();
  if (!existing || existing.payload_hash !== String(req.payload_hash)) {
    await env.DB.prepare(
      "INSERT INTO latest_snapshots(group_id,fetched_at,payload,payload_hash) VALUES(?,?,?,?) " +
      "ON CONFLICT(group_id) DO UPDATE SET fetched_at=excluded.fetched_at,payload=excluded.payload,payload_hash=excluded.payload_hash",
    ).bind(groupId, String(req.snapshot.fetched_at || stamp), JSON.stringify(req.snapshot), String(req.payload_hash)).run();
    savedSnapshot = true;
  }

  let savedChanges = 0;
  const insertedChanges = [];
  for (const ch of (Array.isArray(req.changes) ? req.changes.slice(0, 80) : [])) {
    if (!ch?.change_type || !ch?.dedupe_hash) continue;
    const result = await env.DB.prepare(
      "INSERT OR IGNORE INTO changes(group_id,detected_at,change_type,module,activity,day,before_json,after_json,dedupe_hash) VALUES(?,?,?,?,?,?,?,?,?)",
    ).bind(
      groupId, String(ch.detected_at || stamp), String(ch.change_type),
      ch.module == null ? null : String(ch.module), ch.activity == null ? null : String(ch.activity), ch.day == null ? null : String(ch.day),
      ch.before == null ? null : JSON.stringify(ch.before), ch.after == null ? null : JSON.stringify(ch.after), String(ch.dedupe_hash),
    ).run();
    if (result.meta?.changes) { savedChanges += Number(result.meta.changes); insertedChanges.push(ch); }
  }

  await env.DB.prepare(
    "INSERT INTO sync_state(group_id,last_attempt_at,last_success_at,status,error) VALUES(?,?,?,?,?) " +
    "ON CONFLICT(group_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,status=excluded.status,error=NULL",
  ).bind(groupId, stamp, stamp, "ok", null).run();
  return { ok: true, saved_snapshot: savedSnapshot, saved_changes: savedChanges, inserted_changes: insertedChanges };
}

async function adminResult(request, env) {
  let req;
  try { req = await bodyJson(request); } catch { return apiError(400, "invalid-json"); }
  try {
    const out = await saveResultPayload(env, req);
    return json({ ok: out.ok, saved_snapshot: out.saved_snapshot, saved_changes: out.saved_changes });
  } catch (err) {
    return apiError(400, String(err?.message || err));
  }
}

async function adminSubscriptions(env, groupId) {
  const res = await env.DB.prepare("SELECT endpoint,p256dh,auth,hidden_modules,reminder_minutes FROM push_subscriptions WHERE group_id=? AND active=1").bind(groupId).all();
  return json((res.results || []).map((r) => ({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, hidden_modules: parseHidden(r.hidden_modules), reminder_minutes: Number(r.reminder_minutes || 0) })));
}

async function adminDeactivateSubscription(request, env) {
  let req;
  try { req = await bodyJson(request); } catch { return apiError(400, "invalid-json"); }
  const endpoint = String(req.endpoint || "");
  if (endpoint) await env.DB.prepare("UPDATE push_subscriptions SET active=0 WHERE endpoint=?").bind(endpoint).run();
  return json({ ok: true });
}

async function adminSourceSession(request, env) {
  if (request.method === "GET") {
    const row = await env.DB.prepare("SELECT ciphertext,nonce,updated_at FROM source_session WHERE id=1").first();
    return json(row || { ciphertext: null, nonce: null, updated_at: null });
  }
  let req;
  try { req = await bodyJson(request, 524_288); } catch { return apiError(400, "invalid-json"); }
  if (!req.ciphertext || !req.nonce) return apiError(400, "missing-encrypted-session");
  await env.DB.prepare(
    "INSERT INTO source_session(id,ciphertext,nonce,updated_at) VALUES(1,?,?,?) " +
    "ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,nonce=excluded.nonce,updated_at=excluded.updated_at",
  ).bind(String(req.ciphertext), String(req.nonce), nowIso()).run();
  await setMetaValue(env, "source_session_error", "");
  await setMetaValue(env, "source_session_last_retry_at", "");
  await setMetaValue(env, "source_browser_manual_required_at", "");
  await setMetaValue(env, "source_browser_last_error", "");
  return json({ ok: true });
}

async function adminCycle(request, env) {
  let req;
  try { req = await bodyJson(request); } catch { return apiError(400, "invalid-json"); }
  await recordCycle(env, req);
  return json({ ok: true });
}

function b64Bytes(value) {
  let s = String(value || "").trim().replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob(s);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function bytesB64(bytes) {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sourceCryptoKey(env) {
  const bytes = b64Bytes(env.SESSION_CIPHER_KEY_B64 || "");
  if (bytes.length !== 32) throw new Error("source-session-key-missing-or-invalid");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function loadSourceStorageState(env) {
  const row = await env.DB.prepare("SELECT ciphertext,nonce FROM source_session WHERE id=1").first();
  if (!row?.ciphertext || !row?.nonce) throw new Error("source-session-not-configured");
  const key = await sourceCryptoKey(env);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64Bytes(row.nonce), additionalData: SESSION_AAD }, key, b64Bytes(row.ciphertext));
  } catch {
    throw new Error("source-session-decryption-failed");
  }
  try { return JSON.parse(new TextDecoder().decode(plain)); } catch { throw new Error("source-session-invalid-json"); }
}


async function saveSourceStorageState(env, state) {
  const key = await sourceCryptoKey(env);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(state));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: SESSION_AAD }, key, plaintext);
  await env.DB.prepare(
    "INSERT INTO source_session(id,ciphertext,nonce,updated_at) VALUES(1,?,?,?) " +
    "ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,nonce=excluded.nonce,updated_at=excluded.updated_at",
  ).bind(bytesB64(new Uint8Array(encrypted)), bytesB64(nonce), nowIso()).run();
}


async function browserPageReady(page) {
  try { return await page.locator("#dlFilter2").isVisible({ timeout: 800 }); }
  catch { return false; }
}

async function browserOpenStudentSet(page, timeout = 8_000) {
  if (await browserPageReady(page)) return true;
  try {
    const link = page.locator("#LinkBtn_StudentSetByName");
    if (!(await link.isVisible({ timeout: 800 }))) return false;
    await link.click();
    await page.locator("#dlFilter2").waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return browserPageReady(page);
  }
}

async function browserClickStudentGateway(page) {
  for (const selector of [
    'input[type="submit"][value="Student"]',
    'input[type="button"][value="Student"]',
    'button:has-text("Student")',
    'a:has-text("Student")',
  ]) {
    try {
      const loc = page.locator(selector).first();
      if (await loc.isVisible({ timeout: 500 })) {
        await loc.click();
        return true;
      }
    } catch {}
  }
  return false;
}

async function recoverSourceSessionWithBrowser(env) {
  if (!env.BROWSER) throw new Error("browser-recovery-binding-missing");
  const storage = await loadSourceStorageState(env);
  const browser = await launch(env.BROWSER);
  let context;
  try {
    context = await browser.newContext({
      storageState: storage,
      viewport: { width: 1440, height: 1000 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto(TUS_BASE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

    let ready = await browserOpenStudentSet(page);
    if (!ready) {
      const clicked = await browserClickStudentGateway(page);
      if (!clicked) throw new Error("browser-recovery-login-required");

      const deadline = Date.now() + SOURCE_BROWSER_RECOVERY_TIMEOUT_MS;
      while (Date.now() < deadline && !ready) {
        for (const candidate of [...context.pages()].reverse()) {
          if (await browserOpenStudentSet(candidate, 4_000)) {
            ready = true;
            break;
          }
        }
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }

    if (!ready) throw new Error("browser-recovery-login-required");

    const refreshed = await context.storageState();
    await saveSourceStorageState(env, refreshed);

    // Verify the refreshed browser state through the lightweight HTTP collector
    // before declaring recovery successful.
    const verify = new ScientiaSession(refreshed);
    await verify.ensureReady();
    await saveSourceStorageState(env, verify.storageState());

    await setMetaValue(env, "source_session_error", "");
    await setMetaValue(env, "source_session_last_retry_at", "");
    await setMetaValue(env, "source_browser_last_success_at", nowIso());
    await setMetaValue(env, "source_browser_last_error", "");
    await setMetaValue(env, "source_browser_manual_required_at", "");
    return true;
  } finally {
    try { if (context) await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

async function maybeRecoverSourceSession(env) {
  const sourceError = await getMetaValue(env, "source_session_error");
  if (sourceError !== "source-session-expired") return { attempted: false, recovered: !sourceError };

  // If Microsoft has explicitly fallen back to interactive credentials/MFA,
  // repeating headless browser attempts cannot solve it and only wastes Browser Run.
  const manualRequired = await getMetaValue(env, "source_browser_manual_required_at");
  if (manualRequired) return { attempted: false, recovered: false, manual_required: true };

  const lastAttempt = await getMetaValue(env, "source_browser_last_attempt_at");
  if (lastAttempt && ageMs(lastAttempt) < SOURCE_BROWSER_RECOVERY_MINUTES * 60_000) {
    return { attempted: false, recovered: false };
  }

  await setMetaValue(env, "source_browser_last_attempt_at", nowIso());
  try {
    await recoverSourceSessionWithBrowser(env);
    return { attempted: true, recovered: true };
  } catch (err) {
    const message = String(err?.message || err);
    console.error("browser source recovery", message);
    await setMetaValue(env, "source_browser_last_error", message);
    if (/browser-recovery-login-required/i.test(message)) {
      await setMetaValue(env, "source_browser_manual_required_at", nowIso());
    }
    return { attempted: true, recovered: false, error: message };
  }
}

function pushChangeSummary(ch) {
  const a = ch.after || {}, b = ch.before || {};
  const name = String(ch.module || ch.activity || "Class").trim();
  const day = String(ch.day || a.day || b.day || "").trim().slice(0, 3);
  const at = a.start || b.start || "";
  const roomA = a.room_code || a.room_raw || "";
  const roomB = b.room_code || b.room_raw || "";
  const join = (...parts) => parts.filter(Boolean).join(" · ");
  if (ch.change_type === "ROOM_CHANGED") return { module: name, title: `${name} · room changed`, body: join(roomB && roomA ? `${roomB} → ${roomA}` : "", day, at) };
  if (ch.change_type === "TIME_CHANGED") return { module: name, title: `${name} · time changed`, body: join(day, b.start && a.start ? `${b.start} → ${a.start}` : at) };
  if (ch.change_type === "CLASS_ADDED") return { module: name, title: `${name} · class added`, body: join(day, a.start, roomA) };
  if (ch.change_type === "CLASS_REMOVED") return { module: name, title: `${name} · class removed`, body: join(day, b.start, roomB) };
  if (ch.change_type === "LECTURER_CHANGED") return { module: name, title: `${name} · lecturer changed`, body: b.staff && a.staff ? `${b.staff} → ${a.staff}` : "" };
  if (ch.change_type === "CLASS_TYPE_CHANGED") return { module: name, title: `${name} · class type changed`, body: b.type && a.type ? `${b.type} → ${a.type}` : "" };
  if (ch.change_type === "TEACHING_WEEKS_CHANGED") return { module: name, title: `${name} · teaching weeks changed`, body: "" };
  return { module: name, title: name, body: join(day, at, roomA) };
}

function compactPushChanges(changesList) {
  return (Array.isArray(changesList) ? changesList : []).slice(0, 80).map((ch) => {
    const summary = pushChangeSummary(ch);
    return {
      module: summary.module.slice(0, 256),
      title: summary.title.slice(0, 180),
      body: summary.body.slice(0, 240),
    };
  });
}

async function sendChangePushes(env, groupId, changesList, afterEndpoint = "") {
  if (!changesList.length || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return { sent: 0, next_endpoint: null };
  const res = await env.DB.prepare(
    "SELECT endpoint,p256dh,auth,hidden_modules FROM push_subscriptions WHERE group_id=? AND active=1 AND endpoint>? ORDER BY endpoint LIMIT ?",
  ).bind(groupId, afterEndpoint, PUSH_SUBSCRIPTIONS_PER_JOB + 1).all();
  const rows = res.results || [];
  const subs = rows.slice(0, PUSH_SUBSCRIPTIONS_PER_JOB);
  if (!subs.length) return { sent: 0, next_endpoint: null };
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  let sent = 0;
  for (const sub of subs) {
    const hidden = new Set(parseHidden(sub.hidden_modules).map((x) => String(x).toLowerCase()));
    const visible = changesList.filter((ch) => !hidden.has(String(ch.module || "").toLowerCase()));
    if (!visible.length) continue;
    const first = visible[0];
    const title = visible.length === 1 ? first.title : `${visible.length} timetable changes`;
    const firstSummary = [first.title, first.body].filter(Boolean).join(" · ");
    const body = visible.length === 1 ? first.body : `${firstSummary} · +${visible.length - 1} more`;
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title, body, url: "/?tab=changes", tag: `${groupId}:changes` }),
        { TTL: 300 },
      );
      sent++;
    } catch (err) {
      const statusCode = Number(err?.statusCode || 0);
      if (statusCode === 404 || statusCode === 410) await env.DB.prepare("UPDATE push_subscriptions SET active=0 WHERE endpoint=?").bind(sub.endpoint).run();
      else console.error("push", groupId, statusCode || err?.message || err);
    }
  }
  return { sent, next_endpoint: rows.length > PUSH_SUBSCRIPTIONS_PER_JOB ? subs.at(-1)?.endpoint || null : null };
}

function dublinClock() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function classStartMinute(value) {
  const [h, m = "0"] = String(value || "").split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : -1;
}

function reminderEventKey(groupId, event) {
  return [groupId, event?.date, event?.start, event?.end, event?.module, event?.activity, event?.room_code || event?.room_raw]
    .map((x) => String(x || "").trim().toLowerCase()).join("|").slice(0, 1024);
}

function dueReminderEvents(snapshot, leadMinutes, hidden) {
  const clock = dublinClock();
  return (Array.isArray(snapshot?.events) ? snapshot.events : [])
    .filter((event) => {
      if (String(event?.date || "") !== clock.date) return false;
      if (hidden.has(String(event?.module || "").toLowerCase())) return false;
      const start = classStartMinute(event?.start);
      if (start < 0) return false;
      const delta = start - clock.minuteOfDay;
      return delta <= leadMinutes && delta >= Math.max(0, leadMinutes - REMINDER_WINDOW_MINUTES);
    })
    .sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")));
}

async function sendLessonReminders(env, afterEndpoint = "") {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return { sent: 0, next_endpoint: null };
  const res = await env.DB.prepare(
    "SELECT endpoint,group_id,p256dh,auth,hidden_modules,reminder_minutes FROM push_subscriptions " +
    "WHERE active=1 AND reminder_minutes IN (15,30,60) AND endpoint>? ORDER BY endpoint LIMIT ?",
  ).bind(afterEndpoint, REMINDER_SUBSCRIPTIONS_PER_JOB + 1).all();
  const rows = res.results || [];
  const subs = rows.slice(0, REMINDER_SUBSCRIPTIONS_PER_JOB);
  if (!subs.length) return { sent: 0, next_endpoint: null };

  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const snapshots = new Map();
  let sent = 0;

  for (const sub of subs) {
    const lead = Number(sub.reminder_minutes || 0);
    if (![15,30,60].includes(lead)) continue;
    if (!snapshots.has(sub.group_id)) {
      const row = await env.DB.prepare("SELECT payload FROM latest_snapshots WHERE group_id=?").bind(sub.group_id).first();
      snapshots.set(sub.group_id, safeParse(row?.payload, null));
    }
    const snapshot = snapshots.get(sub.group_id);
    if (!snapshot) continue;
    const hidden = new Set(parseHidden(sub.hidden_modules).map((x) => String(x).toLowerCase()));
    const due = dueReminderEvents(snapshot, lead, hidden);

    for (const event of due) {
      const eventKey = reminderEventKey(sub.group_id, event);
      if (!eventKey) continue;
      const inserted = await env.DB.prepare(
        "INSERT OR IGNORE INTO reminder_deliveries(endpoint,event_key,lead_minutes,sent_at) VALUES(?,?,?,?)",
      ).bind(sub.endpoint, eventKey, lead, nowIso()).run();
      if (!inserted.meta?.changes) continue;

      const name = String(event.module || event.activity || "Class").trim();
      const room = event.room_code || event.room_raw || "";
      const body = [event.start || "", room, event.room_name || ""].filter(Boolean).join(" · ");
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({
            title: `${name} in ${lead} min`,
            body,
            url: "/?tab=today",
            tag: `class-reminder:${eventKey}:${lead}`,
          }),
          { TTL: Math.max(300, lead * 60) },
        );
        sent++;
      } catch (err) {
        const statusCode = Number(err?.statusCode || 0);
        if (statusCode === 404 || statusCode === 410) {
          await env.DB.prepare("UPDATE push_subscriptions SET active=0 WHERE endpoint=?").bind(sub.endpoint).run();
        } else {
          await env.DB.prepare("DELETE FROM reminder_deliveries WHERE endpoint=? AND event_key=? AND lead_minutes=?")
            .bind(sub.endpoint, eventKey, lead).run();
          console.error("lesson reminder", sub.group_id, statusCode || err?.message || err);
        }
      }
    }
  }

  const cleanupBefore = new Date(Date.now() - 21 * 86400_000).toISOString();
  await env.DB.prepare("DELETE FROM reminder_deliveries WHERE sent_at<?").bind(cleanupBefore).run();
  return { sent, next_endpoint: rows.length > REMINDER_SUBSCRIPTIONS_PER_JOB ? subs.at(-1)?.endpoint || null : null };
}



function snapshotHasFutureEvent(snapshot) {
  const clock = dublinClock();
  return (Array.isArray(snapshot?.events) ? snapshot.events : []).some((event) => {
    const date = String(event?.date || "");
    if (date > clock.date) return true;
    if (date < clock.date) return false;
    const end = classStartMinute(event?.end);
    return end >= clock.minuteOfDay;
  });
}

function compactNextWeekSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    week_number: snapshot.week_number ?? null,
    week_start: snapshot.week_start ?? null,
    week_end: snapshot.week_end ?? null,
    fetched_at: snapshot.fetched_at ?? nowIso(),
    events: Array.isArray(snapshot.events) ? snapshot.events : [],
  };
}

async function markSyncing(env, groupId) {
  const stamp = nowIso();
  await env.DB.prepare(
    "INSERT INTO sync_state(group_id,last_attempt_at,last_success_at,status,error) VALUES(?,?,?,?,?) " +
    "ON CONFLICT(group_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,status=excluded.status,error=NULL",
  ).bind(groupId, stamp, null, "syncing", null).run();
}

async function syncOneGroup(env, scientia, item) {
  const groupId = String(item.group_id || ""), departmentId = String(item.department_id || "");
  if (!groupId || !departmentId) throw new Error("invalid-group-job");
  await markSyncing(env, groupId);
  try {
    const existing = await env.DB.prepare("SELECT payload FROM latest_snapshots WHERE group_id=?").bind(groupId).first();
    const previous = safeParse(existing?.payload, null);

    const html = await scientia.fetchTimetable(departmentId, groupId, "t");
    const snapshot = parseTextSpreadsheet(html);
    if (!snapshot.events.length) throw new Error("empty-timetable-response");
    snapshot.group_id = groupId;
    snapshot.department_id = departmentId;

    // Keep the normal Week UI and change detection scoped to ThisWeek, but cache
    // Next Week separately so the Today hero can always show the next real class.
    let nextWeek = previous?.next_week || null;
    const nextWeekStale = !nextWeek?.fetched_at || ageMs(nextWeek.fetched_at) >= NEXT_WEEK_REFRESH_MINUTES * 60_000;
    if (!snapshotHasFutureEvent(snapshot) || !nextWeek || nextWeekStale) {
      const nextHtml = await scientia.fetchTimetable(departmentId, groupId, "n");
      nextWeek = compactNextWeekSnapshot(parseTextSpreadsheet(nextHtml));
    }
    snapshot.next_week = nextWeek;

    const changesList = diffSnapshots(previous, snapshot);
    const enriched = await enrichChanges(groupId, changesList);
    const payloadHash = await snapshotContentHash(snapshot);
    const saved = await saveResultPayload(env, { group_id: groupId, snapshot, payload_hash: payloadHash, changes: enriched });
    if (saved.inserted_changes.length) {
      await env.SYNC_QUEUE.send({ type: "push-changes", group_id: groupId, changes: compactPushChanges(saved.inserted_changes), after_endpoint: "" });
    }
    return {
      group_id: groupId,
      events: snapshot.events.length,
      next_week_events: nextWeek?.events?.length || 0,
      changes: saved.saved_changes,
    };
  } catch (err) {
    await saveResultPayload(env, { group_id: groupId, error: String(err?.message || err) });
    throw err;
  }
}
async function runGroupJob(env, groups) {
  const storage = await loadSourceStorageState(env);
  const scientia = new ScientiaSession(storage);
  const results = [];
  let fatal = null;
  for (const item of Array.isArray(groups) ? groups : []) {
    try { results.push(await syncOneGroup(env, scientia, item)); }
    catch (err) {
      const message = String(err?.message || err);
      console.error("group sync", item?.group_id, message);
      if (/source-session/i.test(message)) { fatal = err; break; }
      results.push({ group_id: item?.group_id, error: message });
    }
  }
  await saveSourceStorageState(env, scientia.storageState());
  if (fatal) {
    await setMetaValue(env, "source_session_error", String(fatal.message || fatal));
    throw fatal;
  }
  await setMetaValue(env, "source_session_error", "");
  await setMetaValue(env, "source_session_last_retry_at", "");
  return results;
}

async function runCatalogJob(env) {
  const storage = await loadSourceStorageState(env);
  const scientia = new ScientiaSession(storage);
  try {
    const payload = await scientia.scrapeCatalog();
    const summary = await saveCatalogPayload(env, payload);
    await saveSourceStorageState(env, scientia.storageState());
    return summary;
  } catch (err) {
    try { await saveSourceStorageState(env, scientia.storageState()); } catch {}
    const message = String(err?.message || err);
    if (/source-session/i.test(message)) await setMetaValue(env, "source_session_error", message);
    throw err;
  }
}

async function recordCycle(env, req) {
  const stamp = nowIso();
  const writes = [
    ["last_cycle_finished_at", String(req.finished_at || stamp)],
    ["last_cycle_started_at", String(req.started_at || stamp)],
    ["last_cycle_groups", String(Number(req.groups || 0))],
    ["last_cycle_errors", String(Number(req.errors || 0))],
    ["last_cycle_duration_seconds", String(Number(req.duration_seconds || 0))],
  ];
  await env.DB.batch(writes.map(([k, v]) => env.DB.prepare(
    "INSERT INTO meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
  ).bind(k, v, stamp)));
}

async function enqueueScheduledWork(env) {
  const started = nowIso();
  let groupsQueued = 0, errors = 0;
  try {
    let sourceError = await getMetaValue(env, "source_session_error");
    if (sourceError) {
      const recovery = await maybeRecoverSourceSession(env);
      if (recovery.recovered) {
        sourceError = "";
      } else {
        errors = 1;
        return;
      }
    }
    const catalogAt = await getMetaValue(env, "catalog_updated_at");
    const lastCatalogQueue = await getMetaValue(env, "catalog_last_enqueued_at");
    const catalogDue = !catalogAt || ageMs(catalogAt) >= CATALOG_REFRESH_HOURS * 3600_000;
    const catalogQueueDue = !lastCatalogQueue || ageMs(lastCatalogQueue) >= 30 * 60_000;
    if (catalogDue && catalogQueueDue) {
      await env.SYNC_QUEUE.send({ type: "catalog" });
      await setMetaValue(env, "catalog_last_enqueued_at", nowIso());
    }

    const groups = await activeGroups(env);
    const due = groups.filter((g) => {
      if (["queued", "syncing"].includes(g.status) && ageMs(g.last_attempt_at) < QUEUED_STALE_MINUTES * 60_000) return false;
      return !g.last_success_at || ageMs(g.last_success_at) >= GROUP_SYNC_MIN_SECONDS * 1000;
    });
    const warm = await preloadCandidates(env, PRELOAD_GROUPS_PER_CYCLE);
    const activeSlots = Math.max(0, GROUPS_PER_QUEUE_JOB - warm.length);
    const selected = [...due.slice(0, activeSlots), ...warm]
      .filter((g, index, all) => all.findIndex((x) => x.group_id === g.group_id) === index)
      .slice(0, GROUPS_PER_QUEUE_JOB);
    const stamp = nowIso();
    let queueMessages = 0;
    for (let i = 0; i < selected.length && queueMessages < MAX_SCHEDULED_QUEUE_MESSAGES; i += GROUPS_PER_QUEUE_JOB) {
      const batch = selected.slice(i, i + GROUPS_PER_QUEUE_JOB).map((g) => ({ group_id: g.group_id, department_id: g.department_id }));
      if (!batch.length) continue;
      await env.DB.batch(batch.map((g) => env.DB.prepare(
        "INSERT INTO sync_state(group_id,last_attempt_at,last_success_at,status,error) VALUES(?,?,?,?,?) " +
        "ON CONFLICT(group_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,status=excluded.status,error=NULL",
      ).bind(g.group_id, stamp, null, "queued", null)));
      await env.SYNC_QUEUE.send({ type: "groups", groups: batch });
      groupsQueued += batch.length;
      queueMessages++;
    }

    const reminderSubscriber = await env.DB.prepare(
      "SELECT 1 AS ok FROM push_subscriptions WHERE active=1 AND reminder_minutes IN (15,30,60) LIMIT 1",
    ).first();
    if (reminderSubscriber) await env.SYNC_QUEUE.send({ type: "lesson-reminders", after_endpoint: "" });
  } catch (err) {
    errors++;
    console.error("scheduled enqueue", err);
  } finally {
    await recordCycle(env, { started_at: started, finished_at: nowIso(), groups: groupsQueued, errors, duration_seconds: 0 });
  }
}

function mapResponse(roomCode) {
  const q = new URL(MAP_URL);
  q.searchParams.set("location", roomCode);
  return json({ location_url: q.toString(), directions_url: `${MAP_URL}/directions?location=${encodeURIComponent(roomCode)}` });
}

async function route(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (path === "/health" && request.method === "GET") return health(env);
  if (path === "/api/meta" && request.method === "GET") return json({ version: APP_VERSION, operator_name: env.OPERATOR_NAME || "Independent TUS Companion project", contact_email: env.CONTACT_EMAIL || "", legal_version: LEGAL_VERSION });
  if (path === "/api/catalog" && request.method === "GET") return catalog(env);
  if (path === "/api/watch" && request.method === "POST") return publicWatch(request, env);
  if (path === "/api/push/public-key" && request.method === "GET") return json({ publicKey: env.VAPID_PUBLIC_KEY || null });
  if (path === "/api/push/subscribe" && request.method === "POST") return pushSubscribe(request, env);
  if (path === "/api/push/unsubscribe" && request.method === "POST") return pushUnsubscribe(request, env);
  if (path === "/api/push/test" && request.method === "POST") return pushTest(request, env);

  let match = path.match(/^\/api\/timetable\/(.+)$/);
  if (match && request.method === "GET") return timetable(env, decodeURIComponent(match[1]));
  match = path.match(/^\/api\/changes\/(.+)$/);
  if (match && request.method === "GET") return changes(env, decodeURIComponent(match[1]), url);
  match = path.match(/^\/api\/sync-status\/(.+)$/);
  if (match && request.method === "GET") return syncStatus(env, decodeURIComponent(match[1]));
  match = path.match(/^\/api\/map\/(.+)$/);
  if (match && request.method === "GET") return mapResponse(decodeURIComponent(match[1]));

  if (path.startsWith("/api/admin/")) {
    if (!adminAuthorized(request, env)) return apiError(403, "admin-disabled-or-invalid-token");
    if (path === "/api/admin/sync-plan" && request.method === "GET") return adminSyncPlan(env);
    if (path === "/api/admin/catalog" && request.method === "POST") return adminCatalog(request, env);
    if (path === "/api/admin/result" && request.method === "POST") return adminResult(request, env);
    if (path === "/api/admin/source-session" && (request.method === "GET" || request.method === "PUT")) return adminSourceSession(request, env);
    if (path === "/api/admin/deactivate-subscription" && request.method === "POST") return adminDeactivateSubscription(request, env);
    if (path === "/api/admin/cycle" && request.method === "POST") return adminCycle(request, env);
    if (path === "/api/admin/run-catalog" && request.method === "POST") { await env.SYNC_QUEUE.send({ type: "catalog" }); return json({ queued: true }); }
    match = path.match(/^\/api\/admin\/subscriptions\/(.+)$/);
    if (match && request.method === "GET") return adminSubscriptions(env, decodeURIComponent(match[1]));
    return apiError(404, "admin-route-not-found");
  }
  return apiError(404, "not-found");
}

export default {
  async fetch(request, env) {
    try {
      await ensureReminderSchema(env);
      const url = new URL(request.url);
      if (url.pathname === "/health" || url.pathname.startsWith("/api/")) return securityHeaders(await route(request, env));
      return securityHeaders(await env.ASSETS.fetch(request));
    } catch (err) {
      console.error(err);
      return securityHeaders(apiError(500, "internal-error"));
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(ensureReminderSchema(env).then(() => enqueueScheduledWork(env)));
  },

  async queue(batch, env) {
    await ensureReminderSchema(env);
    for (const message of batch.messages) {
      const body = message.body || {};
      try {
        if (body.type === "catalog") await runCatalogJob(env);
        else if (body.type === "groups") await runGroupJob(env, body.groups || []);
        else if (body.type === "push-test") await sendTestPush(env, String(body.endpoint || ""));
        else if (body.type === "lesson-reminders") {
          const result = await sendLessonReminders(env, String(body.after_endpoint || ""));
          if (result.next_endpoint) await env.SYNC_QUEUE.send({ type: "lesson-reminders", after_endpoint: result.next_endpoint });
        }
        else if (body.type === "push-changes") {
          const changesList = Array.isArray(body.changes) ? body.changes : [];
          const result = await sendChangePushes(env, String(body.group_id || ""), changesList, String(body.after_endpoint || ""));
          if (result.next_endpoint) {
            await env.SYNC_QUEUE.send({ type: "push-changes", group_id: String(body.group_id || ""), changes: changesList, after_endpoint: result.next_endpoint });
          }
        }
        else throw new Error("unknown-queue-job");
        message.ack();
      } catch (err) {
        console.error("queue job", body.type, err);
        const messageText = String(err?.message || err);
        if (/source-session-expired|source-session-decryption|source-session-not-configured|source-session-key|source-session-invalid-json/i.test(messageText)) {
          try { await setMetaValue(env, "source_session_error", messageText); } catch (metaErr) { console.error("source session meta", metaErr); }
          message.retry({ delaySeconds: 300 });
        } else {
          message.retry({ delaySeconds: 90 });
        }
      }
    }
  },
};
