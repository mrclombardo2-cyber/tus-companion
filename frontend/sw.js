const CLIENT_VERSION='16.6.0';
const CACHE='tus-companion-v16.6.0';
const CORE=['/','/styles.css','/app.js','/manifest.webmanifest','/icon-192.png','/icon-512.png'];

function canonicalRequest(request){
  const u=new URL(request.url);
  if(u.origin!==self.location.origin)return request;
  if(u.pathname==='/'||u.pathname==='/index.html')return new Request(self.location.origin+'/',{method:'GET'});
  if(['/app.js','/styles.css','/manifest.webmanifest','/icon-192.png','/icon-512.png'].includes(u.pathname)){
    return new Request(self.location.origin+u.pathname,{method:'GET'});
  }
  return request;
}

async function cacheFresh(request,response){
  if(!response||!response.ok)return;
  try{
    const cache=await caches.open(CACHE);
    await cache.put(canonicalRequest(request),response.clone());
  }catch{}
}

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    await Promise.allSettled(CORE.map(async path=>{
      const req=new Request(path,{cache:'reload'});
      const response=await fetch(req,{cache:'no-store'});
      if(response.ok)await cache.put(canonicalRequest(req),response.clone());
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)));
    if(self.registration.navigationPreload){
      try{await self.registration.navigationPreload.enable()}catch{}
    }
    await self.clients.claim();
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    await Promise.all(windows.map(async client=>{
      try{
        const u=new URL(client.url);
        if(u.origin!==self.location.origin)return;
        u.searchParams.set('_appv',CLIENT_VERSION);
        u.searchParams.set('_sw',Date.now().toString(36));
        await client.navigate(u.toString());
      }catch{}
    }));
  })());
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;

  event.respondWith((async()=>{
    try{
      const preload=event.preloadResponse?await event.preloadResponse:null;
      const response=preload||await fetch(event.request,{cache:'no-store'});
      await cacheFresh(event.request,response);
      return response;
    }catch{
      const cache=await caches.open(CACHE);
      return (await cache.match(canonicalRequest(event.request)))||
             (event.request.mode==='navigate'?await cache.match(new Request(self.location.origin+'/')):undefined)||
             Response.error();
    }
  })());
});

self.addEventListener('push',event=>{
  let d={};
  try{d=event.data.json()}catch{d={title:'TUS Companion',body:event.data?.text()||''}}
  event.waitUntil(self.registration.showNotification(d.title||'TUS Companion',{
    body:d.body||'',
    tag:d.tag||'tus-change',
    renotify:true,
    data:{url:d.url||'/?tab=changes'},
    icon:'/icon-192.png',
    badge:'/icon-192.png'
  }));
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const u=event.notification.data?.url||'/';
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(async windows=>{
    for(const w of windows){
      if('focus'in w){
        await w.navigate(u);
        return w.focus();
      }
    }
    return clients.openWindow(u);
  }));
});

self.addEventListener('message',event=>{
  if(event.data?.type==='SKIP_WAITING')self.skipWaiting();
  if(event.data?.type==='GET_VERSION')event.source?.postMessage?.({type:'SW_VERSION',version:CLIENT_VERSION});
});
