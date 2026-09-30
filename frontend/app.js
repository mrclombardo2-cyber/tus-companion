const APP=document.getElementById('app');
const STORE='tus-companion-course-v1';
const FILTERS='tus-companion-hidden-modules-v1';
const PREFS='tus-companion-preferences-v2';
const LEGAL_ACK='tus-companion-legal-ack-v1';
const INSTALL_DISMISSED='tus-companion-install-dismissed-v1';
const INSTALL_DONE='tus-companion-install-done-v1';
const DAYS=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const MAP='https://app.mappedin.com/map/68b1b5dd74254a000bbf174b';
const LEGAL_VERSION='2026-09-29';
const CLOUD_REFRESH_MS=15*1000;
const PENDING_REFRESH_MS=2500;
const PENDING_KEY='tus-companion-pending-v1';

const SUBJECT_PALETTE=[
  {bg:'#EAF3FB',border:'#B9D4E8',accent:'#5E91B7',ink:'#18384F',room:'#416F91'},
  {bg:'#EDF5EC',border:'#C2D9BE',accent:'#6F9B6C',ink:'#234523',room:'#557D52'},
  {bg:'#F8EEE8',border:'#E4C8B8',accent:'#B77E61',ink:'#553225',room:'#956349'},
  {bg:'#F1ECF8',border:'#D2C4E6',accent:'#8C72B2',ink:'#3F315A',room:'#735A99'},
  {bg:'#F8F2DE',border:'#E4D59C',accent:'#A88B39',ink:'#514417',room:'#856F2F'},
  {bg:'#E8F5F3',border:'#B7DCD5',accent:'#57998E',ink:'#18483F',room:'#407D73'},
  {bg:'#F8EDEF',border:'#E5C3C9',accent:'#B36F7B',ink:'#562B33',room:'#945764'},
  {bg:'#EEF1F8',border:'#C4CEE3',accent:'#6D80A8',ink:'#283550',room:'#586B91'},
  {bg:'#F3EFE8',border:'#D9CCB9',accent:'#9A7B56',ink:'#4D3925',room:'#7B6043'},
  {bg:'#EDF4F7',border:'#BED5DE',accent:'#628EA0',ink:'#213E49',room:'#4C7484'},
  {bg:'#F2F5E8',border:'#D1DCAC',accent:'#879B50',ink:'#39451E',room:'#6C7F3D'},
  {bg:'#F7ECF4',border:'#DFC2D5',accent:'#A56E94',ink:'#4C2A43',room:'#89597A'}
];
function subjectKey(name){return String(name||'Class').trim().toLocaleLowerCase('en').replace(/\s+/g,' ')}
function subjectHash(name){let h=2166136261;for(const ch of subjectKey(name)){h^=ch.codePointAt(0);h=Math.imul(h,16777619)}return h>>>0}
function subjectColor(name){return SUBJECT_PALETTE[subjectHash(name)%SUBJECT_PALETTE.length]}
function subjectStyle(name){const c=subjectColor(name);return `--subject-bg:${c.bg};--subject-border:${c.border};--subject-accent:${c.accent};--subject-ink:${c.ink};--subject-room:${c.room}`}

const CAMPUS_STARTS=[
  {label:'Main entrance',value:'Main Entrance',hint:'Dublin Road side'},
  {label:'Bus stop',value:'Bus Stop',hint:'If you normally arrive by bus'},
  {label:'University Road entrance',value:'University Road Entrance',hint:'University Road side'}
];
let deferredInstallPrompt=null;
let lastWatchAt=0;
let lastLoadAt=0;
let state={catalog:[],selection:readSelection(),snapshot:null,changes:[],sync:null,meta:null,tab:new URLSearchParams(location.search).get('tab')||'today',weekDay:null,error:'',refreshing:false,prefs:readPrefs(),push:{supported:false,permission:'default',subscribed:false},installModal:false,legal:null,route:null,originEditor:false,toast:''};

class ApiError extends Error{
  constructor(status,detail,raw=''){super(detail||raw||`Request failed (${status})`);this.status=status;this.detail=detail;this.raw=raw}
}

window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;if(shouldAutoOfferInstall()){state.installModal=true;render()}});
window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;state.installModal=false;localStorage.setItem(INSTALL_DISMISSED,String(Date.now()));localStorage.setItem(INSTALL_DONE,'1');toast('App installed.');});

