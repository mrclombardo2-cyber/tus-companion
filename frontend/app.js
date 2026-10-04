const APP=document.getElementById('app');
const STORE='tus-companion-course-v1';
const FILTERS='tus-companion-hidden-modules-v1';
const PREFS='tus-companion-preferences-v3';
const LEGAL_ACK='tus-companion-legal-ack-v1';
const INSTALL_DISMISSED='tus-companion-install-dismissed-v1';
const NOTIFY_ONBOARDING='tus-companion-notify-onboarding-v1';
const OFFLINE_CACHE='tus-companion-offline-v1';
const CATALOG_CACHE='tus-companion-catalog-v1';
const DAYS=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const MAP='https://app.mappedin.com/map/68b1b5dd74254a000bbf174b';
const LEGAL_VERSION='2026-09-30';
const CLOUD_REFRESH_MS=30*1000;
const PENDING_REFRESH_MS=15*1000;
const UI_TIME_REFRESH_MS=15*1000;
const API_TIMEOUT_MS=9000;
const RECOVERY_DELAYS_MS=[1500,4000,10000,30000];
const PRIORITY_WATCH_AGE_MS=3*60*1000;
const PRIORITY_WATCH_INTERVAL_MS=60*1000;
const CHANGES_RESET_AT='2026-09-30T11:58:00.000Z';

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

function readOfflineTimetable(groupId){
  if(!groupId)return null;
  try{const cached=JSON.parse(localStorage.getItem(OFFLINE_CACHE)||'null');return cached?.group_id===groupId&&cached?.snapshot?cached:null}catch{return null}
}
function saveOfflineTimetable(){
  if(!state.selection?.group||!state.snapshot)return;
  const savedAt=new Date().toISOString();
  try{localStorage.setItem(OFFLINE_CACHE,JSON.stringify({group_id:state.selection.group,saved_at:savedAt,snapshot:state.snapshot,sync:state.sync,changes:state.changes}));state.offlineSavedAt=savedAt}catch{}
}
function readCatalogCache(){try{return JSON.parse(localStorage.getItem(CATALOG_CACHE)||'[]')}catch{return []}}
function saveCatalogCache(){try{localStorage.setItem(CATALOG_CACHE,JSON.stringify(state.catalog||[]))}catch{}}

let deferredInstallPrompt=null;
let lastWatchAt=0;
let lastLoadAt=0;
let cachedRecoveryTimer=null;
let cachedRecoveryStep=0;
let swControllerSeen=Boolean('serviceWorker'in navigator&&navigator.serviceWorker.controller);
let swControllerReloading=false;
const initialSelection=readSelection();
const initialOffline=readOfflineTimetable(initialSelection?.group);
let state={catalog:readCatalogCache(),selection:initialSelection,snapshot:initialOffline?.snapshot||null,changes:initialOffline?.changes||[],sync:initialOffline?.sync||null,meta:null,tab:new URLSearchParams(location.search).get('tab')||'today',weekDay:null,weekDate:null,weekStart:null,error:'',refreshing:false,prefs:readPrefs(),push:{supported:false,permission:'default',subscribed:false},installModal:false,notifyModal:false,legal:null,toast:'',offline:!navigator.onLine,usingCached:Boolean(initialOffline),offlineSavedAt:initialOffline?.saved_at||null};

class ApiError extends Error{
  constructor(status,detail,raw=''){super(detail||raw||`Request failed (${status})`);this.status=status;this.detail=detail;this.raw=raw}
}

window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;if(state.selection&&state.snapshot&&shouldAutoOfferInstall()){state.installModal=true;render()}});
window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;state.installModal=false;localStorage.setItem(INSTALL_DISMISSED,String(Date.now()));toast('App installed.');setTimeout(()=>{if(shouldOfferNotifyOnboarding()){state.notifyModal=true;render()}},700)});

function readSelection(){try{return JSON.parse(localStorage.getItem(STORE)||'null')}catch{return null}}
function defaultPrefs(){return {timeFormat:'24',reminderMinutes:0}}
function readPrefs(){try{return {...defaultPrefs(),...JSON.parse(localStorage.getItem(PREFS)||'{}')}}catch{return defaultPrefs()}}
function savePrefs(){localStorage.setItem(PREFS,JSON.stringify(state.prefs))}
function hiddenModules(){try{return new Set(JSON.parse(localStorage.getItem(FILTERS)||'[]'))}catch{return new Set()}}
function visibleEvents(){const h=hiddenModules();return (state.snapshot?.events||[]).filter(e=>!h.has(e.module))}
function visibleUpcomingEvents(){const h=hiddenModules();return [...(state.snapshot?.events||[]),...(state.snapshot?.next_week?.events||[])].filter(e=>!h.has(e.module))}
function esc(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}

function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
async function api(url,opts){
  const controller=new AbortController();
  const timeout=window.setTimeout(()=>controller.abort(),API_TIMEOUT_MS);
  try{
    const fetchOpts={cache:'no-store',...(opts||{}),signal:controller.signal};
    const r=await fetch(url,fetchOpts);
    const raw=await r.text();
    let body=null;
    try{body=raw?JSON.parse(raw):null}catch{}
    if(!r.ok)throw new ApiError(r.status,body?.detail||body?.error||'',raw);
    return body;
  }catch(e){
    if(e?.name==='AbortError')throw new Error('request-timeout');
    throw e;
  }finally{window.clearTimeout(timeout)}
}
function retryableApiError(e){return !(e instanceof ApiError)||e.status===408||e.status===429||e.status>=500}
async function apiRetry(url,opts,attempts=3){
  let lastError=null;
  for(let attempt=0;attempt<attempts;attempt++){
    try{return await api(url,opts)}
    catch(e){
      lastError=e;
      if(!retryableApiError(e)||attempt===attempts-1)throw e;
      await sleep(500*(2**attempt));
    }
  }
  throw lastError;
}

