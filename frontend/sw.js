const CLIENT_VERSION='16.5.1';
const CACHE='tus-companion-v16.5.1';
const ASSETS=['/','/styles.css?v=16.5.1','/app.js?v=16.5.1','/manifest.webmanifest','/icon-192.png','/icon-512.png'];

self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));

self.addEventListener('activate',e=>e.waitUntil((async()=>{
  const keys=await caches.keys();
  await Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)));
  await self.clients.claim();
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  await Promise.all(windows.map(async client=>{
    try{
      const u=new URL(client.url);
      if(u.origin!==self.location.origin)return;
      u.searchParams.set('_appv',CLIENT_VERSION);
      await client.navigate(u.toString());
    }catch{}
  }));
})()));

self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET'||new URL(e.request.url).pathname.startsWith('/api/'))return;
  e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{
    const copy=r.clone();
    caches.open(CACHE).then(c=>c.put(e.request,copy));
    return r;
  }).catch(()=>caches.match(e.request).then(r=>r||caches.match('/'))));
});

self.addEventListener('push',e=>{let d={};try{d=e.data.json()}catch{d={title:'TUS Companion',body:e.data?.text()||''}};e.waitUntil(self.registration.showNotification(d.title||'TUS Companion',{body:d.body||'',tag:d.tag||'tus-change',renotify:true,data:{url:d.url||'/?tab=changes'},icon:'/icon-192.png',badge:'/icon-192.png'}))});
self.addEventListener('notificationclick',e=>{e.notification.close();const u=e.notification.data?.url||'/';e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(ws=>{for(const w of ws){if('focus'in w){w.navigate(u);return w.focus()}}return clients.openWindow(u)}))});
self.addEventListener('message',e=>{if(e.data?.type==='SKIP_WAITING')self.skipWaiting()});
