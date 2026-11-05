import { createRemoteJWKSet, jwtVerify } from "jose";
import { ScientiaSession } from "./scientia.js";

// Opt-in only. TUS must approve this client for the actual Timetables
// resource. User passwords and MFA codes always stay with Microsoft.
const CALLBACK = "https://tus-companion.tusathlone.workers.dev/api/entraid/callback";
const AAD = new TextEncoder().encode("tus-companion-entra-delegated-v1");
const jwks = new Map();
export function delegationReadiness(env = {}) {
  const required = ["TUS_ENTRA_TENANT_ID","TUS_ENTRA_CLIENT_ID","TUS_ENTRA_CLIENT_SECRET","TUS_ENTRA_PROXY_SCOPE","TUS_ENTRA_OPERATOR_OID","SESSION_CIPHER_KEY_B64"];
  const missing = required.filter(x=>!String(env[x]||"").trim());
  const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const scope=String(env.TUS_ENTRA_PROXY_SCOPE||"").trim();
  const allowed=/^(?:api:\/\/[a-z0-9._-]+|https:\/\/[a-z0-9._/-]+)\/user_impersonation$/i.test(scope)&&!/graph\.microsoft\.com/i.test(scope);
  const valid=guid.test(String(env.TUS_ENTRA_TENANT_ID||""))&&guid.test(String(env.TUS_ENTRA_CLIENT_ID||""))&&guid.test(String(env.TUS_ENTRA_OPERATOR_OID||""))&&allowed;
  return {configured:missing.length===0&&valid,missing:missing.length?missing:(valid?[]:["INVALID_ENTRA_CONFIGURATION"])};
}
function cfg(env){if(!delegationReadiness(env).configured)throw Error("delegated-access-not-configured");
  return {tenant:env.TUS_ENTRA_TENANT_ID,client:env.TUS_ENTRA_CLIENT_ID,secret:env.TUS_ENTRA_CLIENT_SECRET,scope:env.TUS_ENTRA_PROXY_SCOPE,oid:env.TUS_ENTRA_OPERATOR_OID.toLowerCase()};}
