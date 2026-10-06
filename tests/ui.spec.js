import { test, expect } from "@playwright/test";
function isoOffset(days){const d=new Date();d.setHours(12,0,0,0);d.setDate(d.getDate()+days);return d.toISOString().slice(0,10)}
function snapshot(){const events=[["IT & Computer Applications 2","09:00","11:00","C74"],["Operations Management","10:00","12:00","C1141"],["Business Law","13:00","14:00","B11"],["Production Systems","11:00","13:00","C22"],["Engineering Practice","15:00","17:00","A12"]].map((x,i)=>({day:new Intl.DateTimeFormat("en-IE",{weekday:"long"}).format(new Date(`${isoOffset(i)}T12:00:00`)),date:isoOffset(i),activity:`A${i}`,module:x[0],type:"Lecture",start:x[1],end:x[2],duration:"2:00",weeks_raw:"1-12",weeks:[1,2,3],room_raw:x[3],room_code:x[3],room_name:null,staff:"Lecturer",student_groups:["G1"]}));return {student_group:"G1",group_id:"g1",department_id:"dep1",week_number:40,week_start:isoOffset(0),week_end:isoOffset(6),fetched_at:new Date().toISOString(),events,next_week:{week_number:41,week_start:isoOffset(7),week_end:isoOffset(13),fetched_at:new Date().toISOString(),events:[]}}}
const selection={department:"dep1",group:"g1",departmentLabel:"Engineering",groupLabel:"G1"},catalog={departments:[{id:"dep1",label:"Engineering",groups:[{id:"g1",label:"Industrial Production Engineering"},{id:"g2",label:"Business Law and Management"}]}]};
async function mockApi(page){const snap=snapshot();await page.route("**/api/**",async route=>{const path=new URL(route.request().url()).pathname,json=(body,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});if(path==="/api/catalog")return json(catalog);if(path==="/api/meta")return json({version:"1.9.0-cloud",contact_email:""});if(path==="/api/watch")return json({ok:true,has_snapshot:true,sync:{group_id:"g1",status:"ok",last_success_at:new Date().toISOString()}});if(path==="/api/timetable/g1")return json({snapshot:snap,sync:{group_id:"g1",status:"ok",last_success_at:new Date().toISOString()}});if(path==="/api/changes/g1")return json([]);if(path==="/api/sync-status/g1")return json({group_id:"g1",status:"ok",last_success_at:new Date().toISOString()});if(path==="/api/push/public-key")return json({publicKey:null});return json({detail:"not-found"},404)})}
async function selectStoredCourse(page){await page.addInitScript(value=>localStorage.setItem("tus-companion-course-v1",JSON.stringify(value)),selection)}
test("desktop week keeps edge time labels visible and page width stable",async({page})=>{await page.setViewportSize({width:1600,height:900});await selectStoredCourse(page);await mockApi(page);await page.goto("/?tab=week");await expect(page.locator(".week-board")).toBeVisible();const first=page.locator(".week-time-label").first();await expect(first).toHaveText("09:00");const inside=await first.evaluate(el=>{const r=el.getBoundingClientRect(),p=document.querySelector(".week-scroll").getBoundingClientRect();return r.top>=p.top-1&&r.bottom<=p.bottom+1});expect(inside).toBeTruthy();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBeTruthy()});
test("mobile week has no page overflow and uses phone-first view",async({page})=>{await page.setViewportSize({width:390,height:844});await selectStoredCourse(page);await mockApi(page);await page.goto("/?tab=week");await expect(page.locator(".mobile-week")).toBeVisible();await expect(page.locator(".week-desktop")).toBeHidden();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBeTruthy()});
test("course setup uses only department and course dropdowns",async({page})=>{await page.setViewportSize({width:390,height:844});await mockApi(page);await page.goto("/");await expect(page.locator("#course-search")).toHaveCount(0);await page.selectOption("#dep","dep1");const options=await page.locator("#grp option").allTextContents();expect(options.join(" ")).toContain("Industrial Production Engineering");expect(options.join(" ")).toContain("Business Law and Management")});
test("saved timetable remains usable when API requests fail",async({page})=>{const snap=snapshot();await page.addInitScript(({selection,snap,catalog})=>{localStorage.setItem("tus-companion-course-v1",JSON.stringify(selection));localStorage.setItem("tus-companion-catalog-v1",JSON.stringify(catalog.departments));localStorage.setItem("tus-companion-offline-v1",JSON.stringify({group_id:"g1",saved_at:new Date().toISOString(),snapshot:snap,sync:{status:"ok"},changes:[]}))},{selection,snap,catalog});await page.route("**/api/**",route=>route.abort());await page.goto("/");await expect(page.locator(".offline-banner")).toBeVisible();await expect(page.getByText("IT & Computer Applications 2").first()).toBeVisible()});
test("settings exposes a subscribable calendar feed",async({page})=>{await selectStoredCourse(page);await mockApi(page);await page.goto("/?tab=settings");await expect(page.getByText("Add to calendar")).toBeVisible();expect(await page.locator("#calendar-copy").getAttribute("data-calendar-url")).toContain("/api/calendar/g1.ics")});