function readSelection(){try{return JSON.parse(localStorage.getItem(STORE)||'null')}catch{return null}}
function pendingRecord(){try{return JSON.parse(localStorage.getItem(PENDING_KEY)||'null')}catch{return null}}
function ensurePendingSince(reset=false){
  if(!state.selection)return Date.now();
  const saved=pendingRecord();
  if(!reset&&saved?.group===state.selection.group&&Number.isFinite(Number(saved.since)))return Number(saved.since);
  const since=Date.now();
  localStorage.setItem(PENDING_KEY,JSON.stringify({group:state.selection.group,since}));
  return since;
}
function clearPendingSince(){localStorage.removeItem(PENDING_KEY)}
function pendingSeconds(){return Math.max(0,Math.floor((Date.now()-ensurePendingSince(false))/1000))}
function pendingClock(sec=pendingSeconds()){const m=Math.floor(sec/60),s=sec%60;return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`}
function updatePendingUi(){
  const timer=document.getElementById('syncTimer');if(!timer||state.snapshot)return;
  const sec=pendingSeconds(),bar=document.getElementById('syncProgress'),hint=document.getElementById('syncHint');
  timer.textContent=pendingClock(sec);
  if(bar)bar.style.width=`${Math.min(100,(sec/60)*100)}%`;
  if(hint)hint.textContent=sec<60?'Target: ready in about a minute. This page updates automatically.':'Taking a little longer. Sync is still running automatically.';
}
function defaultPrefs(){return {timeFormat:'24',accessibleRoutes:false,savedOrigin:null}}
function readPrefs(){try{return {...defaultPrefs(),...JSON.parse(localStorage.getItem(PREFS)||'{}')}}catch{return defaultPrefs()}}
function savePrefs(){localStorage.setItem(PREFS,JSON.stringify(state.prefs))}
function hiddenModules(){try{return new Set(JSON.parse(localStorage.getItem(FILTERS)||'[]'))}catch{return new Set()}}
function visibleEvents(){const h=hiddenModules();return (state.snapshot?.events||[]).filter(e=>!h.has(e.module))}
function esc(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}

async function api(url,opts){
  const r=await fetch(url,opts);
  const raw=await r.text();
  let body=null;
  try{body=raw?JSON.parse(raw):null}catch{}
  if(!r.ok)throw new ApiError(r.status,body?.detail||body?.error||'',raw);
  return body;
}

function mapUrl(room,departure){
  let u=`${MAP}/directions?location=${encodeURIComponent(room)}`;
  if(departure)u+=`&departure=${encodeURIComponent(departure)}`;
  if(state.prefs.accessibleRoutes)u+='&accessible=true';
  return u;
}
function b64(s){const p='='.repeat((4-s.length%4)%4),b=(s+p).replace(/-/g,'+').replace(/_/g,'/'),raw=atob(b);return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)))}
function campusNow(){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Dublin',year:'numeric',month:'2-digit',day:'2-digit',weekday:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
  const get=t=>parts.find(p=>p.type===t)?.value||'';
  return {date:`${get('year')}-${get('month')}-${get('day')}`,day:get('weekday'),minutes:Number(get('hour'))*60+Number(get('minute'))};
}
function dayName(){return campusNow().day}
function isoToday(){return campusNow().date}
function eventTime(e,key){if(!e?.date||!e?.[key])return null;const d=new Date(`${e.date}T${e[key]}:00`);return Number.isNaN(d.getTime())?null:d}
function isCurrentEvent(e){const now=campusNow();return !!(e?.date===now.date&&timeMinutes(e.start)<=now.minutes&&now.minutes<timeMinutes(e.end))}
function currentEvent(){return visibleEvents().find(isCurrentEvent)||null}
function nextEvent(){
  const now=campusNow();
  return [...visibleEvents()].filter(e=>e?.date>now.date||(e?.date===now.date&&timeMinutes(e.end)>=now.minutes)).sort((a,b)=>`${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`))[0]||null
}
function previousFor(e){if(!e)return null;return visibleEvents().filter(x=>x.date===e.date&&x.end<=e.start&&x.room_code).sort((a,b)=>b.end.localeCompare(a.end))[0]||null}
function smartDepartureFor(e){const current=currentEvent();if(current&&current!==e&&current.room_code)return current.room_code;return previousFor(e)?.room_code||null}
function formatTime(value){
  if(!value)return '';
  const [h0,m0='00']=String(value).split(':'),h=Number(h0),m=Number(m0);
  if(!Number.isFinite(h)||!Number.isFinite(m))return value;
  if(state.prefs.timeFormat==='12'){const suffix=h>=12?'PM':'AM',hh=h%12||12;return `${hh}:${String(m).padStart(2,'0')} ${suffix}`}
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function formatRange(e){return `${formatTime(e.start)}–${formatTime(e.end)}`}
function formatClockDate(iso){if(!iso)return '';const d=new Date(iso);return d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit',hour12:state.prefs.timeFormat==='12'})}
function formatDetected(iso){if(!iso)return '';return new Date(iso).toLocaleString([],{dateStyle:'medium',timeStyle:'short',hour12:state.prefs.timeFormat==='12'})}
function eventWeekday(e){if(e?.day)return String(e.day).toUpperCase();if(e?.date){const d=new Date(`${e.date}T12:00:00`);if(!Number.isNaN(d.getTime()))return new Intl.DateTimeFormat('en-IE',{weekday:'long'}).format(d).toUpperCase()}return ''}
function syncDisplay(){const last=state.sync?.last_success_at;if(!last)return {updated:state.sync?.status==='syncing'?'Updating…':''};return {updated:`Updated ${formatClockDate(last)}`}}
function routeButton(e,departure){return e.room_code?`<button class="route" data-route-room="${esc(e.room_code)}" data-route-previous="${esc(departure||'')}">Directions ↗</button>`:''}
function card(e,from){const live=isCurrentEvent(e);const previous=previousFor(e)?.room_code||from||'';return `<article class="class-card subject-card ${live?'current':''}" style="${subjectStyle(e.module)}" data-event-date="${esc(e.date||'')}" data-event-start="${esc(e.start)}"><div class="clock"><b>${esc(formatTime(e.start))}</b><span>${esc(formatTime(e.end))}</span></div><div><div class="row"><h3>${esc(e.module)}</h3>${live?'<span class="live-tag">NOW</span>':''}<span class="tag">${esc(e.type)}</span></div><div class="place">${esc(e.room_code||e.room_raw)}${e.room_name?`<small> · ${esc(e.room_name)}</small>`:''}</div><div class="teacher">${esc(e.staff)}</div></div>${routeButton(e,previous)}</article>`}
function nav(){return `<nav>${[['today','Today'],['week','Week'],['changes','Changes'],['settings','Settings']].map(([k,l])=>`<button data-tab="${k}" class="${state.tab===k?'active':''}">${l}</button>`).join('')}</nav>`}

function setup(){
  APP.innerHTML=`<main class="setup"><div class="brandmark">T</div><p class="kicker">TUS ATHLONE</p><h1>Your timetable,<br/>without the hassle.</h1><p class="lead">Pick your course once. We keep the timetable synced and surface room and time changes.</p><div class="first-load-note"><span>The first time you open your timetable, it may take a little longer to load.</span></div><label>Department<select id="dep"><option value="">Choose department</option>${state.catalog.map(d=>`<option value="${esc(d.id)}">${esc(d.label)}</option>`).join('')}</select></label><label>Course / group<select id="grp" disabled><option value="">Choose course</option></select></label><button id="save" class="cta" disabled>Use this timetable</button>${state.error?`<div class="setup-error">${esc(state.error)}</div>`:''}<p class="privacy">No TUS password is requested by this app.</p><p class="legal-consent">By continuing, you acknowledge the <button data-legal="terms">Terms of Use</button> and <button data-legal="privacy">Privacy Notice</button>.</p></main>${renderOverlays()}`;
  const dep=document.getElementById('dep'),grp=document.getElementById('grp'),save=document.getElementById('save');
  dep.onchange=()=>{const d=state.catalog.find(x=>x.id===dep.value);grp.innerHTML='<option value="">Choose course</option>'+((d?.groups||[]).map(g=>`<option value="${esc(g.id)}">${esc(g.label)}</option>`).join(''));grp.disabled=!dep.value;save.disabled=true};
  grp.onchange=()=>save.disabled=!(dep.value&&grp.value);
  save.onclick=async()=>{
    const d=state.catalog.find(x=>x.id===dep.value);const g=d?.groups?.find(x=>x.id===grp.value);
    state.selection={department:dep.value,group:grp.value,departmentLabel:d?.label||dep.value,groupLabel:g?.label||grp.value};
    localStorage.setItem(STORE,JSON.stringify(state.selection));localStorage.setItem(LEGAL_ACK,LEGAL_VERSION);
    state.tab='today';history.replaceState(null,'','/');
    state.snapshot=null;state.changes=[];state.error='';state.sync={status:'queued'};ensurePendingSince(true);
    await updateExistingSubscription();render();await watchAndLoad(true);render();
  };
  bindCommon();
}

function syncCopy(){
  const status=state.sync?.status||'never-synced';
  if(status==='queued')return {title:'Preparing your timetable',body:'We are fetching your course now. It normally appears in under a minute.',kind:'working'};
  if(status==='syncing')return {title:'Reading the latest timetable',body:'The cloud collector is fetching the latest timetable now. This screen updates automatically.',kind:'working'};
  if(status==='error')return {title:'Timetable temporarily unavailable',body:'We could not refresh the source just now. Your course choice is safe and the service will retry automatically.',kind:'error'};
  return {title:'Starting your first sync',body:'We have your course. The next cloud sync will prepare its first timetable snapshot.',kind:'working'};
}

function renderPending(){
  const m=syncCopy(),group=state.selection?.groupLabel||state.selection?.group||'',sec=pendingSeconds();
  const attempt=state.sync?.last_attempt_at?`Last check ${formatClockDate(state.sync.last_attempt_at)}`:'Starting cloud sync…';
  APP.innerHTML=`<main class="app pending-page"><header><div><p class="kicker">TUS ATHLONE</p><h1>Loading your timetable</h1></div></header><section class="sync-panel ${m.kind}"><div class="sync-icon"><span></span></div><div class="sync-copy"><p class="sync-eyebrow">${esc(group)}</p><h2>${esc(m.title)}</h2><div class="sync-timer-row"><strong id="syncTimer" class="sync-timer">${pendingClock(sec)}</strong><span>elapsed</span></div><div class="sync-progress-track" aria-hidden="true"><span id="syncProgress" style="width:${Math.min(100,(sec/60)*100)}%"></span></div><p id="syncHint" class="sync-hint">${sec<60?'Target: ready in about a minute. This page updates automatically.':'Taking a little longer. Sync is still running automatically.'}</p><div class="sync-meta">${esc(attempt)}</div></div></section>${state.error?`<div class="friendly-error">${esc(state.error)}</div>`:''}<button id="change" class="ghost">Change course</button></main>${renderOverlays()}`;
  bindCommon();updatePendingUi();
}

function render(){
  if(!state.selection)return setup();
  if(!state.snapshot)return renderPending();
  const title=state.tab==='today'?'Today':state.tab==='week'?'This week':state.tab==='changes'?'Changes':'Settings';
  let body=state.tab==='today'?renderToday():state.tab==='week'?renderWeek():state.tab==='changes'?renderChanges():renderSettings();
  const syncUi=syncDisplay();
  APP.innerHTML=`<main class="app ${state.tab==='week'?'week-app':''}"><header><div><p class="kicker">TUS ATHLONE</p><h1>${title}</h1></div><div class="header-status">${esc(syncUi.updated)}</div></header>${body}${nav()}</main>${renderOverlays()}${state.toast?`<div class="toast" role="status">${esc(state.toast)}</div>`:''}`;
  bindCommon();
  if(state.tab==='week')setTimeout(()=>{const mobile=window.matchMedia?.('(max-width:760px)').matches;document.querySelector(mobile?'.mobile-week-card.current':'.week-event.current')?.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'})},120);
}

function renderToday(){
  const today=visibleEvents().filter(e=>e.date?e.date===isoToday():e.day===dayName()).sort((a,b)=>a.start.localeCompare(b.start));
  const now=new Date(),focus=today.find(isCurrentEvent)||today.find(e=>{const end=eventTime(e,'end');return end&&end>=now})||null,prev=focus?previousFor(focus)?.room_code:null;
  return `${focus?`<section class="hero ${isCurrentEvent(focus)?'hero-live':''}"><p class="kicker gold">TODAY</p><h2>${esc(focus.module)}</h2><div class="hero-meta"><span>${esc(formatRange(focus))}</span><span>${esc(focus.room_code||focus.room_raw)}</span>${isCurrentEvent(focus)?'<span>NOW</span>':''}</div><p>${esc(focus.room_name||focus.staff)}</p>${focus.room_code?`<button class="hero-button" data-route-room="${esc(focus.room_code)}" data-route-previous="${esc(prev||'')}">Get directions</button>`:''}</section>`:''}<section><div class="section-head"><h2>${dayName()}</h2><span>${today.length} classes</span></div>${today.length?today.map((e,i)=>card(e,i?today[i-1].room_code:null)).join(''):'<div class="empty">No classes today.</div>'}</section>`;
}
function timeMinutes(value){const [h,m='0']=String(value||'0:0').split(':').map(Number);return (Number.isFinite(h)?h:0)*60+(Number.isFinite(m)?m:0)}
function weekBounds(events){
  if(!events.length)return {start:9*60,end:18*60};
  let start=Math.min(...events.map(e=>timeMinutes(e.start))),end=Math.max(...events.map(e=>timeMinutes(e.end)));
  start=Math.max(7*60,Math.floor(start/60)*60);end=Math.min(22*60,Math.ceil(end/60)*60);
  if(end-start<6*60)end=Math.min(22*60,start+6*60);
  return {start,end};
}
function shortDateForDay(day,events){const e=events.find(x=>x.day===day&&x.date);if(!e)return '';const d=new Date(`${e.date}T12:00:00`);return Number.isNaN(d.getTime())?'':new Intl.DateTimeFormat('en-IE',{day:'numeric',month:'short'}).format(d)}
function overlapLayout(list){
  const sorted=[...list].sort((a,b)=>timeMinutes(a.start)-timeMinutes(b.start)||timeMinutes(a.end)-timeMinutes(b.end));
  const groups=[];let current=[],maxEnd=-1;
  for(const e of sorted){const s=timeMinutes(e.start),en=timeMinutes(e.end);if(current.length&&s>=maxEnd){groups.push(current);current=[];maxEnd=-1}current.push(e);maxEnd=Math.max(maxEnd,en)}
  if(current.length)groups.push(current);
  const out=[];
  for(const group of groups){const laneEnds=[];const placed=[];for(const e of group){const s=timeMinutes(e.start),en=timeMinutes(e.end);let lane=laneEnds.findIndex(x=>x<=s);if(lane<0){lane=laneEnds.length;laneEnds.push(en)}else laneEnds[lane]=en;placed.push({e,lane})}const lanes=Math.max(1,laneEnds.length);placed.forEach(x=>out.push({...x,lanes}))}
  return out;
}
function mobileWeekDay(events){
  const weekdays=DAYS.slice(0,5);
  if(state.weekDay&&weekdays.includes(state.weekDay))return state.weekDay;
  const today=dayName();
  if(weekdays.includes(today)){state.weekDay=today;return today}
  const first=weekdays.find(d=>events.some(e=>e.day===d))||weekdays[0];state.weekDay=first;return first;
}
function renderMobileWeek(events){
  const selected=mobileWeekDay(events),weekdays=DAYS.slice(0,5);
  const picker=weekdays.map(day=>{const date=shortDateForDay(day,events),today=day===dayName();return `<button class="mobile-day ${selected===day?'selected':''} ${today?'today':''}" data-week-day="${esc(day)}" aria-pressed="${selected===day?'true':'false'}"><b>${esc(day.slice(0,3))}</b><span>${esc(date||'—')}</span></button>`}).join('');
  const list=events.filter(e=>e.day===selected).sort((a,b)=>a.start.localeCompare(b.start));
  const classes=list.length?list.map(e=>{const live=isCurrentEvent(e),prev=previousFor(e)?.room_code||'',room=e.room_code||e.room_raw||'Room TBC';const inner=`<span class="mobile-week-time"><b>${esc(formatTime(e.start))}</b><span>${esc(formatTime(e.end))}</span></span><span class="mobile-week-info"><strong>${esc(e.module)}</strong><span class="mobile-week-meta"><b>${esc(room)}</b>${e.type?`<span>${esc(e.type)}</span>`:''}</span>${e.staff?`<small>${esc(e.staff)}</small>`:''}</span><span class="mobile-week-side">${live?'<em>NOW</em>':''}${e.room_code?'<span aria-hidden="true">›</span>':''}</span>`;return e.room_code?`<button class="mobile-week-card ${live?'current':''}" style="${subjectStyle(e.module)}" data-route-room="${esc(e.room_code)}" data-route-previous="${esc(prev)}" aria-label="${esc(e.module)}, ${esc(formatRange(e))}, ${esc(room)}. Open directions.">${inner}</button>`:`<div class="mobile-week-card no-route ${live?'current':''}" style="${subjectStyle(e.module)}">${inner}</div>`}).join(''):`<div class="mobile-week-empty">No classes on ${esc(selected)}.</div>`;
  const date=shortDateForDay(selected,events),count=list.length;
  return `<div class="mobile-week"><div class="mobile-day-picker" aria-label="Choose day">${picker}</div><div class="mobile-week-heading"><div><p>${selected===dayName()?'TODAY':esc(selected.toUpperCase())}</p><h2>${esc(selected)}${date?` · ${esc(date)}`:''}</h2></div><span>${count} ${count===1?'class':'classes'}</span></div><div class="mobile-week-list">${classes}</div></div>`;
}
function renderWeek(){
  const events=visibleEvents().filter(e=>DAYS.slice(0,5).includes(e.day));
  const {start,end}=weekBounds(events),pxPerHour=72,totalHeight=((end-start)/60)*pxPerHour;
  const hours=[];for(let m=start;m<=end;m+=60)hours.push(m);
  const header=DAYS.slice(0,5).map(day=>{const date=shortDateForDay(day,events),isToday=day===dayName();return `<div class="week-day-head ${isToday?'is-today':''}"><b>${esc(day.slice(0,3))}</b>${date?`<span>${esc(date)}</span>`:''}${isToday?'<small>TODAY</small>':''}</div>`}).join('');
  const times=hours.map(m=>`<span class="week-time-label" style="top:${((m-start)/60)*pxPerHour}px">${esc(formatTime(`${Math.floor(m/60)}:00`))}</span>`).join('');
  const dayCols=DAYS.slice(0,5).map((day,dayIndex)=>{const list=events.filter(e=>e.day===day),isToday=day===dayName();const blocks=overlapLayout(list).map(({e,lane,lanes})=>{const top=((timeMinutes(e.start)-start)/60)*pxPerHour,height=Math.max(42,((timeMinutes(e.end)-timeMinutes(e.start))/60)*pxPerHour-4),left=(lane/lanes)*100,width=100/lanes;const current=isCurrentEvent(e),prev=previousFor(e)?.room_code||'';return `<button class="week-event ${current?'current':''}" style="${subjectStyle(e.module)};top:${top}px;height:${height}px;left:calc(${left}% + 3px);width:calc(${width}% - 6px)" ${e.room_code?`data-route-room="${esc(e.room_code)}" data-route-previous="${esc(prev)}"`:''} title="${esc(e.module)} · ${esc(formatRange(e))}"><span class="week-event-time">${esc(formatTime(e.start))}</span><strong>${esc(e.module)}</strong><span class="week-event-room">${esc(e.room_code||e.room_raw||'')}</span>${current?'<em>NOW</em>':''}</button>`}).join('');return `<div class="week-day-col ${isToday?'is-today':''}" style="height:${totalHeight}px" data-day="${dayIndex}">${blocks}</div>`}).join('');
  const desktop=`<div class="week-desktop"><div class="week-caption"><span>Tap a class for directions</span><span>${esc(formatTime(`${Math.floor(start/60)}:00`))}–${esc(formatTime(`${Math.floor(end/60)}:00`))}</span></div><div class="week-scroll"><div class="week-board"><div class="week-head-spacer"></div>${header}<div class="week-time-col" style="height:${totalHeight}px">${times}</div>${dayCols}</div></div></div>`;
  return `<section class="week-section">${renderMobileWeek(events)}${desktop}</section>`;
}
function renderChanges(){
  return `<section>${state.changes.length?state.changes.map(c=>`<article class="change"><div class="change-type">${esc(c.change_type.replaceAll('_',' '))}</div><h3>${esc(c.module)}</h3><p>${esc(c.day)} · ${esc(formatDetected(c.detected_at))}</p>${c.change_type==='ROOM_CHANGED'?`<b>${esc(c.before?.room_code||c.before?.room_raw)} → ${esc(c.after?.room_code||c.after?.room_raw)}</b>`:''}${c.change_type==='TIME_CHANGED'?`<b>${esc(formatTime(c.before?.start))} → ${esc(formatTime(c.after?.start))}</b>`:''}${c.change_type==='LECTURER_CHANGED'?`<b>${esc(c.before?.staff||'?')} → ${esc(c.after?.staff||'?')}</b>`:''}${c.change_type==='CLASS_TYPE_CHANGED'?`<b>${esc(c.before?.type||'?')} → ${esc(c.after?.type||'?')}</b>`:''}${c.change_type==='TEACHING_WEEKS_CHANGED'?`<b>${esc(c.before?.weeks_raw||'?')} → ${esc(c.after?.weeks_raw||'?')}</b>`:''}</article>`).join(''):'<div class="empty">No timetable changes detected yet.</div>'}</section>`;
}
function pushStatusText(){if(!state.push.supported)return 'Not supported in this browser';if(state.push.permission==='denied')return 'Blocked by browser settings';if(state.push.subscribed)return 'Enabled on this device';return 'Off on this device'}
function installSummary(){const d=deviceInfo();if(d.standalone)return 'Installed on this device';if(d.ios)return 'Add to Home Screen from Safari';if(d.android)return deferredInstallPrompt?'Ready to install':'Install from your browser menu';return deferredInstallPrompt?'Ready to install':'Use the install icon in Chrome/Edge'}
function renderSettings(){
  const hidden=hiddenModules(),mods=[...new Set((state.snapshot.events||[]).map(e=>e.module))].sort();
  const saved=state.prefs.savedOrigin;
  const savedSummary=saved?`${esc(saved.label||'Usual start')} · ${esc(saved.value)}`:'Not set. Save the entrance, bus stop, room or mapped point you normally start from.';
  return `<section class="settings"><div class="setting-card"><div><h3>Notifications</h3><p>${esc(pushStatusText())}. Receive room, time and class-change alerts.</p></div><div class="setting-actions"><button id="notify" class="small-primary">Enable / update</button>${state.push.subscribed?'<button id="test-push" class="small-ghost">Send test</button><button id="disable-push" class="small-ghost danger">Turn off</button>':''}</div></div>${deviceInfo().standalone?'':`<div class="setting-card"><div><h3>Install app</h3><p>${esc(installSummary())}</p></div><button id="install-app" class="small-ghost">How to install</button></div>`}<div class="setting-card"><div><h3>Time format</h3><p>Choose how class times are displayed.</p></div><div class="segmented"><button data-time="24" class="${state.prefs.timeFormat==='24'?'selected':''}">24-hour</button><button data-time="12" class="${state.prefs.timeFormat==='12'?'selected':''}">AM/PM</button></div></div><div class="setting-card directions-setting"><div><h3>Usual starting point</h3><p>${savedSummary}. Directions always ask where you want to start, so you are never forced to use the previous classroom.</p></div><button id="set-origin" class="small-ghost">${saved?'Change':'Set point'}</button></div><div class="setting-card"><div><h3>Accessible routes</h3><p>Ask Mappedin to avoid stairs where an accessible path is available.</p></div><label class="switch"><input id="accessible" type="checkbox" ${state.prefs.accessibleRoutes?'checked':''}><span></span></label></div><button id="change" class="ghost">Change course</button><p>Selected group: <b>${esc(state.selection.groupLabel||state.selection.group)}</b></p><div class="module-box"><h3>My modules</h3><p>Hide alternatives you do not attend. Hidden modules are also excluded from future push alerts on this device.</p>${mods.map(m=>`<label class="module-row"><input type="checkbox" data-module="${esc(m)}" ${hidden.has(m)?'':'checked'}><span>${esc(m)}</span></label>`).join('')}</div><div class="legal-footer"><p><strong>Unofficial independent app.</strong> Not affiliated with, endorsed by, or authorized by Technological University of the Shannon (TUS). For student convenience only. Always verify critical timetable information using official TUS systems.</p><div><button data-legal="terms">Terms of Use</button><span>·</span><button data-legal="privacy">Privacy Notice</button></div><small>Saved route starting points stay on this device and are sent only to Mappedin when you open directions. TUS Companion does not store them on its server.</small></div></section>`;
}

function renderOverlays(){return `${state.installModal?renderInstallModal():''}${state.legal?renderLegalModal(state.legal):''}${state.route?renderRouteModal():''}${state.originEditor?renderOriginEditor():''}`}
function renderInstallModal(){const d=deviceInfo();let title='Install TUS Companion',body='',action='';if(d.standalone){body='The app is already installed on this device.'}else if(deferredInstallPrompt){body='Install it for a full-screen app experience and quicker access to timetable alerts.';action='<button id="install-native" class="cta">Install app</button>'}else if(d.ios){body='On iPhone/iPad: open this page in Safari, tap the Share button, choose “Add to Home Screen”, then tap Add.'}else if(d.android){body='On Android: open the browser menu (⋮), choose “Install app” or “Add to Home screen”, then confirm.'}else{body='On Chrome or Edge desktop: use the Install icon in the address bar, or open the browser menu and choose “Install TUS Companion”.'}return `<div class="modal-backdrop" role="presentation"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="install-title"><button class="modal-x" data-close-modal aria-label="Close">×</button><p class="kicker">APP INSTALL</p><h2 id="install-title">${title}</h2><p>${body}</p>${action}<button id="install-later" class="ghost">Not now</button></section></div>`}
function legalContact(){const email=state.meta?.contact_email||'';return email?`Contact: <a href="mailto:${esc(email)}">${esc(email)}</a>.`:'Operator contact details must be configured before a public launch.'}
function renderLegalModal(kind){
  const privacy=kind==='privacy';
  const content=privacy?`<h2>Privacy Notice</h2><p class="legal-date">Effective ${LEGAL_VERSION}</p><h3>What this app processes</h3><p>Your selected department/course, time-format preference, hidden modules and optional usual route starting point are stored primarily in your browser. If you enable push notifications, the server stores a browser push endpoint, its public encryption keys, your selected timetable group and hidden-module list so it can deliver relevant alerts.</p><h3>What we do not collect</h3><p>This app does not ask students for TUS/Microsoft usernames or passwords. Your saved route starting point is kept in local browser storage and is not sent to the TUS Companion server. When you open directions, the chosen departure point is included in the Mappedin URL and is then handled by Mappedin under its own terms.</p><h3>Purpose and legal basis</h3><p>Timetable data is processed to provide the timetable and detect changes. If you enable push notifications, the device subscription data is processed on the basis of your consent, which you can withdraw at any time by using “Turn off” in Settings. Limited technical/security processing may be necessary for the operator's legitimate interest in operating and protecting the service.</p><h3>Retention</h3><p>Course-interest records expire after the configured inactivity period. Push subscriptions remain until you turn notifications off, the browser/provider invalidates them, or the operator removes them. Group timetable snapshots are shared timetable data rather than user profiles.</p><h3>Third parties and sources</h3><p>Timetable content is obtained from TUS and can include lecturer names used only to present class information. Push delivery is performed by your browser/OS push provider. Directions open Mappedin, an external service used by TUS; once opened, its own privacy terms apply.</p><h3>Your rights</h3><p>Where GDPR applies, you may have rights of access, rectification, erasure, restriction, portability and objection, and you may withdraw consent for push processing at any time. You may also complain to the Irish Data Protection Commission. You can change course, hide modules, disable push notifications and clear local site data directly from your browser.</p><p>${legalContact()}</p>`:`<h2>Terms of Use</h2><p class="legal-date">Effective ${LEGAL_VERSION}</p><h3>Independent, unofficial service</h3><p>TUS Companion is an independent convenience tool. It is not affiliated with, endorsed by, sponsored by, or authorized by Technological University of the Shannon (TUS). TUS remains the authoritative source for timetable information.</p><h3>No guarantee of timetable accuracy</h3><p>The service may be delayed, incomplete, unavailable or affected by upstream changes. Notifications are convenience alerts only. You remain responsible for checking official TUS systems for important class, room, examination, attendance and academic information.</p><h3>Third-party services</h3><p>Routing links open Mappedin and may be subject to Mappedin/TUS terms. Availability and accuracy of indoor routing are not guaranteed by this app.</p><h3>Acceptable use</h3><p>Use the service for lawful personal/student convenience. Do not interfere with the service, attempt to obtain administrator sessions, abuse notification infrastructure, or use the app to gain access to information you are not entitled to access.</p><h3>Availability and liability</h3><p>The service is provided on an “as available” basis and may be changed, suspended or discontinued. To the maximum extent permitted by applicable law, the operator is not responsible for losses caused by relying on delayed or incorrect timetable data where official TUS information was available.</p><h3>Rights that cannot be excluded</h3><p>Nothing in these terms excludes rights or liabilities that cannot lawfully be excluded under Irish or EU law.</p><p>${legalContact()}</p>`;
  return `<div class="modal-backdrop legal-backdrop"><section class="modal legal-modal" role="dialog" aria-modal="true"><button class="modal-x" data-close-modal aria-label="Close">×</button>${content}<button class="ghost" data-close-modal>Close</button></section></div>`;
}

function bindCommon(){
  APP.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;history.replaceState(null,'',state.tab==='today'?'/' : `/?tab=${state.tab}`);render()});
  APP.querySelectorAll('[data-week-day]').forEach(b=>b.onclick=()=>{state.weekDay=b.dataset.weekDay;render()});
  APP.querySelectorAll('[data-legal]').forEach(b=>b.onclick=()=>{state.legal=b.dataset.legal;render()});
  APP.querySelectorAll('[data-close-modal]').forEach(b=>b.onclick=()=>{state.legal=null;state.installModal=false;render()});
  APP.querySelectorAll('[data-route-room]').forEach(b=>b.onclick=()=>startDirections(b.dataset.routeRoom,b.dataset.routePrevious||null));
  APP.querySelectorAll('[data-time]').forEach(b=>b.onclick=()=>{state.prefs.timeFormat=b.dataset.time;savePrefs();render()});
  APP.querySelectorAll('[data-module]').forEach(box=>box.onchange=async()=>{const hidden=hiddenModules(),m=box.dataset.module;if(box.checked)hidden.delete(m);else hidden.add(m);localStorage.setItem(FILTERS,JSON.stringify([...hidden]));await updateExistingSubscription();render()});
  const accessible=document.getElementById('accessible');if(accessible)accessible.onchange=()=>{state.prefs.accessibleRoutes=accessible.checked;savePrefs();render()};
  const setOrigin=document.getElementById('set-origin');if(setOrigin)setOrigin.onclick=()=>{state.originEditor=true;render()};
  APP.querySelectorAll('[data-close-route]').forEach(b=>b.onclick=()=>{state.route=null;render()});
  APP.querySelectorAll('[data-close-origin]').forEach(b=>b.onclick=()=>{state.originEditor=false;render()});
  APP.querySelectorAll('[data-route-origin]').forEach(b=>b.onclick=()=>chooseRouteOrigin(b.dataset.routeOrigin));
  const routeGo=document.getElementById('route-go');if(routeGo)routeGo.onclick=()=>{const value=document.getElementById('route-known')?.value||'';if(value)openRoute(value);else toast('Choose a room first.');};
  const routeMap=document.getElementById('route-map');if(routeMap)routeMap.onclick=()=>openRoute(null);
  const editOrigin=document.getElementById('edit-origin');if(editOrigin)editOrigin.onclick=()=>{state.originEditor=true;render()};
  APP.querySelectorAll('[data-preset-origin]').forEach(b=>b.onclick=()=>choosePresetOrigin(b.dataset.presetOrigin));
  const saveOrigin=document.getElementById('save-origin');if(saveOrigin)saveOrigin.onclick=saveOriginFromEditor;
  const saveOriginCustom=document.getElementById('save-origin-custom');if(saveOriginCustom)saveOriginCustom.onclick=saveOriginFromEditor;
  const clearOrigin=document.getElementById('clear-origin');if(clearOrigin)clearOrigin.onclick=clearSavedOrigin;
  const notify=document.getElementById('notify');if(notify)notify.onclick=enableNotifications;
  const test=document.getElementById('test-push');if(test)test.onclick=testNotification;
  const disable=document.getElementById('disable-push');if(disable)disable.onclick=disableNotifications;
  const install=document.getElementById('install-app');if(install)install.onclick=()=>{state.installModal=true;render()};
  const native=document.getElementById('install-native');if(native)native.onclick=triggerNativeInstall;
  const later=document.getElementById('install-later');if(later)later.onclick=()=>{localStorage.setItem(INSTALL_DISMISSED,String(Date.now()));state.installModal=false;render()};
  const change=document.getElementById('change');if(change)change.onclick=changeCourse;
}