function encode(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
function decode(value){const s=String(value).replace(/-/g,"+").replace(/_/g,"/");return Uint8Array.from(atob(s+"=".repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));}
function randomToken(n=32){return encode(crypto.getRandomValues(new Uint8Array(n)));}
function page(message,status=200,extra={}){const body='<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TUS authorization</title><main style="font:16px system-ui;max-width:32rem;margin:3rem auto;padding:1rem"><h1>TUS Companion</h1><p>'+message+'</p><a href="/">Return to timetable</a></main></html>';
  return new Response(body,{status,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store",...extra}});}
function cookie(request){for(const part of (request.headers.get("cookie")||"").split(";")){const i=part.indexOf("=");if(i>=0&&part.slice(0,i).trim()==="tus_entra_state")return part.slice(i+1).trim();}return "";}
const clearCookie="tus_entra_state=; Max-Age=0; Path=/api/entraid/callback; HttpOnly; Secure; SameSite=Lax";
async function schema(env){
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS entra_pending(state TEXT PRIMARY KEY,nonce TEXT NOT NULL,verifier TEXT NOT NULL,expires_ms INTEGER NOT NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS entra_session(id INTEGER PRIMARY KEY CHECK(id=1),nonce TEXT NOT NULL,ciphertext TEXT NOT NULL,revision TEXT NOT NULL,updated_at TEXT NOT NULL)").run();
}
async function tokenRequest(c,fields){
  const body=new URLSearchParams({client_id:c.client,client_secret:c.secret,scope:"openid profile offline_access "+c.scope,...fields});
  const res=await fetch("https://login.microsoftonline.com/"+c.tenant+"/oauth2/v2.0/token",{method:"POST",body,headers:{"content-type":"application/x-www-form-urlencoded"},signal:AbortSignal.timeout(15000)});
  if(!res.ok)throw Error("delegated-token-exchange-failed");
  const data=await res.json();if(!data.access_token||!Number(data.expires_in))throw Error("delegated-token-not-issued");return data;
}
async function verifyIdToken(c,data,nonce){
  if(!data.id_token)throw Error("delegated-id-token-missing");
  let keys=jwks.get(c.tenant);if(!keys){keys=createRemoteJWKSet(new URL("https://login.microsoftonline.com/"+c.tenant+"/discovery/v2.0/keys"));jwks.set(c.tenant,keys);}
  const {payload}=await jwtVerify(data.id_token,keys,{audience:c.client,issuer:"https://login.microsoftonline.com/"+c.tenant+"/v2.0",algorithms:["RS256"],clockTolerance:"60s"});
  if(payload.nonce!==nonce||String(payload.oid||"").toLowerCase()!==c.oid||String(payload.tid||"").toLowerCase()!==c.tenant.toLowerCase())throw Error("delegated-operator-mismatch");
}
async function key(env){const raw=decode(env.SESSION_CIPHER_KEY_B64||"");if(raw.length!==32)throw Error("invalid-delegated-encryption-key");return crypto.subtle.importKey("raw",raw,{name:"AES-GCM"},false,["encrypt","decrypt"]);}
async function encrypt(env,payload){
  const iv=crypto.getRandomValues(new Uint8Array(12));const data=new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:AAD},await key(env),data);
  return {nonce:encode(iv),ciphertext:encode(new Uint8Array(ciphertext))};
}
async function decrypt(env,row){
  const bytes=await crypto.subtle.decrypt({name:"AES-GCM",iv:decode(row.nonce),additionalData:AAD},await key(env),decode(row.ciphertext));
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function saveTokens(env,payload,revision=null){
  const secret=await encrypt(env,payload),next=crypto.randomUUID(),now=new Date().toISOString();
  if(revision){
    const res=await env.DB.prepare("UPDATE entra_session SET nonce=?,ciphertext=?,revision=?,updated_at=? WHERE id=1 AND revision=?").bind(secret.nonce,secret.ciphertext,next,now,revision).run();
    return Boolean(res.meta?.changes);
  }
  await env.DB.prepare("INSERT INTO entra_session(id,nonce,ciphertext,revision,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce,ciphertext=excluded.ciphertext,revision=excluded.revision,updated_at=excluded.updated_at").bind(secret.nonce,secret.ciphertext,next,now).run();
  return true;
}
export async function startDelegatedSignIn(env){
  let c;try{c=cfg(env);}catch{return page("University-approved Microsoft delegation is not configured. TUS IT must authorize the client and Timetables permission.",503);}
  await schema(env);
  const state=randomToken(),nonce=randomToken(),verifier=randomToken(48);
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier));
  await env.DB.prepare("DELETE FROM entra_pending WHERE expires_ms<?").bind(Date.now()).run();
  await env.DB.prepare("INSERT INTO entra_pending(state,nonce,verifier,expires_ms) VALUES(?,?,?,?)").bind(state,nonce,verifier,Date.now()+600000).run();
  const url=new URL("https://login.microsoftonline.com/"+c.tenant+"/oauth2/v2.0/authorize");
  const params={client_id:c.client,response_type:"code",redirect_uri:CALLBACK,response_mode:"query",scope:"openid profile offline_access "+c.scope,state,nonce,code_challenge:encode(new Uint8Array(digest)),code_challenge_method:"S256"};
  for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
  return new Response(null,{status:302,headers:{location:url.toString(),"cache-control":"no-store","set-cookie":"tus_entra_state="+state+"; Max-Age=600; Path=/api/entraid/callback; HttpOnly; Secure; SameSite=Lax"}});
}
export async function completeDelegatedSignIn(request,env){
  let c;try{c=cfg(env);}catch{return page("Delegated sign-in is not configured.",503);}
  const url=new URL(request.url),state=url.searchParams.get("state")||"";
  if(!/^[A-Za-z0-9_-]{20,150}$/.test(state)||cookie(request)!==state)return page("Invalid authorization session.",400,{"set-cookie":clearCookie});
  await schema(env);
  const row=await env.DB.prepare("SELECT * FROM entra_pending WHERE state=?").bind(state).first();
  await env.DB.prepare("DELETE FROM entra_pending WHERE state=?").bind(state).run();
  const denied=(message)=>page(message,403,{"set-cookie":clearCookie});
  if(!row||row.expires_ms<Date.now())return denied("Authorization link expired. Restart the request.");
  if(url.searchParams.has("error"))return denied("Microsoft did not authorize timetable access. Contact TUS IT.");
  const code=url.searchParams.get("code")||"";
  if(!code||code.length>8192)return denied("Microsoft authorization code missing.");
  try{
    const data=await tokenRequest(c,{grant_type:"authorization_code",code,redirect_uri:CALLBACK,code_verifier:row.verifier});
    await verifyIdToken(c,data,row.nonce);
    if(!data.refresh_token)return denied("Renewable offline_access was not granted by TUS.");
    // The actual Scientia resource must accept this audience; Graph sign-in
    // alone does NOT authorize cloud source access.
    const probe=new ScientiaSession({cookies:[],origins:[]},fetch,data.access_token);
    try{await probe.ensureReady();}catch{return denied("Microsoft login succeeded but TUS Timetables rejected the delegated token. TUS IT must enable native-client API access.");}
    await saveTokens(env,{access_token:data.access_token,refresh_token:data.refresh_token,expires_ms:Date.now()+Number(data.expires_in)*1000});
    await env.DB.prepare("INSERT INTO meta(key,value,updated_at) VALUES('source_session_error','',?) ON CONFLICT(key) DO UPDATE SET value='',updated_at=excluded.updated_at").bind(new Date().toISOString()).run();
    return page("Delegated TUS access is connected. Cloudflare can now synchronize without the phone remaining online.",200,{"set-cookie":clearCookie});
  }catch{return denied("Delegated Microsoft authorization could not be verified. Check the approved TUS client, tenant and permissions.");}
}
export async function delegatedAccessToken(env){
  if(!delegationReadiness(env).configured)return null;
  await schema(env);
  const row=await env.DB.prepare("SELECT nonce,ciphertext,revision FROM entra_session WHERE id=1").first();
  if(!row)return null;
  const stored=await decrypt(env,row);
  if(Number(stored.expires_ms)>Date.now()+240000)return stored.access_token;
  if(!stored.refresh_token)throw Error("delegated-reauthorization-required");
  const data=await tokenRequest(cfg(env),{grant_type:"refresh_token",refresh_token:stored.refresh_token});
  const next={access_token:data.access_token,refresh_token:data.refresh_token||stored.refresh_token,expires_ms:Date.now()+Number(data.expires_in)*1000};
  if(!(await saveTokens(env,next,row.revision))){
    const latest=await env.DB.prepare("SELECT nonce,ciphertext FROM entra_session WHERE id=1").first();
    return (await decrypt(env,latest)).access_token;
  }
  return next.access_token;
}
export async function delegatedAuthStatus(env){
  if(!delegationReadiness(env).configured)return {mode:"needs-university-approval",connect_url:null};
  await schema(env);
  const row=await env.DB.prepare("SELECT updated_at FROM entra_session WHERE id=1").first();
  return {mode:row?"delegated-session-present":"waiting-for-phone-authorization",connect_url:"/api/entraid/connect",last_authorized_at:row?.updated_at||null};
}