function extractRoomCode(rawRoom=''){
  const value=String(rawRoom||'').trim();
  return value.match(/^[A-Z]\d+[A-Z]?/i)?.[0]||value;
}
function mapUrl(room){
  const code=extractRoomCode(room);
  const u=new URL(MAP);
  u.searchParams.set('location',code);
  return u.toString();
}
function b64(s){const p='='.repeat((4-s.length%4)%4),b=(s+p).replace(/-/g,'+').replace(/_/g,'/'),raw=atob(b);return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)))}
function dayName(){return new Intl.DateTimeFormat('en-IE',{weekday:'long'}).format(new Date())}
function isoToday(){const d=new Date(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return `${d.getFullYear()}-${m}-${day}`}
function eventTime(e,key){if(!e?.date||!e?.[key])return null;const d=new Date(`${e.date}T${e[key]}:00`);return Number.isNaN(d.getTime())?null:d}
function isCurrentEvent(e){const now=new Date(),s=eventTime(e,'start'),end=eventTime(e,'end');return !!(s&&end&&e.date===isoToday()&&now>=s&&now<end)}
function currentEvent(){return visibleEvents().find(isCurrentEvent)||null}
function nextEvent(){const now=new Date();return [...visibleUpcomingEvents()].filter(e=>{const end=eventTime(e,'end');return end&&end>=now}).sort((a,b)=>`${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`))[0]||null}
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
function eventWeekday(e){if(e?.date){const d=new Date(`${e.date}T12:00:00`);if(!Number.isNaN(d.getTime()))return new Intl.DateTimeFormat('en-IE',{weekday:'long'}).format(d).toUpperCase()}if(e?.day)return String(e.day).toUpperCase();return ''}
function isoDateOffset(days){const d=new Date();d.setDate(d.getDate()+days);const m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return `${d.getFullYear()}-${m}-${day}`}
function nextClassContext(e){
  if(!e)return '';
  if(e.date===isoToday())return 'TODAY';
  if(e.date===isoDateOffset(1))return 'TOMORROW';
  return eventWeekday(e);
}
function syncAgeMs(){
  const last=state.sync?.last_success_at,ms=Date.parse(last||'');
  return Number.isFinite(ms)?Date.now()-ms:Infinity;
}
function syncNeedsPriorityWatch(){
  const status=state.sync?.status||'never-synced';
  if(['error','never-synced'].includes(status))return true;
  return syncAgeMs()>PRIORITY_WATCH_AGE_MS;
}
function syncDisplay(){
  if(state.offline){const saved=state.offlineSavedAt?formatClockDate(state.offlineSavedAt):'';return {updated:`Offline${saved?` · saved ${saved}`:''}`}}
  if(state.usingCached){const saved=state.offlineSavedAt?formatClockDate(state.offlineSavedAt):'';return {updated:`Reconnecting${saved?` · saved ${saved}`:''}`}}
  const last=state.sync?.last_success_at,status=state.sync?.status,age=syncAgeMs();
  if(!last)return {updated:status==='syncing'||status==='queued'||status==='error'?'Updating…':''};
  // A stale success timestamp is an active recovery state, never a terminal
  // "Sync delayed" state. The refresh loop/watch endpoint keeps pushing it back
  // toward fresh data while the last valid timetable remains usable.
  if(status==='syncing'||status==='queued'||status==='error'||age>5*60*1000)return {updated:'Updating…'};
  return {updated:`Synced ${formatClockDate(last)}`};
}
function mapButton(e){return e.room_code?`<button class="route" data-map-room="${esc(e.room_code)}">Open map ↗</button>`:''}
function card(e){const live=isCurrentEvent(e);return `<article class="class-card subject-card ${live?'current':''}" style="${subjectStyle(e.module)}" data-event-date="${esc(e.date||'')}" data-event-start="${esc(e.start)}"><div class="clock"><b>${esc(formatTime(e.start))}</b><span>${esc(formatTime(e.end))}</span></div><div><div class="row"><h3>${esc(e.module)}</h3>${live?'<span class="live-tag">NOW</span>':''}<span class="tag">${esc(e.type)}</span></div><div class="place">${esc(e.room_code||e.room_raw)}${e.room_name?`<small> · ${esc(e.room_name)}</small>`:''}</div><div class="teacher">${esc(e.staff)}</div></div>${mapButton(e)}</article>`}
function nav(){return `<nav>${[['today','Today'],['week','Week'],['changes','Changes'],['settings','Settings']].map(([k,l])=>`<button data-tab="${k}" class="${state.tab===k?'active':''}">${l}</button>`).join('')}</nav>`}

function setup(){
  APP.innerHTML=`<main class="setup"><div class="brandmark">T</div><p class="kicker">TUS ATHLONE</p><h1>Your timetable,<br/>without the hassle.</h1><p class="lead">Pick your course once. We keep the timetable synced and surface room and time changes.</p><label>Department<select id="dep"><option value="">Choose department</option>${state.catalog.map(d=>`<option value="${esc(d.id)}">${esc(d.label)}</option>`).join('')}</select></label><label>Find course / group<input id="course-search" type="search" placeholder="Type a course name…" autocomplete="off" disabled /></label><label>Course / group<select id="grp" disabled><option value="">Choose course</option></select></label><button id="save" class="cta" disabled>Use this timetable</button>${state.error?`<div class="setup-error">${esc(state.error)}</div>`:''}<p class="privacy">No TUS password is requested by this app.</p><p class="legal-consent">By continuing, you acknowledge the <button data-legal="terms">Terms of Use</button> and <button data-legal="privacy">Privacy Notice</button>.</p></main>${renderOverlays()}`;
  const dep=document.getElementById('dep'),search=document.getElementById('course-search'),grp=document.getElementById('grp'),save=document.getElementById('save');
  const refreshGroups=()=>{const d=state.catalog.find(x=>x.id===dep.value),q=String(search.value||'').trim().toLowerCase(),groups=(d?.groups||[]).filter(g=>!q||String(g.label||'').toLowerCase().includes(q));grp.innerHTML='<option value="">Choose course</option>'+groups.map(g=>`<option value="${esc(g.id)}">${esc(g.label)}</option>`).join('');grp.disabled=!dep.value;save.disabled=true};
  dep.onchange=()=>{search.value='';search.disabled=!dep.value;refreshGroups();if(dep.value)search.focus()};
  search.oninput=refreshGroups;grp.onchange=()=>save.disabled=!(dep.value&&grp.value);
  save.onclick=async()=>{const d=state.catalog.find(x=>x.id===dep.value),g=d?.groups?.find(x=>x.id===grp.value);state.selection={department:dep.value,group:grp.value,departmentLabel:d?.label||dep.value,groupLabel:g?.label||grp.value};localStorage.setItem(STORE,JSON.stringify(state.selection));localStorage.setItem(LEGAL_ACK,LEGAL_VERSION);state.snapshot=null;state.changes=[];state.weekDate=null;state.weekStart=null;state.error='';state.sync={status:'queued'};state.usingCached=false;state.offlineSavedAt=null;await updateExistingSubscription();render();await watchAndLoad(true);render()};
  bindCommon();
}
function syncCopy(){
  const status=state.sync?.status||'never-synced';
  if(status==='error')return {title:'Timetable temporarily unavailable',body:'We could not refresh the source just now. Your course choice is safe and the service will retry automatically.',kind:'error'};
  return {title:status==='syncing'?'Reading the latest timetable':'Preparing your timetable',body:'The first time you open your timetable, it may take a little longer to load.',kind:'working'};
}

function renderPending(){
  const m=syncCopy(),group=state.selection?.groupLabel||state.selection?.group||'';
  const attempt=state.sync?.last_attempt_at?`Last attempt ${formatClockDate(state.sync.last_attempt_at)}`:'Connecting…';
  APP.innerHTML=`<main class="app pending-page"><header><div><p class="kicker">TUS ATHLONE</p><h1>Syncing your timetable</h1></div></header><section class="sync-panel ${m.kind}"><div class="sync-icon"><span></span></div><div><p class="sync-eyebrow">${esc(group)}</p><h2>${esc(m.title)}</h2><p>${esc(m.body)}</p><div class="sync-meta">${esc(attempt)}</div></div></section>${state.error?`<div class="friendly-error">${esc(state.error)}</div>`:''}<button id="change" class="ghost">Change course</button></main>${renderOverlays()}`;
  bindCommon();
}

