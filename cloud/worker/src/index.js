import webpush from "web-push";

const APP_VERSION = "1.8.0-cloud";
const LEGAL_VERSION = "2026-09-29";
const INTEREST_TTL_DAYS = 30;
const INTEREST_TOUCH_MINUTES = 1;
const CATALOG_REFRESH_HOURS = 24;
const MAP_URL = "https://app.mappedin.com/map/68b1b5dd74254a000bbf174b";

function nowIso() {
  return new Date().toISOString();
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function apiError(status, detail) {
  return json({ detail }, status);
}

async function bodyJson(request, maxBytes = 65536) {
  const length = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > maxBytes) throw new Error("payload-too-large");
  const text = await request.text();
  if (text.length > maxBytes) throw new Error("payload-too-large");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid-json");
  }
}

function adminAuthorized(request, env) {
  const token = request.headers.get("x-admin-token") || "";
  return Boolean(env.ADMIN_TOKEN && token && token === env.ADMIN_TOKEN);
}

function safeParse(value, fallback = null) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseHidden(value) {
  const parsed = safeParse(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function securityHeaders(response) {
  const h = new Headers(response.headers);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "geolocation=(self), camera=(), microphone=()");
  h.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
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
  const [lastCycle, lastCycleOk, catalogAt] = await Promise.all([
    getMetaValue(env, "last_cycle_finished_at"),
    getMetaValue(env, "last_cycle_errors"),
    getMetaValue(env, "catalog_updated_at"),
  ]);
  return json({
    status: "ok",
    platform: "cloudflare-workers-d1",
    version: APP_VERSION,
    collector: {
      schedule_target_seconds: 300,
      hot_schedule_target_seconds: 60,
      last_cycle_finished_at: lastCycle,
      last_cycle_errors: lastCycleOk == null ? null : Number(lastCycleOk),
      catalog_updated_at: catalogAt,
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
  return json({
    departments: (depsRes.results || []).map((d) => ({ id: d.id, label: d.label, groups: by.get(d.id) || [] })),
  });
}

async function groupExists(env, groupId, departmentId = null) {
  const query = departmentId
    ? env.DB.prepare("SELECT 1 AS ok FROM groups WHERE id=? AND department_id=? LIMIT 1").bind(groupId, departmentId)
    : env.DB.prepare("SELECT 1 AS ok FROM groups WHERE id=? LIMIT 1").bind(groupId);
  return Boolean(await query.first());
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
  const now = Date.now();
  const oldMs = existing?.last_seen_at ? Date.parse(existing.last_seen_at) : 0;
  if (!existing || !Number.isFinite(oldMs) || now - oldMs >= INTEREST_TOUCH_MINUTES * 60_000) {
    await env.DB.prepare(
      "INSERT INTO interests(group_id,department_id,last_seen_at) VALUES(?,?,?) ON CONFLICT(group_id) DO UPDATE SET department_id=excluded.department_id,last_seen_at=excluded.last_seen_at",
    ).bind(groupId, departmentId, nowIso()).run();
  }

  const snap = await env.DB.prepare("SELECT 1 AS ok FROM latest_snapshots WHERE group_id=?").bind(groupId).first();
  let sync = await env.DB.prepare("SELECT * FROM sync_state WHERE group_id=?").bind(groupId).first();
  if (!sync) {
    const stamp = nowIso();
    await env.DB.prepare(
      "INSERT INTO sync_state(group_id,last_attempt_at,last_success_at,status,error) VALUES(?,?,?,?,?)",
    ).bind(groupId, stamp, null, "queued", null).run();
    sync = { group_id: groupId, last_attempt_at: stamp, last_success_at: null, status: "queued", error: null };
  }
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
  const rows = (res.results || []).map((r) => ({
    id: r.id,
    group_id: r.group_id,
    detected_at: r.detected_at,
    change_type: r.change_type,
    module: r.module,
    activity: r.activity,
    day: r.day,
    before: safeParse(r.before_json, null),
    after: safeParse(r.after_json, null),
  }));
  return json(rows);
}

async function pushSubscribe(request, env) {
  let req;
  try { req = await bodyJson(request); } catch { return apiError(400, "invalid-json"); }
  const groupId = String(req.group_id || "");
  const endpoint = String(req.endpoint || "");
  const p256dh = String(req.keys?.p256dh || "");
  const auth = String(req.keys?.auth || "");
  const hidden = Array.isArray(req.hidden_modules)
    ? [...new Set(req.hidden_modules.slice(0, 100).map((x) => String(x).slice(0, 256)))].sort()
    : [];
  let endpointUrl = null;
  try { endpointUrl = new URL(endpoint); } catch {}
  if (!groupId || groupId.length > 256 || !endpoint || endpoint.length > 4096 || endpointUrl?.protocol !== "https:" ||
      !p256dh || p256dh.length > 512 || !auth || auth.length > 256 || !(await groupExists(env, groupId))) {
    return apiError(400, "invalid-subscription");
  }
  await env.DB.prepare(
    "INSERT INTO push_subscriptions(endpoint,group_id,p256dh,auth,created_at,active,hidden_modules) VALUES(?,?,?,?,?,1,?) " +
    "ON CONFLICT(endpoint) DO UPDATE SET group_id=excluded.group_id,p256dh=excluded.p256dh,auth=excluded.auth,active=1,hidden_modules=excluded.hidden_modules",
  ).bind(endpoint, groupId, p256dh, auth, nowIso(), JSON.stringify(hidden)).run();
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
  const row = await env.DB.prepare(
    "SELECT endpoint,p256dh,auth,active FROM push_subscriptions WHERE endpoint=? LIMIT 1",
  ).bind(endpoint).first();
  if (!row || !row.active) return apiError(404, "subscription-not-found");

  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  try {
    await webpush.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      JSON.stringify({
        title: "TUS Companion test",
        body: "Notifications are working on this device.",
        url: "/?tab=settings",
        tag: "tus-companion-test",
      }),
      { TTL: 60 },
    );
    return json({ sent: 1, disabled: false });
  } catch (err) {
    const statusCode = Number(err?.statusCode || 0);
    if (statusCode === 404 || statusCode === 410) {
      await env.DB.prepare("UPDATE push_subscriptions SET active=0 WHERE endpoint=?").bind(endpoint).run();
    }
    return apiError(503, `push-failed${statusCode ? `-${statusCode}` : ""}`);
  }
}

async function adminSyncPlan(env, url = null) {
  const preload = url?.searchParams.get("preload") === "missing";
  const hot = url?.searchParams.get("hot") === "1";
  const requestedLimit = Number(url?.searchParams.get("limit") || 25);
  const preloadLimit = Math.max(1, Math.min(50, Number.isFinite(requestedLimit) ? requestedLimit : 25));
  let res;

  if (preload) {
    res = await env.DB.prepare(
      `SELECT g.id AS group_id,g.department_id,g.label,s.payload,s.payload_hash,st.last_success_at,st.status
       FROM groups g
       LEFT JOIN latest_snapshots s ON s.group_id=g.id
       LEFT JOIN sync_state st ON st.group_id=g.id
       WHERE s.group_id IS NULL
       ORDER BY g.label
       LIMIT ?`,
    ).bind(preloadLimit).all();
  } else if (hot) {
    const hotCutoff = new Date(Date.now() - 3 * 60_000).toISOString();
    res = await env.DB.prepare(
      `WITH hot_groups AS (
         SELECT group_id, department_id FROM interests WHERE last_seen_at >= ?
         UNION
         SELECT DISTINCT p.group_id, g.department_id
         FROM push_subscriptions p JOIN groups g ON g.id=p.group_id
         WHERE p.active=1
       )
       SELECT h.group_id,h.department_id,g.label,s.payload,s.payload_hash,st.last_success_at,st.status
       FROM hot_groups h
       LEFT JOIN groups g ON g.id=h.group_id
       LEFT JOIN latest_snapshots s ON s.group_id=h.group_id
       LEFT JOIN sync_state st ON st.group_id=h.group_id
       ORDER BY g.label`,
    ).bind(hotCutoff).all();
  } else {
    const cutoff = new Date(Date.now() - INTEREST_TTL_DAYS * 86400_000).toISOString();
    res = await env.DB.prepare(
      `WITH active AS (
         SELECT group_id, department_id FROM interests WHERE last_seen_at >= ?
         UNION
         SELECT DISTINCT p.group_id, g.department_id
         FROM push_subscriptions p JOIN groups g ON g.id=p.group_id
         WHERE p.active=1
       )
       SELECT a.group_id,a.department_id,g.label,s.payload,s.payload_hash,st.last_success_at,st.status
       FROM active a
       LEFT JOIN groups g ON g.id=a.group_id
       LEFT JOIN latest_snapshots s ON s.group_id=a.group_id
       LEFT JOIN sync_state st ON st.group_id=a.group_id
       ORDER BY g.label`,
    ).bind(cutoff).all();
  }

  const catalogAt = await getMetaValue(env, "catalog_updated_at");
  const catalogMs = catalogAt ? Date.parse(catalogAt) : 0;
  const refreshDue = !catalogAt || !Number.isFinite(catalogMs) || Date.now() - catalogMs >= CATALOG_REFRESH_HOURS * 3600_000;

  return json({
    mode: preload ? "preload-missing" : hot ? "hot" : "active",
    catalog_refresh_due: preload || hot ? false : refreshDue,
    groups: (res.results || []).map((r) => ({
      group_id: r.group_id,
      department_id: r.department_id,
      label: r.label,
      snapshot: safeParse(r.payload, null),
      payload_hash: r.payload_hash || null,
      last_success_at: r.last_success_at || null,
      status: r.status || null,
    })),
  });
}

async function adminCatalog(request, env) {
  let payload;
  try { payload = await bodyJson(request, 2_000_000); } catch { return apiError(400, "invalid-json"); }
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
  for (let i = 0; i < statements.length; i += 40) {
    await env.DB.batch(statements.slice(i, i + 40));
  }
  await setMetaValue(env, "catalog_updated_at", stamp);
  return json({ departments: deps.length, groups: departmentGroups.reduce((n, x) => n + (Array.isArray(x.groups) ? x.groups.length : 0), 0) });
}

async function adminResult(request, env) {
  let req;
  try { req = await bodyJson(request); } catch { return apiError(400, "invalid-json"); }
  const groupId = String(req.group_id || "");
  if (!groupId) return apiError(400, "missing-group-id");
  const stamp = nowIso();
  if (req.error) {
    await env.DB.prepare(
      "INSERT INTO sync_state(group_id,last_attempt_at,last_success_at,status,error) VALUES(?,?,?,?,?) " +
      "ON CONFLICT(group_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,status=excluded.status,error=excluded.error",
    ).bind(groupId, stamp, null, "error", String(req.error).slice(0, 1000)).run();
    return json({ ok: true, saved_snapshot: false, saved_changes: 0 });
  }

  if (!req.snapshot || !req.payload_hash) return apiError(400, "missing-snapshot");
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
  const changeList = Array.isArray(req.changes) ? req.changes.slice(0, 40) : [];
  for (const ch of changeList) {
    if (!ch?.change_type || !ch?.dedupe_hash) continue;
    const result = await env.DB.prepare(
      "INSERT OR IGNORE INTO changes(group_id,detected_at,change_type,module,activity,day,before_json,after_json,dedupe_hash) VALUES(?,?,?,?,?,?,?,?,?)",
    ).bind(
      groupId,
      String(ch.detected_at || stamp),
      String(ch.change_type),
      ch.module == null ? null : String(ch.module),
      ch.activity == null ? null : String(ch.activity),
      ch.day == null ? null : String(ch.day),
      ch.before == null ? null : JSON.stringify(ch.before),
      ch.after == null ? null : JSON.stringify(ch.after),
      String(ch.dedupe_hash),
    ).run();
    if (result.meta?.changes) savedChanges += Number(result.meta.changes);
  }

  await env.DB.prepare(
    "INSERT INTO sync_state(group_id,last_attempt_at,last_success_at,status,error) VALUES(?,?,?,?,?) " +
    "ON CONFLICT(group_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,status=excluded.status,error=NULL",
  ).bind(groupId, stamp, stamp, "ok", null).run();
  return json({ ok: true, saved_snapshot: savedSnapshot, saved_changes: savedChanges });
}

async function adminSubscriptions(env, groupId) {
  const res = await env.DB.prepare(
    "SELECT endpoint,p256dh,auth,hidden_modules FROM push_subscriptions WHERE group_id=? AND active=1",
  ).bind(groupId).all();
  return json((res.results || []).map((r) => ({
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    hidden_modules: parseHidden(r.hidden_modules),
  })));
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
  return json({ ok: true });
}

async function adminCycle(request, env) {
  let req;
  try { req = await bodyJson(request); } catch { return apiError(400, "invalid-json"); }
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
  return json({ ok: true });
}

function mapResponse(roomCode, url) {
  const departure = url.searchParams.get("departure");
  const accessible = url.searchParams.get("accessible") === "true";
  const q = new URL(`${MAP_URL}/directions`);
  q.searchParams.set("location", roomCode);
  if (departure) q.searchParams.set("departure", departure);
  if (accessible) q.searchParams.set("accessible", "true");
  return json({ location_url: `${MAP_URL}?location=${encodeURIComponent(roomCode)}`, directions_url: q.toString() });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/health" && request.method === "GET") return health(env);
  if (path === "/api/meta" && request.method === "GET") {
    return json({
      version: APP_VERSION,
      operator_name: env.OPERATOR_NAME || "Independent TUS Companion project",
      contact_email: env.CONTACT_EMAIL || "",
      legal_version: LEGAL_VERSION,
    });
  }
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
  if (match && request.method === "GET") return mapResponse(decodeURIComponent(match[1]), url);

  if (path.startsWith("/api/admin/")) {
    if (!adminAuthorized(request, env)) return apiError(403, "admin-disabled-or-invalid-token");
    if (path === "/api/admin/sync-plan" && request.method === "GET") return adminSyncPlan(env, url);
    if (path === "/api/admin/catalog" && request.method === "POST") return adminCatalog(request, env);
    if (path === "/api/admin/result" && request.method === "POST") return adminResult(request, env);
    if (path === "/api/admin/source-session" && (request.method === "GET" || request.method === "PUT")) return adminSourceSession(request, env);
    if (path === "/api/admin/deactivate-subscription" && request.method === "POST") return adminDeactivateSubscription(request, env);
    if (path === "/api/admin/cycle" && request.method === "POST") return adminCycle(request, env);
    match = path.match(/^\/api\/admin\/subscriptions\/(.+)$/);
    if (match && request.method === "GET") return adminSubscriptions(env, decodeURIComponent(match[1]));
    return apiError(404, "admin-route-not-found");
  }

  return apiError(404, "not-found");
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health" || url.pathname.startsWith("/api/")) {
        return securityHeaders(await route(request, env));
      }
      return securityHeaders(await env.ASSETS.fetch(request));
    } catch (err) {
      console.error(err);
      return securityHeaders(apiError(500, "internal-error"));
    }
  },
};