function changeCourse(){localStorage.removeItem(STORE);state.selection=null;state.snapshot=null;state.changes=[];state.sync=null;state.error='';state.tab='today';history.replaceState(null,'','/');render()}
function toast(message){state.toast=message;render();setTimeout(()=>{if(state.toast===message){state.toast='';render()}},2800)}
function deviceInfo(){const ua=navigator.userAgent||'',ios=/iPad|iPhone|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1),android=/Android/i.test(ua),standalone=window.matchMedia?.('(display-mode: standalone)').matches||window.navigator.standalone===true;if(standalone)try{localStorage.setItem(INSTALL_DONE,'1')}catch{}return {ios,android,desktop:!ios&&!android,standalone}}
function shouldAutoOfferInstall(){const d=deviceInfo();if(d.standalone||localStorage.getItem(INSTALL_DONE)==='1')return false;const last=Number(localStorage.getItem(INSTALL_DISMISSED)||0);return !last||Date.now()-last>14*24*60*60*1000}
async function triggerNativeInstall(){if(!deferredInstallPrompt){state.installModal=true;render();return}deferredInstallPrompt.prompt();const choice=await deferredInstallPrompt.userChoice;if(choice?.outcome==='accepted'){localStorage.setItem(INSTALL_DISMISSED,String(Date.now()))}deferredInstallPrompt=null;state.installModal=false;render()}