function render(){
  if(!state.selection)return setup();
  if(!state.snapshot)return renderPending();
  const title=state.tab==='today'?'Today':state.tab==='week'?weekPageTitle():state.tab==='changes'?'Changes':'Settings';
  let body=state.tab==='today'?renderToday():state.tab==='week'?renderWeek():state.tab==='changes'?renderChanges():renderSettings();
  const syncUi=syncDisplay();
  const cacheBanner=(state.offline||state.usingCached)?`<div class="offline-banner" role="status"><div class="offline-copy"><b>${state.offline?'Offline mode':'Reconnecting'}</b><span>${state.offlineSavedAt?`Showing data saved ${esc(formatDetected(state.offlineSavedAt))}.`:'Showing the last timetable saved on this device.'} ${state.offline?'Changes will refresh automatically when the connection returns.':'Automatic retries are running now.'}</span></div>${state.offline?'':'<button id="retry-sync" class="small-ghost" type="button">Retry now</button>'}</div>`:'';
  APP.innerHTML=`<main class="app ${state.tab==='week'?'week-app':''}"><header><div><p class="kicker">TUS ATHLONE</p><h1>${title}</h1></div><div class="header-status">${esc(syncUi.updated)}</div></header>${cacheBanner}${body}${nav()}</main>${renderOverlays()}${state.toast?`<div class="toast" role="status">${esc(state.toast)}</div>`:''}`;
  bindCommon();
}

