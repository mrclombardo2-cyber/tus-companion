const CACHE='tus-companion-v15.2';
const ASSETS=['/','/styles.css?v=15.2.0','/app.js?v=15.2.0','/manifest.webmanifest','/icon-192.png','/icon-512.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))),self.clients.claim()])))
self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||new URL(e.request.url).pathname.startsWith('/api/'))return;e.respondWith(fetch(e.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('/'))))});
self.addEventListener('push',e=>{let d={};try{d=e.data.json()}catch{d={title:'TUS Companion',body:e.data?.text()||''}};e.waitUntil(self.registration.showNotification(d.title||'TUS Companion',{body:d.body||'',tag:d.tag||'tus-change',renotify:true,data:{url:d.url||'/?tab=changes'},icon:'/icon-192.png',badge:'/icon-192.png'}))});
self.addEventListener('notificationclick',e=>{e.notification.close();const u=e.notification.data?.url||'/';e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(ws=>{for(const w of ws){if('focus'in w){w.navigate(u);return w.focus()}}return clients.openWindow(u)}))});

self.addEventListener('message',e=>{if(e.data?.type==='SKIP_WAITING')self.skipWaiting()});