function knownRooms(){return [...new Set(visibleEvents().map(e=>e.room_code).filter(Boolean))].sort()}
function parseOriginValue(raw){
  const value=String(raw||'').trim();if(!value)return '';
  try{
    const u=new URL(value);
    if(!/mappedin\.com$/i.test(u.hostname)&&!/\.mappedin\.com$/i.test(u.hostname))return value;
    return u.searchParams.get('departure')||u.searchParams.get('you-are-here')||u.searchParams.get('location')||'';
  }catch{return value}
}
function startDirections(room,previous){if(!room)return;state.route={room,previous:previous||''};render()}
function openRoute(origin){if(!state.route?.room)return;const room=state.route.room;state.route=null;render();window.open(mapUrl(room,origin||null),'_blank','noopener,noreferrer')}
function chooseRouteOrigin(kind){
  if(kind==='saved'){const v=state.prefs.savedOrigin?.value;if(v)return openRoute(v)}
  if(kind==='previous'&&state.route?.previous)return openRoute(state.route.previous);
  if(kind==='none')return openRoute(null);
}
function useCustomRouteOrigin(){
  const select=document.getElementById('route-known'),input=document.getElementById('route-custom');
  const value=parseOriginValue((input?.value||'').trim()||(select?.value||''));
  if(!value){toast('Choose or enter a starting point first.');return}
  openRoute(value);
}
function setSavedOrigin(label,value){
  state.prefs.savedOrigin={label,value};savePrefs();state.originEditor=false;render();toast('Usual start saved.');
}
function saveOriginFromEditor(){
  const room=document.getElementById('origin-room')?.value||'';
  const custom=(document.getElementById('origin-custom-simple')?.value||'').trim();
  if(room)return setSavedOrigin(room,room);
  const value=parseOriginValue(custom);
  if(value)return setSavedOrigin(custom||value,value);
  toast('Choose a starting point.');
}
function clearSavedOrigin(){state.prefs.savedOrigin=null;savePrefs();state.originEditor=false;render();toast('Usual start cleared.');}
function choosePresetOrigin(value){
  const preset=CAMPUS_STARTS.find(x=>x.value===value);if(!preset)return;setSavedOrigin(preset.label,preset.value);
}
function renderRouteModal(){
  const r=state.route,saved=state.prefs.savedOrigin,rooms=knownRooms().filter(x=>x!==r.room);
  return `<div class="modal-backdrop"><section class="modal route-modal" role="dialog" aria-modal="true"><button class="modal-x" data-close-route aria-label="Close">×</button><p class="kicker">DIRECTIONS TO ${esc(r.room)}</p><h2>Start from</h2><div class="origin-choices"><button class="origin-choice primary-choice gps-choice" data-route-origin="none"><span><b>My current location</b><small>Works when you are on or very near campus. If the floor is unclear, Mappedin will ask which floor you are on.</small></span></button>${saved?`<button class="origin-choice" data-route-origin="saved"><span><b>${esc(saved.label||'My usual start')}</b><small>Saved start</small></span></button>`:`<button class="origin-choice" id="edit-origin"><span><b>Set a usual start</b><small>Useful if GPS is unavailable or you normally enter from the same place</small></span></button>`}${r.previous?`<button class="origin-choice" data-route-origin="previous"><span><b>Previous class</b><small>${esc(r.previous)}</small></span></button>`:''}</div><div class="origin-custom simple-route"><label>Another classroom<select id="route-known"><option value="">Choose room…</option>${rooms.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('')}</select></label><button id="route-go" class="small-ghost">Go from this room</button></div><button id="route-map" class="text-button">Choose manually in campus map</button></section></div>`;
}
function renderOriginEditor(){
  const saved=state.prefs.savedOrigin||{},rooms=knownRooms();
  return `<div class="modal-backdrop"><section class="modal origin-modal simple-origin" role="dialog" aria-modal="true"><button class="modal-x" data-close-origin aria-label="Close">×</button><p class="kicker">MY USUAL START</p><h2>Where do you normally enter?</h2><p class="short-copy">Choose once. You can change it anytime.</p><div class="preset-starts">${CAMPUS_STARTS.map(x=>`<button class="preset-start ${saved.value===x.value?'selected':''}" data-preset-origin="${esc(x.value)}"><b>${esc(x.label)}</b><small>${esc(x.hint)}</small></button>`).join('')}</div><div class="simple-divider"><span>or</span></div><label class="simple-select-label">A classroom<select id="origin-room"><option value="">Choose room…</option>${rooms.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('')}</select></label><button id="save-origin" class="small-primary wide">Save classroom</button><p class="origin-help">For live directions, use <b>My current location</b> when you are on campus. You can still open the official Mappedin map from Directions.</p>${saved.value?'<button id="clear-origin" class="text-button danger-text">Remove saved start</button>':''}</section></div>`;
}