function renderToday(){
  const today=visibleEvents().filter(e=>e.date===isoToday()||e.day===dayName()),next=nextEvent();
  return `${next?`<section class="hero ${isCurrentEvent(next)?'hero-live':''}"><p class="kicker gold">${isCurrentEvent(next)?`HAPPENING NOW${eventWeekday(next)?` (${eventWeekday(next)})`:''}`:`NEXT CLASS${nextClassContext(next)?` (${nextClassContext(next)})`:''}`}</p><h2>${esc(next.module)}</h2><div class="hero-meta"><span>${esc(formatRange(next))}</span><span>${esc(next.room_code||next.room_raw)}</span></div><p>${esc(next.room_name||next.staff)}</p>${next.room_code?`<button class="hero-button" data-map-room="${esc(next.room_code)}">Find room</button>`:''}</section>`:''}<section><div class="section-head"><h2>Today</h2><span>${today.length} classes</span></div>${today.length?today.map(e=>card(e)).join(''):'<div class="empty">No classes today.</div>'}</section>`;
}
function timeMinutes(value){const [h,m='0']=String(value||'0:0').split(':').map(Number);return (Number.isFinite(h)?h:0)*60+(Number.isFinite(m)?m:0)}
function weekBounds(events){
  if(!events.length)return {start:9*60,end:18*60};
  let start=Math.min(...events.map(e=>timeMinutes(e.start))),end=Math.max(...events.map(e=>timeMinutes(e.end)));
  start=Math.max(7*60,Math.floor(start/60)*60);end=Math.min(22*60,Math.ceil(end/60)*60);
  if(end-start<6*60)end=Math.min(22*60,start+6*60);
  return {start,end};
}
function isoFromDate(d){const m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return `${d.getFullYear()}-${m}-${day}`}
function addIsoDays(iso,days){const d=new Date(`${iso}T12:00:00`);if(Number.isNaN(d.getTime()))return '';d.setDate(d.getDate()+days);return isoFromDate(d)}
function shortDateIso(iso){if(!iso)return '';const d=new Date(`${iso}T12:00:00`);return Number.isNaN(d.getTime())?'':new Intl.DateTimeFormat('en-IE',{day:'numeric',month:'short'}).format(d)}
function longDayIso(iso){if(!iso)return '';const d=new Date(`${iso}T12:00:00`);return Number.isNaN(d.getTime())?'':new Intl.DateTimeFormat('en-IE',{weekday:'long'}).format(d)}
function loadedWeeks(){
  if(!state.snapshot)return [];
  const hidden=hiddenModules(),raw=[
    {week_number:state.snapshot.week_number,week_start:state.snapshot.week_start,week_end:state.snapshot.week_end,fetched_at:state.snapshot.fetched_at,events:state.snapshot.events||[]},
    state.snapshot.next_week
  ].filter(Boolean);
  const by=new Map();
  for(const w of raw){
    const key=String(w.week_number||w.week_start||'');
    if(!key||by.has(key))continue;
    by.set(key,{...w,events:(w.events||[]).filter(e=>!hidden.has(e.module))});
  }
  return [...by.values()].sort((a,b)=>String(a.week_start||'').localeCompare(String(b.week_start||''))||Number(a.week_number||0)-Number(b.week_number||0));
}
function weekForDate(weeks,date){return weeks.find(w=>w.week_start&&w.week_end&&date>=w.week_start&&date<=w.week_end)||null}
function horizonEnd(){return addIsoDays(isoToday(),7)}
function selectedWeekSnapshot(weeks=loadedWeeks()){
  if(!weeks.length)return null;
  let selected=state.weekStart?weeks.find(w=>w.week_start===state.weekStart):null;
  if(!selected){
    selected=weekForDate(weeks,isoToday())||weeks[0];
    state.weekStart=selected?.week_start||null;
  }
  return selected||weeks[0];
}
function weekPageTitle(){
  const weeks=loadedWeeks(),selected=selectedWeekSnapshot(weeks),current=weekForDate(weeks,isoToday())||weeks[0];
  if(!selected||!current)return 'This week';
  if(selected.week_start===current.week_start)return 'This week';
  return 'Next week';
}
function weekChipLabel(week,current){
  if(week.week_start===current?.week_start)return 'This week';
  return 'Next week';
}
function overlapLayout(list){
  const sorted=[...list].sort((a,b)=>timeMinutes(a.start)-timeMinutes(b.start)||timeMinutes(a.end)-timeMinutes(b.end));
  const groups=[];let current=[],maxEnd=-1;
  for(const e of sorted){const s=timeMinutes(e.start),en=timeMinutes(e.end);if(current.length&&s>=maxEnd){groups.push(current);current=[];maxEnd=-1}current.push(e);maxEnd=Math.max(maxEnd,en)}
  if(current.length)groups.push(current);
  const out=[];
  for(const group of groups){const laneEnds=[];const placed=[];for(const e of group){const s=timeMinutes(e.start),en=timeMinutes(e.end);let lane=laneEnds.findIndex(x=>x<=s);if(lane<0){lane=laneEnds.length;laneEnds.push(en)}else laneEnds[lane]=en;placed.push({e,lane})}const lanes=Math.max(1,laneEnds.length);placed.forEach(x=>out.push({...x,lanes}))}
  return out;
}
function mobileHorizonDays(weeks){
  const today=isoToday(),end=horizonEnd(),eventDates=new Set(weeks.flatMap(w=>(w.events||[]).map(e=>e.date)).filter(Boolean));
  const out=[];
  for(let i=0;i<=7;i++){
    const date=addIsoDays(today,i);
    if(i!==0&&!eventDates.has(date))continue;
    const week=weekForDate(weeks,date);
    out.push({date,day:longDayIso(date),weekStart:week?.week_start||null,weekNumber:week?.week_number||null});
  }
  return out;
}
function selectedMobileDate(weeks){
  const days=mobileHorizonDays(weeks),today=isoToday();
  if(state.weekDate&&days.some(x=>x.date===state.weekDate))return state.weekDate;
  const current=days.find(x=>x.date===today)||days[0];
  state.weekDate=current?.date||today;
  state.weekStart=current?.weekStart||weekForDate(weeks,today)?.week_start||null;
  return state.weekDate;
}
function mobileDayPanel(weeks,selected){
  const today=isoToday(),tomorrow=isoDateOffset(1),days=mobileHorizonDays(weeks);
  const selectedMeta=days.find(x=>x.date===selected)||{date:selected,day:longDayIso(selected),weekStart:weekForDate(weeks,selected)?.week_start||null};
  const selectedWeek=weekForDate(weeks,selected)||weeks[0];
  const list=(selectedWeek?.events||[]).filter(e=>e.date===selected).sort((a,b)=>a.start.localeCompare(b.start));
  const classes=list.length?list.map(e=>{const live=isCurrentEvent(e),room=e.room_code||e.room_raw||'Room TBC';const inner=`<span class="mobile-week-time"><b>${esc(formatTime(e.start))}</b><span>${esc(formatTime(e.end))}</span></span><span class="mobile-week-info"><strong>${esc(e.module)}</strong><span class="mobile-week-meta"><b>${esc(room)}</b>${e.type?`<span>${esc(e.type)}</span>`:''}</span>${e.staff?`<small>${esc(e.staff)}</small>`:''}</span><span class="mobile-week-side">${live?'<em>NOW</em>':''}${e.room_code?'<span aria-hidden="true">›</span>':''}</span>`;return e.room_code?`<button class="mobile-week-card ${live?'current':''}" style="${subjectStyle(e.module)}" data-map-room="${esc(e.room_code)}" aria-label="${esc(e.module)}, ${esc(formatRange(e))}, ${esc(room)}. Open campus map.">${inner}</button>`:`<div class="mobile-week-card no-route ${live?'current':''}" style="${subjectStyle(e.module)}">${inner}</div>`}).join(''):`<div class="mobile-week-empty">No classes on ${esc(longDayIso(selected)||'this day')}.</div>`;
  const count=list.length,context=selected===today?'TODAY':selected===tomorrow?'TOMORROW':String(selectedMeta?.day||longDayIso(selected)||'').toUpperCase();
  const heading=`<div><p>${esc(context)}</p><h2>${esc(selectedMeta?.day||longDayIso(selected))}${selected?` · ${esc(shortDateIso(selected))}`:''}</h2></div><span>${count} ${count===1?'class':'classes'}</span>`;
  return {heading,classes,weekStart:selectedMeta?.weekStart||selectedWeek?.week_start||null};
}
function renderMobileWeek(weeks){
  if(!weeks.length)return '<div class="mobile-week"><div class="mobile-week-empty">No timetable data available.</div></div>';
  const selected=selectedMobileDate(weeks),today=isoToday(),days=mobileHorizonDays(weeks),panel=mobileDayPanel(weeks,selected);
  const picker=days.map((x,i)=>{
    const isToday=x.date===today,isSelected=x.date===selected,isWeekStart=i>0&&x.weekStart!==days[i-1]?.weekStart;
    return `<button class="mobile-day ${isSelected?'selected':''} ${isToday?'today':''} ${isWeekStart?'week-start':''}" data-week-date="${esc(x.date)}" data-week-start="${esc(x.weekStart||'')}" aria-pressed="${isSelected?'true':'false'}"><b>${esc((x.day||'').slice(0,3))}</b><span>${esc(shortDateIso(x.date)||'—')}</span></button>`;
  }).join('');
  return `<div class="mobile-week"><div class="mobile-day-picker" aria-label="Choose day">${picker}</div><div class="mobile-week-heading">${panel.heading}</div><div class="mobile-week-list">${panel.classes}</div></div>`;
}
function bindMapButtons(root=APP){
  root.querySelectorAll?.('[data-map-room]').forEach(b=>b.onclick=()=>{const room=(b.dataset.mapRoom||'').trim();if(room)window.open(mapUrl(room),'_blank','noopener,noreferrer')});
}
function updateMobileWeekDay(date,weekStart){
  const weeks=loadedWeeks(),days=mobileHorizonDays(weeks);
  if(!days.some(x=>x.date===date))return;
  state.weekDate=date;
  state.weekStart=weekStart||weekForDate(weeks,date)?.week_start||state.weekStart;
  APP.querySelectorAll('.mobile-day[data-week-date]').forEach(btn=>{
    const selected=btn.dataset.weekDate===date;
    btn.classList.toggle('selected',selected);
    btn.setAttribute('aria-pressed',selected?'true':'false');
  });
  const panel=mobileDayPanel(weeks,date),heading=APP.querySelector('.mobile-week-heading'),list=APP.querySelector('.mobile-week-list');
  if(heading)heading.innerHTML=panel.heading;
  if(list){list.innerHTML=panel.classes;bindMapButtons(list)}
  const title=APP.querySelector('main.week-app header h1');
  if(title)title.textContent=weekPageTitle();
}
function desktopDisplayDates(selectedWeek,currentWeek){
  const today=isoToday(),end=horizonEnd(),events=selectedWeek?.events||[],eventDates=new Set(events.map(e=>e.date).filter(Boolean)),out=[];
  for(let i=0;i<7;i++){
    const date=addIsoDays(selectedWeek.week_start,i);
    const inCurrent=selectedWeek.week_start===currentWeek?.week_start;
    const pastCurrent=inCurrent&&date<today&&eventDates.has(date);
    const futureVisible=date>=today&&date<=end&&(date===today||eventDates.has(date));
    if(pastCurrent||futureVisible)out.push({date,day:longDayIso(date)});
  }
  if(!out.length&&selectedWeek?.week_start)out.push({date:selectedWeek.week_start,day:longDayIso(selectedWeek.week_start)});
  return out;
}
function renderWeek(){
  const weeks=loadedWeeks(),currentWeek=weekForDate(weeks,isoToday())||weeks[0],selectedWeek=selectedWeekSnapshot(weeks)||currentWeek||{events:[],week_start:null,week_number:null};
  const displayDates=selectedWeek?.week_start?desktopDisplayDates(selectedWeek,currentWeek):[];
  const visibleDateSet=new Set(displayDates.map(x=>x.date));
  const events=(selectedWeek.events||[]).filter(e=>visibleDateSet.has(e.date));
  const {start,end}=weekBounds(events),pxPerHour=72,bottomGutter=28,totalHeight=((end-start)/60)*pxPerHour+bottomGutter;
  const hours=[];for(let m=start;m<=end;m+=60)hours.push(m);
  const header=displayDates.map((x,i)=>{const isToday=x.date===isoToday();return `<div class="week-day-head ${isToday?'is-today':''}" style="grid-column:${i+2}"><b>${esc((x.day||'').slice(0,3))}</b><span>${esc(shortDateIso(x.date))}</span>${isToday?'<small>TODAY</small>':''}</div>`}).join('');
  const times=hours.map(m=>`<span class="week-time-label" style="top:${((m-start)/60)*pxPerHour}px">${esc(formatTime(`${Math.floor(m/60)}:00`))}</span>`).join('');
  const dayCols=displayDates.map((x,dayIndex)=>{const list=events.filter(e=>e.date===x.date),isToday=x.date===isoToday();const blocks=overlapLayout(list).map(({e,lane,lanes})=>{const top=((timeMinutes(e.start)-start)/60)*pxPerHour,height=Math.max(42,((timeMinutes(e.end)-timeMinutes(e.start))/60)*pxPerHour-4),left=(lane/lanes)*100,width=100/lanes;const current=isCurrentEvent(e);return `<button class="week-event ${current?'current':''}" style="${subjectStyle(e.module)};top:${top}px;height:${height}px;left:calc(${left}% + 3px);width:calc(${width}% - 6px)" ${e.room_code?`data-map-room="${esc(e.room_code)}"`:''} title="${esc(e.module)} · ${esc(formatRange(e))}"><span class="week-event-time">${esc(formatTime(e.start))}</span><strong>${esc(e.module)}</strong><span class="week-event-room">${esc(e.room_code||e.room_raw||'')}</span>${current?'<em>NOW</em>':''}</button>`}).join('');return `<div class="week-day-col ${isToday?'is-today':''}" style="grid-column:${dayIndex+2};height:${totalHeight}px">${blocks}</div>`}).join('');
  const selectableWeeks=weeks.filter(w=>w.week_start===currentWeek?.week_start||(w.events||[]).some(e=>e.date>=isoToday()&&e.date<=horizonEnd()));
  const weekPicker=selectableWeeks.map(w=>`<button class="desktop-week-chip ${w.week_start===selectedWeek.week_start?'selected':''}" data-week-select="${esc(w.week_start||'')}">${esc(weekChipLabel(w,currentWeek))}</button>`).join('');
  const columnCount=Math.max(1,displayDates.length),boardStyle=`grid-template-columns:72px repeat(${columnCount},minmax(205px,1fr));min-width:${Math.max(720,72+columnCount*205)}px`;
  const desktop=`<div class="week-desktop"><div class="desktop-week-picker" aria-label="Choose week">${weekPicker}</div><div class="week-caption"><span>Tap a class to open its room on the campus map</span><span>${esc(formatTime(`${Math.floor(start/60)}:00`))}–${esc(formatTime(`${Math.floor(end/60)}:00`))}</span></div><div class="week-scroll"><div class="week-board" style="${boardStyle}"><div class="week-head-spacer"></div>${header}<div class="week-time-col" style="height:${totalHeight}px">${times}</div>${dayCols}</div></div></div>`;
  return `<section class="week-section">${renderMobileWeek(weeks)}${desktop}</section>`;
}
function changeLabel(type){return ({ROOM_CHANGED:'Room changed',TIME_CHANGED:'Time changed',CLASS_ADDED:'Class added',CLASS_REMOVED:'Class removed',LECTURER_CHANGED:'Lecturer changed',CLASS_TYPE_CHANGED:'Class type changed',TEACHING_WEEKS_CHANGED:'Teaching weeks changed'})[type]||String(type||'Update').replaceAll('_',' ')}
function renderChanges(){
  return `<section>${state.changes.length?state.changes.map(c=>`<article class="change"><div class="change-type">${esc(changeLabel(c.change_type))}</div><h3>${esc(c.module)}</h3><p>${esc(c.day)} · ${esc(formatDetected(c.detected_at))}</p>${c.change_type==='ROOM_CHANGED'?`<b>${esc(c.before?.room_code||c.before?.room_raw)} → ${esc(c.after?.room_code||c.after?.room_raw)}</b>`:''}${c.change_type==='TIME_CHANGED'?`<b>${esc(formatTime(c.before?.start))} → ${esc(formatTime(c.after?.start))}</b>`:''}${c.change_type==='LECTURER_CHANGED'?`<b>${esc(c.before?.staff||'?')} → ${esc(c.after?.staff||'?')}</b>`:''}${c.change_type==='CLASS_TYPE_CHANGED'?`<b>${esc(c.before?.type||'?')} → ${esc(c.after?.type||'?')}</b>`:''}${c.change_type==='TEACHING_WEEKS_CHANGED'?`<b>${esc(c.before?.weeks_raw||'?')} → ${esc(c.after?.weeks_raw||'?')}</b>`:''}</article>`).join(''):'<div class="empty">No new timetable changes.</div>'}</section>`;
}
function pushStatusText(){if(!state.push.supported)return 'Not supported in this browser';if(state.push.permission==='denied')return 'Blocked by browser settings';if(state.push.subscribed)return 'Enabled on this device';return 'Off on this device'}
function installSummary(){const d=deviceInfo();if(d.standalone)return 'Installed on this device';if(d.ios)return 'Add to Home Screen from Safari';if(d.android)return deferredInstallPrompt?'Ready to install':'Install from your browser menu';return deferredInstallPrompt?'Ready to install':'Use the install icon in Chrome/Edge'}
function calendarFeedUrl(){return `${location.origin}/api/calendar/${encodeURIComponent(state.selection?.group||'')}.ics`}
function renderSettings(){
  const hidden=hiddenModules(),mods=[...new Set((state.snapshot.events||[]).map(e=>e.module))].sort(),device=deviceInfo();
  const installCard=device.standalone?'':`<div class="setting-card"><div><h3>Install app</h3><p>${esc(installSummary())}</p></div><button id="install-app" class="small-ghost">How to install</button></div>`;
  const reminderMinutes=Number(state.prefs.reminderMinutes||0);
  const reminderCard=`<div class="setting-card reminder-card"><div><h3>Class reminders</h3><p>Get one reminder before each class you attend. Hidden modules are excluded.</p></div><div class="segmented reminder-segmented">${[[0,'Off'],[15,'15m'],[30,'30m'],[60,'60m']].map(([v,l])=>`<button data-reminder="${v}" class="${reminderMinutes===v?'selected':''}">${l}</button>`).join('')}</div></div>`;
  const calUrl=calendarFeedUrl(),calendarCard=`<div class="setting-card calendar-card"><div><h3>Add to calendar</h3><p>Subscribe in Apple Calendar or Outlook so the feed refreshes as the timetable changes. For Google Calendar, copy the URL and add it under Other calendars → From URL.</p></div><div class="setting-actions"><button id="calendar-subscribe" class="small-primary" data-calendar-url="${esc(calUrl)}">Subscribe</button><button id="calendar-copy" class="small-ghost" data-calendar-url="${esc(calUrl)}">Copy URL</button></div></div>`;
  return `<section class="settings"><div class="setting-card"><div><h3>Notifications</h3><p>${esc(pushStatusText())}. Receive room, time and class-change alerts.</p></div><div class="setting-actions">${state.push.subscribed?'<button class="small-primary" disabled aria-disabled="true">Enabled</button><button id="test-push" class="small-ghost">Test</button><button id="disable-push" class="small-ghost danger">Disable</button>':'<button id="notify" class="small-primary">Enable</button>'}</div></div>${installCard}${reminderCard}${calendarCard}<div class="setting-card"><div><h3>Time format</h3><p>Choose how class times are displayed.</p></div><div class="segmented"><button data-time="24" class="${state.prefs.timeFormat==='24'?'selected':''}">24-hour</button><button data-time="12" class="${state.prefs.timeFormat==='12'?'selected':''}">AM/PM</button></div></div><div class="setting-card"><div><h3>Campus map</h3><p>Room buttons open the selected room in the official TUS Mappedin viewer in a separate page. The app does not request your location or start a route automatically.</p></div><a class="small-ghost settings-link" href="${MAP}" target="_blank" rel="noopener noreferrer">Open campus map ↗</a></div><button id="change" class="ghost">Change course</button><p>Selected group: <b>${esc(state.selection.groupLabel||state.selection.group)}</b></p><div class="module-box"><h3>My modules</h3><p>Hide alternatives you do not attend. Hidden modules are also excluded from future push alerts on this device.</p>${mods.map(m=>`<label class="module-row"><input type="checkbox" data-module="${esc(m)}" ${hidden.has(m)?'':'checked'}><span>${esc(m)}</span></label>`).join('')}</div><div class="legal-footer"><p><strong>Unofficial independent app.</strong> Not affiliated with, endorsed by, or authorized by Technological University of the Shannon (TUS). For student convenience only. Always verify critical timetable information using official TUS systems.</p><div><button data-legal="terms">Terms of Use</button><span>·</span><button data-legal="privacy">Privacy Notice</button></div><small>Opening a room leaves TUS Companion and sends that room identifier to the official Mappedin campus viewer.</small></div></section>`;
}

