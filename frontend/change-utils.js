// The change feed is a history of differences between verified TUS snapshots.
// It is NOT a patch queue: Week/Today must display the latest fetched snapshot.
function norm(value) {
  return String(value ?? "").trim().toLocaleLowerCase("en");
}
function eventIdentity(event) {
  if (!event) return null;
  return [
    norm(event.module), norm(event.activity), norm(event.day),
    norm(event.date), norm(event.start), norm(event.end),
    [...(event.student_groups || [])].map(norm).sort().join(","),
  ];
}
function key(change) {
  const before = eventIdentity(change.before);
  const after = eventIdentity(change.after);
  return JSON.stringify([norm(change.detected_at), before, after]);
}

export function groupTimetableChanges(changes) {
  const groups = new Map();
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.change_type) continue;
    const id = key(change);
    if (!groups.has(id)) {
      groups.set(id, {
        key: id,
        module: change.module || change.after?.module || change.before?.module || "Class",
        activity: change.activity || change.after?.activity || change.before?.activity || "",
        day: change.day || change.after?.day || change.before?.day || "",
        detected_at: change.detected_at || null,
        before: change.before || null,
        after: change.after || null,
        changes: [],
      });
    }
    const group = groups.get(id);
    if (!group.changes.some(row => row.change_type === change.change_type)) group.changes.push(change);
  }
  return [...groups.values()];
}

// A badge is shown only for a current event that is an exact match for the
// verified 'after' state. This prevents historical/outdated changes from
// overwriting the live schedule or marking unrelated repeated classes.
export function eventMatchesAfter(event, after) {
  if (!event || !after || !event.date || !after.date) return false;
  for (const name of ["date", "module", "activity", "day", "start", "end"]) {
    if (norm(event[name]) !== norm(after[name])) return false;
  }
  for (const name of ["type", "staff", "weeks_raw"]) {
    if (after[name] != null && norm(event[name]) !== norm(after[name])) return false;
  }
  const room = (value) => norm(value?.room_code || value?.room_raw);
  if (room(event) !== room(after)) return false;
  const groups = (value) => [...(value?.student_groups || [])].map(norm).sort().join(",");
  return groups(event) === groups(after);
}
export function matchingChangesForEvent(event, changes) {
  return groupTimetableChanges(changes).find(group => eventMatchesAfter(event, group.after)) || null;
}
export function teachingWeeksLabel(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "not specified";
  const chunks = text.split(/[;,]/).map(x => x.trim()).filter(Boolean);
  if (!chunks.length) return "not specified";
  const out = chunks.map(x => {
    const range = x.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) return "weeks " + range[1] + "–" + range[2];
    if (/^\d+$/.test(x)) return "week " + x;
    return x;
  });
  return out.join(", ");
}
export function currentChangeBadge(group) {
  if (!group) return "";
  const types = new Set(group.changes.map(c => c.change_type));
  if (types.has("ROOM_CHANGED") && types.size === 1) return "New room";
  if (types.has("TIME_CHANGED") && types.size === 1) return "New time";
  return "Changed";
}


// The TUS timetable header week and the event's teaching-weeks field are
// different things. Never infer the former from e.weeks_raw (e.g. "13").
export function affectedTimetableWeek(changeGroup, loadedWeeks = []) {
  const event = changeGroup?.after || changeGroup?.before;
  const validWeek = n => n != null && Number.isInteger(Number(n)) && Number(n) > 0;
  if (validWeek(event?.timetable_week_number)) return Number(event.timetable_week_number);
  // Backfill for older change records which predate persistent week metadata.
  // The date must lie inside an actual fetched TUS timetable snapshot.
  const date = event?.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return null;
  const matched = (loadedWeeks || []).find(week => week?.week_start && week?.week_end &&
    date >= week.week_start && date <= week.week_end && validWeek(week.week_number));
  return matched ? Number(matched.week_number) : null;
}
export function formatDetectionIrish(iso) {
  if (!iso) return "Detection time unavailable";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Detection time unavailable";
  const date = new Intl.DateTimeFormat("en-IE", {
    timeZone:"Europe/Dublin",weekday:"long",day:"numeric",month:"short",year:"numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone:"Europe/Dublin",hour:"2-digit",minute:"2-digit",hourCycle:"h23",
  }).format(d);
  return date + " · " + time + " (Irish time)";
}
