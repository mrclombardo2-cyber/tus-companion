export const TUS_BASE_URL = "https://timetables.midlands.tus.ie/2627/default.aspx";
export const TUS_SHOW_URL = "https://timetables.midlands.tus.ie/2627/showtimetable.aspx";
export const TEXT_LAYOUT = "TextSpreadsheet;swsurl;student+set+textspreadsheet";

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function attrs(tag) {
  const out = {};
  const re = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(tag))) {
    const key = m[1].toLowerCase();
    if (key === "input" || key === "select" || key === "option" || key === "table" || key === "form") continue;
    out[key] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

export function extractInputs(html) {
  const result = {};
  const re = /<input\b[^>]*>/gi;
  let m;
  while ((m = re.exec(String(html ?? "")))) {
    const a = attrs(m[0]);
    const name = a.name || a.id;
    if (!name) continue;
    const type = String(a.type || "text").toLowerCase();
    if ((type === "radio" || type === "checkbox") && !("checked" in a)) continue;
    if (type === "submit" || type === "button" || type === "image") continue;
    result[name] = a.value ?? "";
  }
  return result;
}

export function extractSelect(html, idOrName) {
  const source = String(html ?? "");
  const re = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let m;
  while ((m = re.exec(source))) {
    const a = attrs(`<select ${m[1]}>`);
    if ((a.id || a.name) !== idOrName) continue;
    const options = [];
    const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    let om;
    while ((om = optRe.exec(m[2]))) {
      const oa = attrs(`<option ${om[1]}>`);
      options.push({
        value: oa.value ?? "",
        label: decodeEntities(om[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(),
        selected: "selected" in oa,
      });
    }
    return { name: a.name || a.id || idOrName, multiple: "multiple" in a, options };
  }
  return null;
}

export function extractCurrentFormValues(html) {
  const values = extractInputs(html);
  for (const name of ["dlFilter2", "dlObject", "lbWeeks", "lbDays", "dlPeriod"]) {
    const select = extractSelect(html, name);
    if (!select) continue;
    const selected = select.options.filter((x) => x.selected && x.value !== "");
    const chosen = selected.length ? selected : select.options.filter((x) => x.value !== "").slice(0, 1);
    if (chosen.length) values[select.name] = chosen[0].value;
  }
  const radios = /<input\b[^>]*type\s*=\s*["']?radio["']?[^>]*>/gi;
  let rm;
  while ((rm = radios.exec(String(html ?? "")))) {
    const a = attrs(rm[0]);
    if (("checked" in a) && a.name) values[a.name] = a.value ?? "";
  }
  return values;
}

function formBody(html, overrides = {}) {
  const values = { ...extractCurrentFormValues(html), ...overrides };
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value == null) continue;
    if (Array.isArray(value)) value.forEach((x) => body.append(key, String(x)));
    else body.set(key, String(value));
  }
  return body;
}

function domainMatches(host, domain) {
  const d = String(domain || "").replace(/^\./, "").toLowerCase();
  const h = String(host || "").toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

function pathMatches(pathname, cookiePath) {
  const p = cookiePath || "/";
  return pathname.startsWith(p);
}

function splitSetCookie(value) {
  if (!value) return [];
  return String(value).split(/,(?=\s*[^;,\s]+=)/g).map((x) => x.trim()).filter(Boolean);
}

function setCookieLines(headers) {
  if (typeof headers.getSetCookie === "function") {
    const lines = headers.getSetCookie();
    if (Array.isArray(lines) && lines.length) return lines;
  }
  return splitSetCookie(headers.get("set-cookie"));
}

function normalizeSameSite(raw) {
  const v = String(raw || "").toLowerCase();
  if (v === "strict") return "Strict";
  if (v === "none") return "None";
  return "Lax";
}

export class CookieJar {
  constructor(storageState) {
    this.state = storageState && typeof storageState === "object" ? structuredClone(storageState) : { cookies: [], origins: [] };
    if (!Array.isArray(this.state.cookies)) this.state.cookies = [];
    if (!Array.isArray(this.state.origins)) this.state.origins = [];
  }

  header(url) {
    const u = new URL(url);
    const now = Date.now() / 1000;
    return this.state.cookies
      .filter((c) => c?.name && domainMatches(u.hostname, c.domain || u.hostname) && pathMatches(u.pathname, c.path || "/") && (!c.secure || u.protocol === "https:") && (!(Number(c.expires) > 0) || Number(c.expires) > now))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  update(headers, requestUrl) {
    const request = new URL(requestUrl);
    for (const line of setCookieLines(headers)) {
      const parts = line.split(";").map((x) => x.trim());
      const eq = parts[0].indexOf("=");
      if (eq <= 0) continue;
      const name = parts[0].slice(0, eq).trim();
      const value = parts[0].slice(eq + 1);
      const meta = {};
      for (const part of parts.slice(1)) {
        const i = part.indexOf("=");
        const k = (i >= 0 ? part.slice(0, i) : part).trim().toLowerCase();
        const v = i >= 0 ? part.slice(i + 1).trim() : "";
        meta[k] = v || true;
      }
      const domain = typeof meta.domain === "string" ? meta.domain : request.hostname;
      const path = typeof meta.path === "string" ? meta.path : "/";
      let expires = -1;
      if (typeof meta["max-age"] === "string") {
        const seconds = Number(meta["max-age"]);
        if (Number.isFinite(seconds)) expires = Math.floor(Date.now() / 1000 + seconds);
      } else if (typeof meta.expires === "string") {
        const ms = Date.parse(meta.expires);
        if (Number.isFinite(ms)) expires = Math.floor(ms / 1000);
      }
      const idx = this.state.cookies.findIndex((c) => c.name === name && String(c.domain || "").replace(/^\./, "") === String(domain).replace(/^\./, "") && (c.path || "/") === path);
      if (expires === 0 || (expires > 0 && expires <= Date.now() / 1000)) {
        if (idx >= 0) this.state.cookies.splice(idx, 1);
        continue;
      }
      const cookie = {
        name, value, domain, path, expires,
        httpOnly: Boolean(meta.httponly), secure: Boolean(meta.secure),
        sameSite: normalizeSameSite(meta.samesite),
      };
      if (idx >= 0) this.state.cookies[idx] = { ...this.state.cookies[idx], ...cookie };
      else this.state.cookies.push(cookie);
    }
  }

  json() { return this.state; }
}

async function readText(response) {
  const type = response.headers.get("content-type") || "";
  const bytes = await response.arrayBuffer();
  const label = /charset\s*=\s*(?:iso-8859-1|windows-1252)/i.test(type) ? "windows-1252" : "utf-8";
  try { return new TextDecoder(label).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

export class ScientiaSession {
  constructor(storageState, fetchImpl = fetch) {
    this.cookies = new CookieJar(storageState);
    this.fetchImpl = fetchImpl;
  }

  async request(url, init = {}, redirects = 0) {
    if (redirects > 5) throw new Error("tus-too-many-redirects");
    const headers = new Headers(init.headers || {});
    const cookie = this.cookies.header(url);
    if (cookie) headers.set("cookie", cookie);
    headers.set("user-agent", "Mozilla/5.0 (compatible; TUS-Companion/1.8; +https://workers.dev)");
    headers.set("accept", headers.get("accept") || "text/html,application/xhtml+xml");
    const response = await this.fetchImpl(url, { ...init, headers, redirect: "manual" });
    this.cookies.update(response.headers, url);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`tus-redirect-${response.status}`);
      const next = new URL(location, url);
      if (next.hostname !== new URL(TUS_BASE_URL).hostname) throw new Error("source-session-expired");
      const originalMethod = String(init.method || "GET").toUpperCase();
      const preserveRequest = response.status === 307 || response.status === 308;
      const nextInit = preserveRequest
        ? { ...init, method: originalMethod }
        : { method: "GET" };
      return this.request(next.toString(), nextInit, redirects + 1);
    }
    if (!response.ok) throw new Error(`tus-http-${response.status}`);
    return readText(response);
  }

  async post(html, overrides) {
    const body = formBody(html, overrides);
    return this.request(TUS_BASE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  }

  async postback(html, target, overrides = {}) {
    return this.post(html, { ...overrides, __EVENTTARGET: target, __EVENTARGUMENT: "" });
  }

  async ensureReady() {
    let html = await this.request(TUS_BASE_URL);
    if (/id=["']dlFilter2["']/i.test(html)) return html;
    if (/id=["']LinkBtn_StudentSetByName["']/i.test(html)) {
      html = await this.postback(html, "LinkBtn_StudentSetByName");
      if (/id=["']dlFilter2["']/i.test(html)) return html;
    }
    throw new Error("source-session-expired");
  }

  async fetchTimetable(department, group, week = "t", days = "1-7", period = "1-28") {
    let html = await this.ensureReady();
    const dep = extractSelect(html, "dlFilter2");
    const currentDep = dep?.options.find((x) => x.selected)?.value || "";
    if (currentDep !== department) html = await this.postback(html, "dlFilter2", { dlFilter2: department });

    const groupSelect = extractSelect(html, "dlObject");
    if (!groupSelect?.options.some((x) => x.value === group)) throw new Error("unknown-group-in-department");

    const currentWeek = extractSelect(html, "lbWeeks")?.options.find((x) => x.selected)?.value || "";
    if (currentWeek !== week) html = await this.postback(html, "lbWeeks", { dlFilter2: department, dlObject: group, lbWeeks: week });

    const currentPeriod = extractSelect(html, "dlPeriod")?.options.find((x) => x.selected)?.value || "";
    if (currentPeriod !== period) html = await this.postback(html, "dlPeriod", { dlFilter2: department, dlObject: group, lbWeeks: week, lbDays: days, dlPeriod: period });

    await this.post(html, {
      __EVENTTARGET: "",
      __EVENTARGUMENT: "",
      dlFilter2: department,
      dlObject: group,
      lbWeeks: week,
      lbDays: days,
      dlPeriod: period,
      RadioType: TEXT_LAYOUT,
      bGetTimetable: "View Timetable",
    });
    const timetable = await this.request(TUS_SHOW_URL);
    if (!/Student Set TextSpreadsheet/i.test(timetable)) throw new Error("unexpected-timetable-layout");
    return timetable;
  }

  async scrapeCatalog() {
    let html = await this.ensureReady();
    const deps = (extractSelect(html, "dlFilter2")?.options || []).filter((x) => x.value).map((x) => ({ value: x.value, label: x.label, selected: x.selected }));
    const department_groups = [];
    for (const dep of deps) {
      const current = extractSelect(html, "dlFilter2")?.options.find((x) => x.selected)?.value || "";
      if (current !== dep.value) html = await this.postback(html, "dlFilter2", { dlFilter2: dep.value });
      const groups = (extractSelect(html, "dlObject")?.options || []).filter((x) => x.value).map((x) => ({ value: x.value, label: x.label, selected: x.selected }));
      department_groups.push({ department_id: dep.value, groups });
    }
    return { departments: deps, department_groups };
  }

  storageState() { return this.cookies.json(); }
}