function renderOverlays(){return `${state.installModal?renderInstallModal():''}${state.notifyModal?renderNotifyModal():''}${state.legal?renderLegalModal(state.legal):''}`}
function renderInstallModal(){const d=deviceInfo();let title='Install TUS Companion',body='',action='';if(d.standalone){body='The app is already installed on this device.'}else if(deferredInstallPrompt){body='Install it for a full-screen app experience and quicker access to timetable alerts.';action='<button id="install-native" class="cta">Install app</button>'}else if(d.ios){body='On iPhone/iPad: open this page in Safari, tap the Share button, choose “Add to Home Screen”, then tap Add.'}else if(d.android){body='On Android: open the browser menu (⋮), choose “Install app” or “Add to Home screen”, then confirm.'}else{body='On Chrome or Edge desktop: use the Install icon in the address bar, or open the browser menu and choose “Install TUS Companion”.'}return `<div class="modal-backdrop" role="presentation"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="install-title"><button class="modal-x" data-close-modal aria-label="Close">×</button><p class="kicker">APP INSTALL</p><h2 id="install-title">${title}</h2><p>${body}</p>${action}<button id="install-later" class="ghost">Not now</button></section></div>`}
function renderNotifyModal(){return `<div class="modal-backdrop" role="presentation"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="notify-title"><button class="modal-x" data-close-notify aria-label="Close">×</button><p class="kicker">NOTIFICATIONS</p><h2 id="notify-title">Stay up to date</h2><p>Allow notifications on this device to get timetable changes as soon as they are detected. You can also choose a before-class reminder in Settings.</p><button id="notify-onboarding-enable" class="cta">Enable notifications</button><button id="notify-onboarding-later" class="ghost">Not now</button></section></div>`}
function legalContact(){const email=state.meta?.contact_email||'';return email?`Contact: <a href="mailto:${esc(email)}">${esc(email)}</a>.`:'Operator contact details must be configured before a public launch.'}
function renderLegalModal(kind){
  const privacy=kind==='privacy';
  const content=privacy?`<h2>Privacy Notice</h2><p class="legal-date">Effective ${LEGAL_VERSION}</p><h3>What this app processes</h3><p>Your selected department/course, time-format preference and hidden modules are stored primarily in your browser. If you enable push notifications, the server stores a browser push endpoint, its public encryption keys, your selected timetable group, hidden-module list and optional class-reminder interval so it can deliver relevant alerts.</p><h3>What we do not collect</h3><p>This app does not ask students for TUS/Microsoft usernames or passwords. TUS Companion does not collect your location. When you open a room on the campus map, the room identifier is passed in the Mappedin URL and is then handled by Mappedin under its own terms.</p><h3>Purpose and legal basis</h3><p>Timetable data is processed to provide the timetable and detect changes. If you enable push notifications, the device subscription data is processed on the basis of your consent, which you can withdraw at any time by using “Disable” in Settings. Limited technical/security processing may be necessary for the operator's legitimate interest in operating and protecting the service.</p><h3>Retention</h3><p>Course-interest records expire after the configured inactivity period. Push subscriptions remain until you turn notifications off, the browser/provider invalidates them, or the operator removes them. Group timetable snapshots are shared timetable data rather than user profiles.</p><h3>Third parties and sources</h3><p>Timetable content is obtained from TUS and can include lecturer names used only to present class information. Push delivery is performed by your browser/OS push provider. Room links open Mappedin, an external service used by TUS; once opened, its own privacy terms apply.</p><h3>Your rights</h3><p>Where GDPR applies, you may have rights of access, rectification, erasure, restriction, portability and objection, and you may withdraw consent for push processing at any time. You may also complain to the Irish Data Protection Commission. You can change course, hide modules, disable push notifications and clear local site data directly from your browser.</p><p>${legalContact()}</p>`:`<h2>Terms of Use</h2><p class="legal-date">Effective ${LEGAL_VERSION}</p><h3>Independent, unofficial service</h3><p>TUS Companion is an independent convenience tool. It is not affiliated with, endorsed by, sponsored by, or authorized by Technological University of the Shannon (TUS). TUS remains the authoritative source for timetable information.</p><h3>No guarantee of timetable accuracy</h3><p>The service may be delayed, incomplete, unavailable or affected by upstream changes. Notifications are convenience alerts only. You remain responsible for checking official TUS systems for important class, room, examination, attendance and academic information.</p><h3>Third-party services</h3><p>Room links open the official TUS Mappedin viewer and may be subject to Mappedin/TUS terms. Availability and accuracy of map data are not guaranteed by this app.</p><h3>Acceptable use</h3><p>Use the service for lawful personal/student convenience. Do not interfere with the service, attempt to obtain administrator sessions, abuse notification infrastructure, or use the app to gain access to information you are not entitled to access.</p><h3>Availability and liability</h3><p>The service is provided on an “as available” basis and may be changed, suspended or discontinued. To the maximum extent permitted by applicable law, the operator is not responsible for losses caused by relying on delayed or incorrect timetable data where official TUS information was available.</p><h3>Rights that cannot be excluded</h3><p>Nothing in these terms excludes rights or liabilities that cannot lawfully be excluded under Irish or EU law.</p><p>${legalContact()}</p>`;
  return `<div class="modal-backdrop legal-backdrop"><section class="modal legal-modal" role="dialog" aria-modal="true"><button class="modal-x" data-close-modal aria-label="Close">×</button>${content}<button class="ghost" data-close-modal>Close</button></section></div>`;
}

