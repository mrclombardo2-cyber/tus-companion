const DAY_INDEX = new Map([
  ["Monday", 0], ["Tuesday", 1], ["Wednesday", 2], ["Thursday", 3],
  ["Friday", 4], ["Saturday", 5], ["Sunday", 6],
]);

const HEADER = ["Activity", "Module", "Type", "Start", "End", "Duration", "Weeks", "Room", "Staff", "Student Groups"];

const MONTHS = new Map([
  ["jan", 0], ["feb", 1], ["mar", 2], ["apr", 3], ["may", 4], ["jun", 5],
  ["jul", 6], ["aug", 7], ["sep", 8], ["oct", 9], ["nov", 10], ["dec", 11],
]);

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

function plainText(html) {
  return decodeEntities(String(html ?? "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseDateEnglish(value) {
  const m = String(value ?? "").trim().match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS.get(m[2].slice(0, 3).toLowerCase());
  if (month == null) return null;
  const d = new Date(Date.UTC(Number(m[3]), month, Number(m[1])));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function isoDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function addDays(iso, days) {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

export function parseWeeks(raw) {
  const out = new Set();
  for (const part0 of String(raw ?? "").trim().split(/[;,]/)) {
    const part = part0.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let a = Number(range[1]), b = Number(range[2]);
      if (a > b) [a, b] = [b, a];
      for (let x = a; x <= b; x++) out.add(x);
    } else if (/^\d+$/.test(part)) {
      out.add(Number(part));
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function normalizeRoom(raw) {
  const value = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!value) return { room_code: null, room_name: null };
  const m = value.match(/^([A-Za-z]+\d+[A-Za-z]?)\b(?:\s+(.*))?$/);
  if (!m) return { room_code: null, room_name: value };
  return { room_code: m[1].toUpperCase(), room_name: (m[2] || "").trim() || null };
}

function parseHeader(html) {
  const text = plainText(html);
  const groupMatch = text.match(/Student Group:\s*(.*?)\s+Weeks selected for output:/i);
  const group = groupMatch ? groupMatch[1].trim() : "Unknown";

  let week_number = null;
  let week_start = null;
  let week_end = null;
  const weekMatch = text.match(/Weeks selected for output:\s*(\d+)\s*\(\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s*-\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s*\)/i);
  if (weekMatch) {
    week_number = Number(weekMatch[1]);
    week_start = isoDate(parseDateEnglish(weekMatch[2]));
    week_end = isoDate(parseDateEnglish(weekMatch[3]));
  }
  return { student_group: group, week_number, week_start, week_end };
}

function extractRows(tableHtml) {
  const rows = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(tableHtml))) {
    const cells = [];
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) cells.push(plainText(cellMatch[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function normalizeTime(value) {
  const m = String(value ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return String(value ?? "").trim();
  return `${String(Number(m[1])).padStart(2, "0")}:${m[2]}`;
}

export function parseTextSpreadsheet(html, fetchedAt = new Date().toISOString()) {
  const source = String(html ?? "");
  const header = parseHeader(source);
  const events = [];

  for (const [day, dayIndex] of DAY_INDEX.entries()) {
    const marker = new RegExp(`<p\\b[^>]*>[\\s\\S]*?\\b${day}\\b[\\s\\S]*?<\\/p>`, "i");
    const hit = marker.exec(source);
    if (!hit) continue;
    const after = source.slice(hit.index + hit[0].length);
    const tableMatch = after.match(/^\s*<table\b[^>]*>([\s\S]*?)<\/table>/i);
    if (!tableMatch) continue;
    const rows = extractRows(tableMatch[1]);
    if (!rows.length || rows[0].length !== HEADER.length || rows[0].some((x, i) => x !== HEADER[i])) continue;

    for (const cells of rows.slice(1)) {
      if (cells.length !== 10) continue;
      const room = normalizeRoom(cells[7]);
      events.push({
        day,
        date: addDays(header.week_start, dayIndex),
        activity: cells[0],
        module: cells[1],
        type: cells[2],
        start: normalizeTime(cells[3]),
        end: normalizeTime(cells[4]),
        duration: cells[5],
        weeks_raw: cells[6],
        weeks: parseWeeks(cells[6]),
        room_raw: cells[7],
        room_code: room.room_code,
        room_name: room.room_name,
        staff: cells[8],
        student_groups: cells[9].split(";").map((x) => x.trim()).filter(Boolean),
      });
    }
  }

  return {
    student_group: header.student_group,
    group_id: null,
    department_id: null,
    week_number: header.week_number,
    week_start: header.week_start,
    week_end: header.week_end,
    fetched_at: fetchedAt,
    events,
  };
}

function stableKey(e) {
  return JSON.stringify([
    String(e.day || "").toLowerCase(),
    String(e.module || "").trim().toLowerCase(),
    String(e.activity || "").trim().toLowerCase(),
    [...(e.student_groups || [])].map((x) => String(x).toLowerCase()).sort(),
  ]);
}

function timeMinutes(value) {
  const [h, m] = String(value || "0:0").split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function pair(before, after) {
  const remaining = [...after];
  const pairs = [];
  for (const b of before) {
    if (!remaining.length) {
      pairs.push([b, null]);
      continue;
    }
    let bestIndex = 0;
    let bestDelta = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const delta = Math.abs(timeMinutes(remaining[i].start) - timeMinutes(b.start));
      if (delta < bestDelta) { bestDelta = delta; bestIndex = i; }
    }
    const [a] = remaining.splice(bestIndex, 1);
    pairs.push([b, a]);
  }
  for (const a of remaining) pairs.push([null, a]);
  return pairs;
}

export function diffSnapshots(before, after, detectedAt = new Date().toISOString()) {
  if (!before) return [];
  const bmap = new Map(), amap = new Map();
  for (const e of before.events || []) {
    const k = stableKey(e); if (!bmap.has(k)) bmap.set(k, []); bmap.get(k).push(e);
  }
  for (const e of after.events || []) {
    const k = stableKey(e); if (!amap.has(k)) amap.set(k, []); amap.get(k).push(e);
  }
  const changes = [];
  const keys = [...new Set([...bmap.keys(), ...amap.keys()])].sort();
  for (const key of keys) {
    for (const [b, a] of pair(bmap.get(key) || [], amap.get(key) || [])) {
      const exemplar = a || b;
      const base = { module: exemplar.module, activity: exemplar.activity, day: exemplar.day, detected_at: detectedAt };
      if (!b) { changes.push({ change_type: "CLASS_ADDED", before: null, after: a, ...base }); continue; }
      if (!a) { changes.push({ change_type: "CLASS_REMOVED", before: b, after: null, ...base }); continue; }
      if (b.start !== a.start || b.end !== a.end) changes.push({ change_type: "TIME_CHANGED", before: b, after: a, ...base });
      if ((b.room_code || b.room_raw) !== (a.room_code || a.room_raw)) changes.push({ change_type: "ROOM_CHANGED", before: b, after: a, ...base });
      if (String(b.staff || "").trim().toLowerCase() !== String(a.staff || "").trim().toLowerCase()) changes.push({ change_type: "LECTURER_CHANGED", before: b, after: a, ...base });
      if (String(b.type || "").trim().toLowerCase() !== String(a.type || "").trim().toLowerCase()) changes.push({ change_type: "CLASS_TYPE_CHANGED", before: b, after: a, ...base });
      if (String(b.weeks_raw || "").trim().toLowerCase() !== String(a.weeks_raw || "").trim().toLowerCase()) changes.push({ change_type: "TEACHING_WEEKS_CHANGED", before: b, after: a, ...base });
    }
  }
  return changes;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortObject(value[key]);
    return out;
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(sortObject(value));
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256(value) {
  const data = new TextEncoder().encode(typeof value === "string" ? value : stableStringify(value));
  return hex(await crypto.subtle.digest("SHA-256", data));
}

export async function snapshotContentHash(snapshot) {
  const content = { ...(snapshot || {}) };
  delete content.fetched_at;
  return sha256(stableStringify(content));
}

export async function enrichChanges(groupId, changes) {
  const out = [];
  for (const ch of changes) {
    out.push({ ...ch, dedupe_hash: await sha256(`${groupId}|${stableStringify(ch)}`) });
  }
  return out;
}