async function refreshPushStatus(){
  state.push={supported:('serviceWorker'in navigator)&&('PushManager'in window)&&('Notification'in window),permission:('Notification'in window?Notification.permission:'default'),subscribed:false};
  if(!state.push.supported)return;
  try{const reg=await navigator.serviceWorker.ready;state.push.subscribed=!!(await reg.pushManager.getSubscription())}catch{}
}
async function updateExistingSubscription(){try{if(!state.selection||!('serviceWorker'in navigator))return;const reg=await navigator.serviceWorker.ready,sub=await reg.pushManager?.getSubscription();if(!sub)return;const data=sub.toJSON();await api('/api/push/subscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({group_id:state.selection.group,endpoint:sub.endpoint,keys:data.keys,hidden_modules:[...hiddenModules()]})})}catch{}}
async function enableNotifications(){
  try{const d=deviceInfo();if(d.ios&&!d.standalone){state.installModal=true;render();return}if(!state.push.supported)throw new Error('Push notifications are not supported in this browser.');const reg=await navigator.serviceWorker.ready,{publicKey}=await api('/api/push/public-key');if(!publicKey)throw new Error('Push is not configured on the server yet.');const perm=await Notification.requestPermission();if(perm!=='granted'){await refreshPushStatus();render();return}let sub=await reg.pushManager.getSubscription();if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(publicKey)});const data=sub.toJSON();await api('/api/push/subscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({group_id:state.selection.group,endpoint:sub.endpoint,keys:data.keys,hidden_modules:[...hiddenModules()]})});await refreshPushStatus();toast('Notifications enabled on this device.')}catch(e){toast(e.message||String(e))}
}
async function testNotification(){try{const reg=await navigator.serviceWorker.ready,sub=await reg.pushManager.getSubscription();if(!sub)throw new Error('Enable notifications first.');await api('/api/push/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:sub.endpoint})});toast('Test notification sent.')}catch(e){toast(e.message||String(e))}}
async function disableNotifications(){try{const reg=await navigator.serviceWorker.ready,sub=await reg.pushManager.getSubscription();if(sub){await api('/api/push/unsubscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:sub.endpoint})}).catch(()=>{});await sub.unsubscribe()}await refreshPushStatus();toast('Notifications turned off.')}catch(e){toast(e.message||String(e))}}

async function watchAndLoad(forceWatch=false){
  if(!state.selection||state.refreshing)return;
  state.refreshing=true;
  try{
    let w=null;
    if(forceWatch||!lastWatchAt||Date.now()-lastWatchAt>45*1000){
      w=await api('/api/watch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({department_id:state.selection.department,group_id:state.selection.group})});
      lastWatchAt=Date.now();
    }
    if(w?.sync)state.sync=w.sync;
    try{
      const t=await api('/api/timetable/'+encodeURIComponent(state.selection.group));state.snapshot=t.snapshot;state.sync=t.sync||state.sync;if(state.snapshot)clearPendingSince();
      try{state.changes=await api('/api/changes/'+encodeURIComponent(state.selection.group))}catch{}
      state.error='';
    }catch(e){
      if(e instanceof ApiError&&e.status===404&&e.detail==='not-synced-yet'){state.snapshot=null;try{state.sync=await api('/api/sync-status/'+encodeURIComponent(state.selection.group))}catch{}state.error=''}
      else state.error='We could not contact the timetable service. It will retry automatically.';
    }
  }catch{state.error='The timetable service is temporarily unavailable. Your course selection is still saved.'}
  finally{state.refreshing=false;lastLoadAt=Date.now()}
}

async function refreshLoop(){if(state.selection){await watchAndLoad(false);await refreshPushStatus();render()}setTimeout(refreshLoop,state.snapshot?CLOUD_REFRESH_MS:PENDING_REFRESH_MS)}
async function init(){
  try{const [c,m]=await Promise.all([api('/api/catalog'),api('/api/meta').catch(()=>null)]);state.catalog=c.departments||[];state.meta=m;if(!state.catalog.length)state.error='Course catalogue is still being prepared. Try again in a few minutes.'}catch{state.error='Could not load the course catalogue from the service.'}
  if('serviceWorker'in navigator)await navigator.serviceWorker.register('/sw.js').catch(()=>{});
  await refreshPushStatus();
  if(state.selection){ensurePendingSince(false);await watchAndLoad(true);}
  if(shouldAutoOfferInstall())setTimeout(()=>{state.installModal=true;render()},1200);
  render();setTimeout(refreshLoop,state.snapshot?CLOUD_REFRESH_MS:PENDING_REFRESH_MS);
}
setInterval(()=>{if(state.selection&&!state.snapshot)updatePendingUi()},1000);
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&state.selection&&Date.now()-lastLoadAt>30*1000){
    watchAndLoad(false).then(refreshPushStatus).then(render).catch(()=>{});
  }
});
init();