function bindCommon(){
  const retrySync=document.getElementById('retry-sync');
  if(retrySync)retrySync.onclick=async()=>{retrySync.disabled=true;cachedRecoveryStep=0;clearCachedRecovery();await watchAndLoad(true);render()};
  APP.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{const next=b.dataset.tab;if(next==='week'&&state.tab!=='week'){state.weekDate=isoToday();state.weekStart=weekForDate(loadedWeeks(),state.weekDate)?.week_start||null}state.tab=next;history.replaceState(null,'',state.tab==='today'?'/' : `/?tab=${state.tab}`);render()});
  APP.querySelectorAll('[data-week-date]').forEach(b=>b.onclick=()=>updateMobileWeekDay(b.dataset.weekDate,b.dataset.weekStart));
  APP.querySelectorAll('[data-week-select]').forEach(b=>b.onclick=()=>{state.weekStart=b.dataset.weekSelect||null;state.weekDate=null;render();});
  APP.querySelectorAll('[data-legal]').forEach(b=>b.onclick=()=>{state.legal=b.dataset.legal;render()});
  APP.querySelectorAll('[data-close-modal]').forEach(b=>b.onclick=()=>{state.legal=null;state.installModal=false;render()});
  APP.querySelectorAll('[data-close-notify]').forEach(b=>b.onclick=()=>{localStorage.setItem(NOTIFY_ONBOARDING,'seen');state.notifyModal=false;render()});
  bindMapButtons(APP);
  APP.querySelectorAll('[data-time]').forEach(b=>b.onclick=()=>{state.prefs.timeFormat=b.dataset.time;savePrefs();render()});
  APP.querySelectorAll('[data-reminder]').forEach(b=>b.onclick=()=>setReminderMinutes(b.dataset.reminder));
  APP.querySelectorAll('[data-module]').forEach(box=>box.onchange=async()=>{const hidden=hiddenModules(),m=box.dataset.module;if(box.checked)hidden.delete(m);else hidden.add(m);localStorage.setItem(FILTERS,JSON.stringify([...hidden]));await updateExistingSubscription();render()});
  const notify=document.getElementById('notify');if(notify)notify.onclick=enableNotifications;
  const notifyOnboarding=document.getElementById('notify-onboarding-enable');if(notifyOnboarding)notifyOnboarding.onclick=async()=>{localStorage.setItem(NOTIFY_ONBOARDING,'seen');state.notifyModal=false;await enableNotifications()};
  const notifyLater=document.getElementById('notify-onboarding-later');if(notifyLater)notifyLater.onclick=()=>{localStorage.setItem(NOTIFY_ONBOARDING,'seen');state.notifyModal=false;render()};
  const test=document.getElementById('test-push');if(test)test.onclick=testNotification;
  const disable=document.getElementById('disable-push');if(disable)disable.onclick=disableNotifications;
  const install=document.getElementById('install-app');if(install)install.onclick=()=>{state.installModal=true;render()};
  const native=document.getElementById('install-native');if(native)native.onclick=triggerNativeInstall;
  const later=document.getElementById('install-later');if(later)later.onclick=()=>{localStorage.setItem(INSTALL_DISMISSED,String(Date.now()));state.installModal=false;render()};
  const calSubscribe=document.getElementById('calendar-subscribe');if(calSubscribe)calSubscribe.onclick=()=>{const u=new URL(calSubscribe.dataset.calendarUrl||calendarFeedUrl());location.href=`webcal://${u.host}${u.pathname}`};
  const calCopy=document.getElementById('calendar-copy');if(calCopy)calCopy.onclick=async()=>{const value=calCopy.dataset.calendarUrl||calendarFeedUrl();try{await navigator.clipboard.writeText(value);toast('Calendar URL copied.')}catch{window.prompt('Copy this calendar URL:',value)}};
  const change=document.getElementById('change');if(change)change.onclick=changeCourse;
}

