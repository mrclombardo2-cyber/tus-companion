function icsEscape(value="") {
  return String(value).replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
}
function localDateTime(date,time){const d=String(date||"").replace(/-/g,""),t=String(time||"00:00").replace(":","").padEnd(4,"0");return `${d}T${t}00`}
function utcDateTime(value){const d=new Date(value||Date.now());if(Number.isNaN(d.getTime()))return utcDateTime(Date.now());return d.toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z")}
function eventUid(groupId,event){const raw=[groupId,event?.date,event?.start,event?.end,event?.module,event?.activity].join("-");return `tc-${raw.replace(/[^A-Za-z0-9.-]+/g,"-").replace(/-+/g,"-").slice(0,180)}@tus-companion`}
function foldLine(line){const text=String(line);if(text.length<=72)return text;const parts=[];for(let i=0;i<text.length;i+=72)parts.push((i?" ":"")+text.slice(i,i+72));return parts.join("\r\n")}
function eventKey(event){return [event?.date,event?.start,event?.end,event?.module,event?.activity,event?.room_code||event?.room_raw].join("|")}
export function buildCalendar({groupId,groupLabel,snapshot,origin="https://tus-companion.tusathlone.workers.dev"}){
  const raw=[...(snapshot?.events||[]),...(snapshot?.next_week?.events||[])],seen=new Set();
  const events=raw.filter(event=>{if(!event?.date||!event?.start||!event?.end)return false;const key=eventKey(event);if(seen.has(key))return false;seen.add(key);return true}).sort((a,b)=>`${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
  const lines=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//TUS Companion//Timetable//EN","CALSCALE:GREGORIAN","METHOD:PUBLISH",`X-WR-CALNAME:${icsEscape(`TUS Companion - ${groupLabel||groupId||"Timetable"}`)}`,"X-WR-TIMEZONE:Europe/Dublin","REFRESH-INTERVAL;VALUE=DURATION:PT5M","X-PUBLISHED-TTL:PT5M","BEGIN:VTIMEZONE","TZID:Europe/Dublin","X-LIC-LOCATION:Europe/Dublin","BEGIN:DAYLIGHT","TZOFFSETFROM:+0000","TZOFFSETTO:+0100","TZNAME:IST","DTSTART:19700329T010000","RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU","END:DAYLIGHT","BEGIN:STANDARD","TZOFFSETFROM:+0100","TZOFFSETTO:+0000","TZNAME:GMT","DTSTART:19701025T020000","RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU","END:STANDARD","END:VTIMEZONE"];
  const stamp=utcDateTime(snapshot?.fetched_at);
  for(const event of events){const location=[event.room_code||event.room_raw,event.room_name].filter(Boolean).join(" · "),description=[event.type,event.staff].filter(Boolean).join(" · ");lines.push("BEGIN:VEVENT",`UID:${eventUid(groupId,event)}`,`DTSTAMP:${stamp}`,`LAST-MODIFIED:${stamp}`,`DTSTART;TZID=Europe/Dublin:${localDateTime(event.date,event.start)}`,`DTEND;TZID=Europe/Dublin:${localDateTime(event.date,event.end)}`,`SUMMARY:${icsEscape(event.module||event.activity||"Class")}`,`LOCATION:${icsEscape(location)}`,`DESCRIPTION:${icsEscape(description)}`,`URL:${origin}/?tab=week`,"STATUS:CONFIRMED","END:VEVENT")}
  lines.push("END:VCALENDAR");return lines.map(foldLine).join("\r\n")+"\r\n";
}