test("cached timetable self-recovers after transient timetable failures",async({page})=>{
  const snap=snapshot();
  await page.addInitScript(({selection,snap,catalog})=>{
    localStorage.setItem("tus-companion-course-v1",JSON.stringify(selection));
    localStorage.setItem("tus-companion-catalog-v1",JSON.stringify(catalog.departments));
    localStorage.setItem("tus-companion-offline-v1",JSON.stringify({group_id:"g1",saved_at:new Date().toISOString(),snapshot:snap,sync:{status:"ok"},changes:[]}));
  },{selection,snap,catalog});
  let timetableCalls=0;
  await page.route("**/api/**",async route=>{
    const path=new URL(route.request().url()).pathname;
    const json=(body,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    if(path==="/api/catalog")return json(catalog);
    if(path==="/api/meta")return json({version:"1.9.0-cloud",contact_email:""});
    if(path==="/api/watch")return json({ok:true,has_snapshot:true,sync:{group_id:"g1",status:"ok",last_success_at:new Date().toISOString()}});
    if(path==="/api/timetable/g1"){
      timetableCalls++;
      if(timetableCalls<3)return json({detail:"temporary-upstream-error"},503);
      return json({snapshot:snap,sync:{group_id:"g1",status:"ok",last_success_at:new Date().toISOString()}});
    }
    if(path==="/api/changes/g1")return json([]);
    if(path==="/api/sync-status/g1")return json({group_id:"g1",status:"ok",last_success_at:new Date().toISOString()});
    if(path==="/api/push/public-key")return json({publicKey:null});
    return json({detail:"not-found"},404);
  });
  await page.goto("/");
  await expect(page.locator(".offline-banner")).toBeHidden({timeout:8000});
  await expect(page.locator(".header-status")).toContainText("Updated");
  expect(timetableCalls).toBeGreaterThanOrEqual(3);
});

test("mobile keeps pinch zoom available and avoids iOS form-focus zoom",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await mockApi(page);
  await page.goto("/");
  const viewport=await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(viewport||"").not.toContain("user-scalable=no");
  expect(viewport||"").not.toContain("maximum-scale");
  const fontSize=await page.locator("#dep").evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(16);
});


test("service worker updates cannot strand an old frontend",async({page})=>{
  await mockApi(page);
  await page.goto("/");
  const source=await page.evaluate(async()=>await fetch("/app.js?v=16.5.2",{cache:"no-store"}).then(r=>r.text()));
  expect(source).toContain("navigator.serviceWorker.addEventListener('controllerchange'");
  expect(source).toContain("window.location.reload()");
  expect(source).toContain("swControllerSeen");
});


test("background sync stays silent when a valid timetable already exists",async({page})=>{
  const snap=snapshot();
  const old=new Date(Date.now()-60*1000).toISOString();
  await selectStoredCourse(page);
  await page.route("**/api/**",async route=>{
    const path=new URL(route.request().url()).pathname;
    const json=(body,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    if(path==="/api/catalog")return json(catalog);
    if(path==="/api/meta")return json({version:"1.10.0-cloud",contact_email:""});
    if(path==="/api/watch")return json({ok:true,has_snapshot:true,sync:{group_id:"g1",status:"queued",last_attempt_at:new Date().toISOString(),last_success_at:old}});
    if(path==="/api/timetable/g1")return json({snapshot:snap,sync:{group_id:"g1",status:"queued",last_attempt_at:new Date().toISOString(),last_success_at:old}});
    if(path==="/api/changes/g1")return json([]);
    if(path==="/api/push/public-key")return json({publicKey:null});
    return json({detail:"not-found"},404);
  });
  await page.goto("/");
  await expect(page.locator(".header-status")).toContainText("Updated");
  await expect(page.locator("body")).not.toContainText("Sync delayed");
});


test("long pending course labels stay inside the sync card",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.addInitScript(()=>{
    localStorage.setItem("tus-companion-course-v1",JSON.stringify({
      department:"dep1",
      group:"g-long",
      departmentLabel:"Engineering",
      groupLabel:"AL_CCIVL_7_2 BACHELOR OF ENGINEERING IN CIVIL ENGINEERING"
    }));
  });
  await page.route("**/api/**",async route=>{
    const path=new URL(route.request().url()).pathname;
    const json=(body,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    if(path==="/api/catalog")return json(catalog);
    if(path==="/api/meta")return json({version:"1.10.2-cloud",contact_email:""});
    if(path==="/api/watch")return json({ok:true,has_snapshot:false,sync:{group_id:"g-long",status:"queued",last_attempt_at:new Date().toISOString()}});
    if(path==="/api/timetable/g-long")return json({detail:"not-synced-yet"},404);
    if(path==="/api/sync-status/g-long")return json({group_id:"g-long",status:"queued",last_attempt_at:new Date().toISOString()});
    if(path==="/api/push/public-key")return json({publicKey:null});
    return json({detail:"not-found"},404);
  });
  await page.goto("/");
  const panel=page.locator(".sync-panel");
  await expect(panel).toBeVisible();
  const fits=await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1);
  expect(fits).toBeTruthy();
});