function changeCourse(){localStorage.removeItem(STORE);state.selection=null;state.snapshot=null;state.changes=[];state.sync=null;state.weekDate=null;state.weekStart=null;state.error='';state.usingCached=false;state.offlineSavedAt=null;render()}
function toast(message){state.toast=message;render();setTimeout(()=>{if(state.toast===message){state.toast='';render()}},2800)}
function deviceInfo(){const ua=navigator.userAgent||'',ios=/iPad|iPhone|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1),android=/Android/i.test(ua),standalone=window.matchMedia?.('(display-mode: standalone)').matches||window.navigator.standalone===true;return {ios,android,desktop:!ios&&!android,standalone}}
function shouldAutoOfferInstall(){const d=deviceInfo();if(d.standalone)return false;const last=Number(localStorage.getItem(INSTALL_DISMISSED)||0);return !last||Date.now()-last>14*24*60*60*1000}
function shouldOfferNotifyOnboarding(){const d=deviceInfo();if(localStorage.getItem(NOTIFY_ONBOARDING))return false;if(!state.selection||!state.snapshot||!state.push.supported||state.push.subscribed||state.push.permission!=='default')return false;if(d.ios&&!d.standalone)return false;return true}
async function triggerNativeInstall(){if(!deferredInstallPrompt){state.installModal=true;render();return}deferredInstallPrompt.prompt();const choice=await deferredInstallPrompt.userChoice;if(choice?.outcome==='accepted'){localStorage.setItem(INSTALL_DISMISSED,String(Date.now()))}deferredInstallPrompt=null;state.installModal=false;render()}

async function readyServiceWorker(timeoutMs=2500){
  if(!('serviceWorker'in navigator))throw new Error('service-worker-unavailable');
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_,reject)=>setTimeout(()=>reject(new Error('service-worker-timeout')),timeoutMs))
  ]);
}
async function refreshPushStatus(){
  state.push={supported:('serviceWorker'in navigator)&&('PushManager'in window)&&('Notification'in window),permission:('Notification'in window?Notification.permission:'default'),subscribed:false};
  if(!state.push.supported)return;
  try{const reg=await readyServiceWorker();state.push.subscribed=!!(await reg.pushManager.getSubscription())}catch{}
}
async function updateExistingSubscription(){try{if(!state.selection||!('serviceWorker'in navigator))return;const reg=await readyServiceWorker(),sub=await reg.pushManager?.getSubscription();if(!sub)return;const data=sub.toJSON();await api('/api/push/subscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({group_id:state.selection.group,endpoint:sub.endpoint,keys:data.keys,hidden_modules:[...hiddenModules()],reminder_minutes:Number(state.prefs.reminderMinutes||0)})})}catch{}}
async function setReminderMinutes(value){
  const minutes=Number(value);
  if(![0,15,30,60].includes(minutes))return;
  state.prefs.reminderMinutes=minutes;
  savePrefs();
  if(minutes>0&&!state.push.subscribed){
    await enableNotifications();
    await refreshPushStatus();
    if(!state.push.subscribed){
      state.prefs.reminderMinutes=0;
      savePrefs();
      toast('Enable notifications to use class reminders.');
      return;
    }
  }
  await updateExistingSubscription();
  toast(minutes?`Class reminder set for ${minutes} min before.`:'Class reminders off.');
}
async function enableNotifications(){
  try{
    const d=deviceInfo();
    if(d.ios&&!d.standalone){state.notifyModal=false;state.installModal=true;render();return}
    if(!state.push.supported)throw new Error('Push notifications are not supported in this browser.');
    const perm=Notification.permission==='granted'?'granted':await Notification.requestPermission();
    if(perm!=='granted'){await refreshPushStatus();render();return}
    const reg=await readyServiceWorker(),{publicKey}=await api('/api/push/public-key');
    if(!publicKey)throw new Error('Push is not configured on the server yet.');
    let sub=await reg.pushManager.getSubscription();
    if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(publicKey)});
    const data=sub.toJSON();
    await api('/api/push/subscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({group_id:state.selection.group,endpoint:sub.endpoint,keys:data.keys,hidden_modules:[...hiddenModules()],reminder_minutes:Number(state.prefs.reminderMinutes||0)})});
    await refreshPushStatus();
    toast('Notifications enabled on this device.');
  }catch(e){toast(e.message||String(e))}
}
async function testNotification(){try{const reg=await readyServiceWorker(),sub=await reg.pushManager.getSubscription();if(!sub)throw new Error('Enable notifications first.');await api('/api/push/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:sub.endpoint})});toast('Test notification queued.')}catch(e){toast(e.message||String(e))}}
async function disableNotifications(){try{const reg=await readyServiceWorker(),sub=await reg.pushManager.getSubscription();if(sub){await api('/api/push/unsubscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:sub.endpoint})}).catch(()=>{});await sub.unsubscribe()}await refreshPushStatus();toast('Notifications turned off.')}catch(e){toast(e.message||String(e))}}

function clearCachedRecovery(){if(cachedRecoveryTimer){window.clearTimeout(cachedRecoveryTimer);cachedRecoveryTimer=null}}
function scheduleCachedRecovery(){
  if(!state.selection||!state.snapshot||!navigator.onLine||!state.usingCached||cachedRecoveryTimer)return;
  const delay=RECOVERY_DELAYS_MS[Math.min(cachedRecoveryStep,RECOVERY_DELAYS_MS.length-1)];
  cachedRecoveryTimer=window.setTimeout(async()=>{
    cachedRecoveryTimer=null;
    if(!state.selection||!navigator.onLine||!state.usingCached)return;
    cachedRecoveryStep=Math.min(cachedRecoveryStep+1,RECOVERY_DELAYS_MS.length-1);
    await watchAndLoad(true);
    render();
    if(state.usingCached)scheduleCachedRecovery();
  },delay);
}
async function watchAndLoad(forceWatch=false){
  if(!state.selection||state.refreshing)return;state.refreshing=true;
  try{
    let w=null;
    try{
      const priorityWatch=syncNeedsPriorityWatch()&&Date.now()-lastWatchAt>PRIORITY_WATCH_INTERVAL_MS;
      if(forceWatch||!lastWatchAt||priorityWatch||Date.now()-lastWatchAt>30*60*1000){
        lastWatchAt=Date.now();
        w=await api('/api/watch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({department_id:state.selection.department,group_id:state.selection.group})});
      }
      if(w?.sync)state.sync=w.sync;
    }catch(e){if(!state.snapshot)throw e}
    try{
      const t=await apiRetry('/api/timetable/'+encodeURIComponent(state.selection.group),undefined,3);
      state.snapshot=t.snapshot;state.sync=t.sync||state.sync;
      try{
        const allChanges=await api('/api/changes/'+encodeURIComponent(state.selection.group));
        state.changes=(Array.isArray(allChanges)?allChanges:[]).filter(c=>!c?.detected_at||String(c.detected_at)>CHANGES_RESET_AT);
      }catch{}
      state.error='';state.offline=false;state.usingCached=false;cachedRecoveryStep=0;clearCachedRecovery();saveOfflineTimetable();
    }catch(e){
      state.offline=!navigator.onLine;
      if(e instanceof ApiError&&e.status===404&&e.detail==='not-synced-yet'){
        if(!state.snapshot){
          try{state.sync=await api('/api/sync-status/'+encodeURIComponent(state.selection.group))}catch{}
          state.error='';
        }else{
          state.usingCached=true;state.error='';
        }
      }else if(state.snapshot){
        state.usingCached=true;state.error='';
      }else{
        state.error='We could not contact the timetable service. It will retry automatically.';
      }
      if(state.usingCached&&!state.offline)scheduleCachedRecovery();
    }
  }catch{
    state.offline=!navigator.onLine;state.usingCached=!!state.snapshot;
    if(!state.snapshot)state.error='The timetable service is temporarily unavailable. Your course selection is still saved.';
    if(state.usingCached&&!state.offline)scheduleCachedRecovery();
  }finally{state.refreshing=false;lastLoadAt=Date.now()}
}
async function refreshLoop(){
  if(state.selection){await watchAndLoad(false);await refreshPushStatus();render()}
  const delay=state.snapshot?((state.usingCached||syncNeedsPriorityWatch())&&navigator.onLine?10000:CLOUD_REFRESH_MS):PENDING_REFRESH_MS;
  setTimeout(refreshLoop,delay);
}
async function init(){
  const di=deviceInfo();document.documentElement.classList.toggle('ios-standalone',di.ios&&di.standalone);if(state.selection&&state.snapshot)render();
  try{const [c,m]=await Promise.all([api('/api/catalog'),api('/api/meta').catch(()=>null)]);if(Array.isArray(c?.departments)&&c.departments.length){state.catalog=c.departments;saveCatalogCache()}state.meta=m;if(!state.catalog.length)state.error='Course catalogue is still being prepared. Try again in a few minutes.'}catch{if(!state.catalog.length)state.error='Could not load the course catalogue from the service.'}
  if('serviceWorker'in navigator){try{
    navigator.serviceWorker.addEventListener('controllerchange',()=>{
      if(swControllerReloading)return;
      if(swControllerSeen){swControllerReloading=true;window.location.reload();return}
      swControllerSeen=true;
    });
    const reg=await navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'});
    await reg.update().catch(()=>{});
    if(reg.waiting)reg.waiting.postMessage({type:'SKIP_WAITING'});
  }catch{}}
  await refreshPushStatus();if(state.selection)await watchAndLoad(true);if(state.selection&&state.snapshot){setTimeout(()=>{if(shouldAutoOfferInstall()){state.installModal=true;render()}else if(shouldOfferNotifyOnboarding()){state.notifyModal=true;render()}},900)}render();setTimeout(refreshLoop,state.snapshot?CLOUD_REFRESH_MS:PENDING_REFRESH_MS);
}
function temporalUiSignature(){
  if(!state.snapshot)return '';
  const current=currentEvent(),next=nextEvent();
  const key=e=>e?`${e.date||''}|${e.start||''}|${e.end||''}|${e.module||''}`:'';
  return `${isoToday()}|${key(current)}|${key(next)}`;
}
let lastTemporalUiSignature='';
setInterval(()=>{
  if(!state.selection||!state.snapshot||!['today','week'].includes(state.tab))return;
  const signature=temporalUiSignature();
  if(signature!==lastTemporalUiSignature){lastTemporalUiSignature=signature;render()}
},UI_TIME_REFRESH_MS);

window.addEventListener('offline',()=>{clearCachedRecovery();state.offline=true;state.usingCached=!!state.snapshot;render()});
window.addEventListener('online',()=>{state.offline=false;cachedRecoveryStep=0;clearCachedRecovery();if(state.selection)watchAndLoad(true).then(refreshPushStatus).then(render).catch(()=>render())});
window.addEventListener('pageshow',e=>{
  if(state.selection&&(e.persisted||state.usingCached||state.offline||Date.now()-lastLoadAt>30*1000)){
    state.offline=!navigator.onLine;
    if(!state.offline){cachedRecoveryStep=0;clearCachedRecovery()}
    watchAndLoad(true).then(refreshPushStatus).then(render).catch(()=>render());
  }
});

document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&state.selection&&(state.usingCached||state.offline||Date.now()-lastLoadAt>30*1000)){
    state.offline=!navigator.onLine;
    watchAndLoad(state.usingCached||state.offline).then(refreshPushStatus).then(render).catch(()=>{});
  }else if(document.visibilityState==='visible'&&state.snapshot){
    const signature=temporalUiSignature();
    if(signature!==lastTemporalUiSignature){lastTemporalUiSignature=signature;render()}
  }
});
init();