test("an unsynced selected course becomes usable without a red error state",async({page})=>{
  const snap=snapshot();
  await selectStoredCourse(page);
  let timetableCalls=0;
  await page.route("**/api/**",async route=>{
    const path=new URL(route.request().url()).pathname;
    const json=(body,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    if(path==="/api/catalog")return json(catalog);
    if(path==="/api/meta")return json({version:"1.10.2-cloud",contact_email:""});
    if(path==="/api/watch")return json({ok:true,has_snapshot:timetableCalls>0,sync:{group_id:"g1",status:timetableCalls>0?"ok":"queued",last_attempt_at:new Date().toISOString(),last_success_at:timetableCalls>0?new Date().toISOString():null}});
    if(path==="/api/timetable/g1"){
      timetableCalls++;
      if(timetableCalls===1)return json({detail:"not-synced-yet"},404);
      return json({snapshot:snap,sync:{group_id:"g1",status:"ok",last_success_at:new Date().toISOString()}});
    }
    if(path==="/api/sync-status/g1")return json({group_id:"g1",status:"queued",last_attempt_at:new Date().toISOString()});
    if(path==="/api/changes/g1")return json([]);
    if(path==="/api/push/public-key")return json({publicKey:null});
    return json({detail:"not-found"},404);
  });
  await page.goto("/");
  await expect(page.locator(".friendly-error")).toHaveCount(0);
  await expect(page.locator(".hero")).toBeVisible({timeout:9000});
  expect(timetableCalls).toBeGreaterThanOrEqual(2);
});


test("Week cards keep long course names fully visible",async({page})=>{
  await page.setViewportSize({width:1600,height:900});
  await selectStoredCourse(page);
  const snap=snapshot();
  snap.events=[{
    ...snap.events[0],
    module:"Computer Aided Engineering Design and Advanced Structural Analysis",
    start:"09:00",
    end:"10:00"
  }];
  await page.route("**/api/**",async route=>{
    const path=new URL(route.request().url()).pathname;
    const json=(body,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    if(path==="/api/catalog")return json(catalog);
    if(path==="/api/meta")return json({version:"1.10.3-cloud",contact_email:""});
    if(path==="/api/watch")return json({ok:true,has_snapshot:true,sync:{group_id:"g1",status:"ok",last_success_at:new Date().toISOString()}});
    if(path==="/api/timetable/g1")return json({snapshot:snap,sync:{group_id:"g1",status:"ok",last_success_at:new Date().toISOString()}});
    if(path==="/api/changes/g1")return json([]);
    if(path==="/api/push/public-key")return json({publicKey:null});
    return json({detail:"not-found"},404);
  });
  await page.goto("/?tab=week");
  const card=page.locator(".week-event").first();
  await expect(card).toBeVisible();
  await expect(card.locator("strong")).toContainText("Advanced Structural Analysis");
  const clipped=await card.evaluate(el=>el.scrollHeight>el.clientHeight+1);
  expect(clipped).toBeFalsy();
});


test("installed PWA actively upgrades to the newest client shell",async({page})=>{
  await mockApi(page);
  await page.goto("/");
  const appSource=await page.evaluate(async()=>await fetch("/app.js?v=16.5.2",{cache:"no-store"}).then(r=>r.text()));
  const swSource=await page.evaluate(async()=>await fetch("/sw.js",{cache:"no-store"}).then(r=>r.text()));
  expect(appSource).toContain("const CLIENT_VERSION='16.5.2'");
  expect(appSource).toContain("ensureLatestClient");
  expect(appSource).toContain("visibilitychange");
  expect(swSource).toContain("client.navigate");
  expect(swSource).toContain("includeUncontrolled:true");
  expect(swSource).toContain("tus-companion-v16.5.2");
});

test("first open of a stale course waits for fresh data before showing the timetable",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const stale=snapshot();
  stale.events=stale.events.map(e=>({...e,module:"STALE COURSE DATA"}));
  stale.fetched_at=new Date(Date.now()-6*60*60*1000).toISOString();
  const fresh=snapshot();
  fresh.events=fresh.events.map((e,i)=>i===0?{...e,module:"Fresh current timetable"}:e);
  fresh.fetched_at=new Date().toISOString();
  let timetableCalls=0;
  await page.route("**/api/**",async route=>{
    const path=new URL(route.request().url()).pathname;
    const json=(body,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    if(path==="/api/catalog")return json(catalog);
    if(path==="/api/meta")return json({version:"1.11.2-cloud",frontend_version:"16.5.2",contact_email:""});
    if(path==="/api/watch")return json({ok:true,has_snapshot:true,sync:{group_id:"g1",status:"queued",last_attempt_at:new Date().toISOString(),last_success_at:new Date(Date.now()-6*60*60*1000).toISOString()}});
    if(path==="/api/timetable/g1"){
      timetableCalls++;
      if(timetableCalls<3)return json({snapshot:stale,sync:{group_id:"g1",status:"queued",last_success_at:new Date(Date.now()-6*60*60*1000).toISOString()}});
      return json({snapshot:fresh,sync:{group_id:"g1",status:"ok",last_success_at:new Date().toISOString()}});
    }
    if(path==="/api/changes/g1")return json([]);
    if(path==="/api/sync-status/g1")return json({group_id:"g1",status:"queued",last_attempt_at:new Date().toISOString(),last_success_at:new Date(Date.now()-6*60*60*1000).toISOString()});
    if(path==="/api/push/public-key")return json({publicKey:null});
    return json({detail:"not-found"},404);
  });
  await page.goto("/");
  await page.selectOption("#dep","dep1");
  await page.selectOption("#grp","g1");
  await page.click("#save");
  await expect(page.locator(".hero")).toBeVisible({timeout:12000});
  await expect(page.locator("body")).toContainText("Fresh current timetable");
  await expect(page.locator("body")).not.toContainText("STALE COURSE DATA");
  expect(timetableCalls).toBeGreaterThanOrEqual(3);
});


test("returning user sees cached timetable immediately and refreshes in background",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const stale=snapshot();
  stale.events=stale.events.map(e=>({...e,module:"OLD INSTALLED SNAPSHOT"}));
  stale.fetched_at=new Date(Date.now()-5*60*60*1000).toISOString();
  const fresh=snapshot();
  fresh.events=fresh.events.map((e,i)=>i===0?{...e,module:"Current installed timetable"}:e);
  fresh.fetched_at=new Date().toISOString();
  const staleSync={group_id:"g1",status:"ok",last_success_at:new Date(Date.now()-5*60*60*1000).toISOString()};
  await page.addInitScript(({selection,stale,staleSync,catalog})=>{
    localStorage.setItem("tus-companion-course-v1",JSON.stringify(selection));
    localStorage.setItem("tus-companion-catalog-v1",JSON.stringify(catalog.departments));
    localStorage.setItem("tus-companion-offline-v1",JSON.stringify({group_id:"g1",saved_at:new Date().toISOString(),snapshot:stale,sync:staleSync,changes:[]}));
  },{selection,stale,staleSync,catalog});
  let calls=0;
  await page.route("**/api/**",async route=>{
    const path=new URL(route.request().url()).pathname;
    const json=(body,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    if(path==="/api/catalog")return json(catalog);
    if(path==="/api/meta")return json({version:"1.11.2-cloud",frontend_version:"16.5.2",contact_email:""});
    if(path==="/api/watch")return json({ok:true,has_snapshot:true,sync:{group_id:"g1",status:"queued",last_attempt_at:new Date().toISOString(),last_success_at:staleSync.last_success_at}});
    if(path==="/api/timetable/g1"){
      calls++;
      if(calls<3)return json({snapshot:stale,sync:{group_id:"g1",status:"queued",last_success_at:staleSync.last_success_at}});
      return json({snapshot:fresh,sync:{group_id:"g1",status:"ok",last_success_at:new Date().toISOString()}});
    }
    if(path==="/api/changes/g1")return json([]);
    if(path==="/api/sync-status/g1")return json({group_id:"g1",status:"queued",last_attempt_at:new Date().toISOString(),last_success_at:staleSync.last_success_at});
    if(path==="/api/push/public-key")return json({publicKey:null});
    return json({detail:"not-found"},404);
  });
  await page.goto("/");
  await expect(page.locator(".sync-panel")).toHaveCount(0);
  await expect(page.locator("body")).toContainText("OLD INSTALLED SNAPSHOT");
  await page.waitForTimeout(1000);
  expect(calls).toBeGreaterThanOrEqual(1);
});
