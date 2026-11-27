// Cloudflare Worker in front of the static site in ./public.
//
//   /auth/login      redirect to Discord OAuth (state cookie)
//   /auth/callback   exchange the code, check server membership (and role), set the session cookie
//   /auth/logout     clear the session cookie
//   /demo, /demo/*   the same site in demo mode: sample data, no login, no Apps Script calls
//   /api/data        [login] GET Apps Script ?action=data&key=GAS_SECRET (cached 60 s)
//   /api/post        [login] POST to Apps Script (only when APP.allowPost; off for this app)
//   everything else  [login] static assets (index.html etc.)
//
// Vars (wrangler.jsonc): DISCORD_CLIENT_ID, GUILD_ID, GAS_URL (MGMT_ROLE_IDS only when APP.requireRole)
// Secrets (wrangler secret put): DISCORD_CLIENT_SECRET, SESSION_SECRET, GAS_SECRET
//
// The session is an HMAC-signed cookie (Discord id, username, expiry). Nothing is stored
// server-side. Membership and roles are checked at login only, so removing someone's role
// takes effect when their session expires (SESSION_DAYS).

// ---- Per-app settings (the only part that differs between the two apps) ----
const APP = {
  title: 'RSC Lineups & Tryouts',
  requireRole: false,               // any member of the RSC server
  allowPost: false,                 // this app only reads
  passParams: ['force', 'src', 'tmkey'], // src=tm&tmkey=<Tier Maker passcode> is checked by Apps Script
  who: 'members of the RSC Discord server',
  deniedNoServer: 'You are not in the RSC Discord server.',
  deniedNoRole: ''
};

// ---- Constants -------------------------------------------------------------
const JOIN_URL = 'https://discord.gg/rsc';   // shown to people who are not in the RSC server
const SESSION_DAYS = 14;
const SESSION_COOKIE = '__Host-rsc_session';
const STATE_COOKIE = '__Host-rsc_oauth';
const CACHE_SECONDS = 60;
const SEASON_CACHE_SECONDS = 300;
const CACHE_PATH = '/__cache/api-data';        // synthetic Cache API key; never served
const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
const SCOPES = 'identify guilds.members.read';
const MAX_POST_BYTES = 10000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/demo') return Response.redirect(url.origin + '/demo/' + url.search, 302);
      if (path.startsWith('/demo/')) return demoAsset(request, env, url);
      if (path === '/rsc-logo.png' || path === '/favicon.ico') return env.ASSETS.fetch(request); // used by the sign-in page
      if (path === '/auth/login') return login(env, url);
      if (path === '/auth/callback') return await callback(request, env, url, ctx);
      if (path === '/auth/logout') return logout(url);

      const user = await readSession(request, env);
      if (path.startsWith('/api/')) {
        if (!user) return json({ error: 'auth', message: 'Your sign-in has expired. Sign in again.' }, 401);
        if (path === '/api/data') return await apiData(request, env, url, ctx);
        if (path === '/api/season' && env.SEASON_URL) return await apiSeason(env);
        if (path === '/api/post' && APP.allowPost) return await apiPost(request, env, url, user, ctx);
        return json({ error: 'not_found' }, 404);
      }
      if (!user) return html(signInPage(url.pathname + url.search), 401);
      return withUser(await env.ASSETS.fetch(stripConditional(request)), user);
    } catch (err) {
      console.error('worker error', err && err.stack || err);
      if (path.startsWith('/api/')) return json({ error: 'server', postError: 'Server error, try again in a minute.', message: 'Server error, try again in a minute.' }, 500);
      return html(messagePage('Something went wrong', '<p>Please try again in a minute.</p>'), 500);
    }
  }
};

// ---- Demo ------------------------------------------------------------------
// /demo/<file> serves /<file>. The page sees /demo in its path and switches to demo mode;
// relative links (rsc-logo.png, demo-data.json) stay under /demo/.
function demoAsset(request, env, url) {
  const u = new URL(url);
  u.pathname = url.pathname.slice('/demo'.length).replace(/\/index\.html$/, '/');
  return env.ASSETS.fetch(new Request(u, request));
}

// ---- Discord OAuth ---------------------------------------------------------
function login(env, url) {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.SESSION_SECRET || !env.GUILD_ID) {
    return html(messagePage('Sign-in is not set up yet', '<p>The site owner still needs to finish the Discord setup.</p>' + demoLink()), 503);
  }
  const state = randomHex(16);
  const next = safeNext(url.searchParams.get('next'));
  const q = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: url.origin + '/auth/callback',
    response_type: 'code',
    scope: SCOPES,
    state,
    prompt: 'none' // skip the consent screen for people who already approved the app
  });
  return redirect(DISCORD_AUTHORIZE + '?' + q, [cookie(STATE_COOKIE, state + '.' + encodeURIComponent(next), 600)]);
}

async function callback(request, env, url, ctx) {
  const clearState = cookie(STATE_COOKIE, '', 0);
  const saved = readCookies(request)[STATE_COOKIE] || '';
  const dot = saved.indexOf('.');
  const state = dot > 0 ? saved.slice(0, dot) : '';
  let next = '/';
  try { next = safeNext(decodeURIComponent(saved.slice(dot + 1))); } catch (e) { /* keep '/' */ }

  if (url.searchParams.get('error')) return html(signInPage(next, 'Sign-in was cancelled.'), 401, [clearState]);
  const code = url.searchParams.get('code');
  if (!code || !state || !safeEqual(state, url.searchParams.get('state') || '')) {
    return html(signInPage(next, 'That sign-in attempt expired. Please try again.'), 400, [clearState]);
  }
  if (!env.DISCORD_CLIENT_SECRET || !env.SESSION_SECRET) return html(messagePage('Sign-in is not set up yet', demoLink()), 503, [clearState]);

  // Code -> access token
  const tr = await fetch(DISCORD_API + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: url.origin + '/auth/callback'
    })
  });
  if (!tr.ok) {
    console.warn('token exchange failed', tr.status);
    return html(signInPage(next, 'Discord did not accept the sign-in. Please try again.'), 502, [clearState]);
  }
  const token = (await tr.json()).access_token;

  // Who they are, and their membership in the RSC server (404 = not a member)
  const auth = { headers: { Authorization: 'Bearer ' + token } };
  const [meRes, memberRes] = await Promise.all([
    fetch(DISCORD_API + '/users/@me', auth),
    fetch(DISCORD_API + '/users/@me/guilds/' + env.GUILD_ID + '/member', auth)
  ]);
  ctx.waitUntil(revoke(env, token)); // the token is only needed for these two calls

  if (meRes.status === 429 || memberRes.status === 429) {
    return html(messagePage('Discord is busy', '<p>Discord asked us to slow down. Wait a minute and try again.</p>' + signInButton(next, 'Try again')), 503, [clearState]);
  }
  if (!meRes.ok || (!memberRes.ok && memberRes.status !== 404)) {
    console.warn('discord lookup failed', meRes.status, memberRes.status);
    return html(signInPage(next, 'Could not check your Discord account. Please try again.'), 502, [clearState]);
  }
  const me = await meRes.json();
  const member = memberRes.ok ? await memberRes.json() : null;
  const name = me.username || me.global_name || String(me.id);

  const denied = !member ? APP.deniedNoServer : (APP.requireRole && !hasRole(member, env.MGMT_ROLE_IDS)) ? APP.deniedNoRole : '';
  if (denied) {
    return html(deniedPage(name, denied, !member), 403, [clearState, cookie(SESSION_COOKIE, '', 0)]);
  }
  const session = await signSession(env, { id: String(me.id), u: name, exp: Date.now() + SESSION_DAYS * 86400000 });
  return redirect(next, [clearState, cookie(SESSION_COOKIE, session, SESSION_DAYS * 86400)]);
}

// Access passes if the member has ANY of the comma-separated role ids. An empty list lets nobody in.
function hasRole(member, ids) {
  const want = String(ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  const roles = Array.isArray(member.roles) ? member.roles.map(String) : [];
  return want.some((r) => roles.includes(r));
}

async function revoke(env, token) {
  try {
    await fetch(DISCORD_API + '/oauth2/token/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, token, token_type_hint: 'access_token' })
    });
  } catch (e) { /* best effort */ }
}

function logout(url) {
  return redirect(url.origin + '/', [cookie(SESSION_COOKIE, '', 0)]);
}

// Only same-site paths, never back into /auth/.
function safeNext(n) {
  if (typeof n !== 'string' || n.length > 2000 || n[0] !== '/' || n[1] === '/' || n[1] === '\\' || n.startsWith('/auth/')) return '/';
  return n;
}

// ---- Session cookie ----------------------------------------------------------
const enc = new TextEncoder();
let hmacKey = null, hmacFor = null;
async function sign(secret, data) {
  if (hmacFor !== secret) {
    hmacKey = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacFor = secret;
  }
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, enc.encode(data))));
}
async function signSession(env, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return body + '.' + await sign(env.SESSION_SECRET, body);
}
async function readSession(request, env) {
  const v = readCookies(request)[SESSION_COOKIE];
  if (!v || !env.SESSION_SECRET) return null;
  const [body, sig] = v.split('.');
  if (!body || !sig || !safeEqual(sig, await sign(env.SESSION_SECRET, body))) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return s && s.exp > Date.now() && s.u ? s : null;
  } catch (e) { return null; }
}

// ---- /api/data, /api/post ----------------------------------------------------
let memCache = null; // {body, at}: per-isolate copy, in front of the Cache API

async function apiData(request, env, url, ctx) {
  if (request.method !== 'GET') return json({ error: 'method' }, 405);
  if (!env.GAS_URL || !env.GAS_SECRET) return json({ error: 'server', message: 'The data endpoint is not set up (GAS_URL / GAS_SECRET).' }, 503);
  const fwd = new URLSearchParams({ action: 'data' });
  for (const k of APP.passParams) {
    const v = url.searchParams.get(k);
    if (v !== null && v !== '') fwd.set(k, v);
  }
  const force = fwd.get('force') === '1';
  const shared = [...fwd.keys()].every((k) => k === 'action' || k === 'force'); // same answer for everyone
  if (shared && !force) {
    const hit = await cacheGet(url);
    if (hit) return dataResponse(hit, 'HIT');
  }
  fwd.set('key', env.GAS_SECRET);
  const r = await callGas(env, '?' + fwd);
  if (r.fail) return json({ error: 'upstream', message: r.fail }, 502);
  if (shared && r.good) ctx.waitUntil(cachePut(url, r.text));
  return dataResponse(r.text, 'MISS');
}

// Season label from another app's public ?action=season (Lineups reads the Draft Board's).
// Cached for 5 minutes here so every visitor does not call Apps Script. Any failure returns
// an empty season, and the page then falls back to its own.
let seasonCache = null; // {body, at}
async function apiSeason(env) {
  if (seasonCache && Date.now() - seasonCache.at < SEASON_CACHE_SECONDS * 1000) return dataResponse(seasonCache.body, 'HIT');
  let season = '';
  try {
    const r = await fetch(env.SEASON_URL + '?action=season', { redirect: 'follow' });
    const o = JSON.parse(await r.text());
    if (o && typeof o.season === 'string') season = o.season.trim().slice(0, 40);
  } catch (e) { /* use the page's own season */ }
  const body = JSON.stringify({ season });
  if (season) seasonCache = { body, at: Date.now() };
  return dataResponse(body, 'MISS');
}

async function apiPost(request, env, url, user, ctx) {
  if (request.method !== 'POST') return json({ postError: 'Method not allowed.' }, 405);
  if (request.headers.get('Origin') !== url.origin) return json({ postError: 'Blocked: request from another site.' }, 403);
  if (!env.GAS_URL || !env.GAS_SECRET) return json({ postError: 'The data endpoint is not set up (GAS_URL / GAS_SECRET).' }, 503);
  const text = await request.text();
  if (text.length > MAX_POST_BYTES) return json({ postError: 'Request too large.' }, 413);
  let body;
  try { body = JSON.parse(text); } catch (e) { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ postError: 'Bad request.' }, 400);
  delete body.key;
  body.postedBy = user.u; // who made the change (recorded on the Trade Board)
  const r = await callGas(env, '?key=' + encodeURIComponent(env.GAS_SECRET), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  });
  if (r.fail) return json({ postError: r.fail }, 502);
  if (r.good) ctx.waitUntil(cachePut(url, r.text)); // a save returns fresh data: share it
  return dataResponse(r.text, 'POST');
}

// Calls Apps Script. Returns {text, good} (good = real data, safe to cache) or {fail: message}.
async function callGas(env, query, init) {
  let res, text;
  try {
    res = await fetch(env.GAS_URL + query, Object.assign({ redirect: 'follow' }, init || {}));
    text = await res.text();
  } catch (e) {
    return { fail: 'Could not reach Apps Script. Try again in a minute.' };
  }
  let o;
  try { o = JSON.parse(text); } catch (e) { o = null; }
  if (!o || typeof o !== 'object') return { fail: 'Apps Script sent an unexpected reply (HTTP ' + res.status + ').' };
  if (o.error === 'unauthorized') return { fail: 'Apps Script rejected the Worker key. GAS_SECRET must match in the Worker and in Script Properties.' };
  return { text, good: !o.error && !o.postError && !o.stale };
}

async function cacheGet(url) {
  if (memCache && Date.now() - memCache.at < CACHE_SECONDS * 1000) return memCache.body;
  try {
    const r = await caches.default.match(new Request(url.origin + CACHE_PATH));
    if (r) {
      const at = Number(r.headers.get('X-Stored-At')) || 0;
      if (Date.now() - at < CACHE_SECONDS * 1000) {
        const body = await r.text();
        memCache = { body, at };
        return body;
      }
    }
  } catch (e) { /* Cache API unavailable: the in-memory copy still works */ }
  return null;
}

async function cachePut(url, body) {
  const at = Date.now();
  memCache = { body, at };
  try {
    await caches.default.put(new Request(url.origin + CACHE_PATH), new Response(body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + CACHE_SECONDS, 'X-Stored-At': String(at) }
    }));
  } catch (e) { /* see cacheGet */ }
}

function dataResponse(body, cacheState) {
  return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Cache': cacheState } });
}

// ---- Signed-in pages: username and Log out in the header -------------------------
function withUser(res, user) {
  const type = res.headers.get('Content-Type') || '';
  let out = res;
  if (type.includes('text/html')) {
    out = new HTMLRewriter().on('#who', {
      element(el) {
        el.setInnerContent('<span title="Signed in with Discord">' + esc(user.u) + '</span><a href="/auth/logout">Log out</a>', { html: true });
      }
    }).transform(res);
  }
  out = new Response(out.body, out);
  out.headers.set('Cache-Control', 'private, no-store');
  out.headers.delete('ETag');
  return out;
}

// Pages carry the signed-in username, so never answer 304 from a shared ETag.
function stripConditional(request) {
  const h = new Headers(request.headers);
  h.delete('If-None-Match');
  h.delete('If-Modified-Since');
  return new Request(request, { headers: h });
}

// ---- Sign-in / denied pages (RSC dark style) ----------------------------------------
function shell(title, inner) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>' + esc(title + ' · ' + APP.title) + '</title><style>' +
    ':root{color-scheme:dark}*{box-sizing:border-box}' +
    'body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px 16px;background:#111113;color:#ececea;font:15px/1.5 Roboto,system-ui,-apple-system,"Segoe UI",Arial,sans-serif}' +
    '.card{width:100%;max-width:420px;background:#1b1b1e;border:1px solid #2e2e33;border-radius:12px;padding:28px 24px;text-align:center}' +
    '.logo{height:72px;width:auto;margin:0 auto 10px;display:block}' +
    'h1{font-size:19px;margin:0 0 4px;color:#ffd34d;letter-spacing:.3px}h2{font-size:15px;margin:0 0 14px;color:#a09f99;font-weight:500}' +
    'p{margin:0 0 14px;color:#d8d7d1}.msg{background:#4a2523;color:#ff9d96;border-radius:6px;padding:8px 12px;font-size:13.5px}' +
    '.btn{display:inline-block;background:#5865F2;color:#fff;text-decoration:none;font-weight:600;border-radius:8px;padding:10px 20px;margin:4px 0 14px}' +
    '.btn:hover{background:#4752c4}.btn:focus-visible,a:focus-visible{outline:2px solid #ffd34d;outline-offset:2px}' +
    'a{color:#ffd34d}.small{font-size:12.5px;color:#a09f99}footer{font-size:12.5px;color:#a09f99;text-align:center}footer b{color:#ececea}' +
    '</style></head><body><main class="card"><img class="logo" src="/rsc-logo.png" alt="RSC"><h1>' + esc(APP.title) + '</h1>' + inner +
    '</main><footer>Found a bug? DM <b>w.ntr</b> on Discord</footer></body></html>';
}
function signInButton(next, label) {
  // the script adds the #hash (e.g. a Lineups share link) so it survives the sign-in round trip
  return '<a class="btn" id="signin" href="/auth/login?next=' + esc(encodeURIComponent(next)) + '">' + esc(label || 'Sign in with Discord') + '</a>' +
    '<script>try{var a=document.getElementById("signin");if(location.pathname.indexOf("/auth/")!==0)a.href="/auth/login?next="+encodeURIComponent(location.pathname+location.search+location.hash);}catch(e){}</script>';
}
function demoLink() {
  return '<p class="small">Just looking? <a href="/demo/">Try the demo</a> with sample data, no sign-in needed.</p>';
}
function signInPage(next, msg) {
  return shell('Sign in', '<h2>Sign in to continue</h2>' + (msg ? '<p class="msg">' + esc(msg) + '</p>' : '') +
    '<p>Open to ' + esc(APP.who) + '.</p>' + signInButton(next) +
    '<p class="small">Only your Discord username and ' + (APP.requireRole ? 'your roles in' : 'whether you are in') + ' the RSC server are checked. Nothing is posted to Discord.</p>' + demoLink());
}
function deniedPage(name, msg, notInServer) {
  const join = notInServer ? '<p>Join the RSC Discord server at <a href="' + JOIN_URL + '">discord.gg/rsc</a>, then sign in again.</p>' : '';
  return shell('No access', '<h2>Signed in as ' + esc(name) + '</h2><p class="msg">' + esc(msg) + '</p>' + join + demoLink() +
    '<p class="small">Wrong account? Log out of Discord in this browser, then <a href="/auth/login">sign in again</a>.</p>');
}
function messagePage(title, innerHtml) {
  return shell(title, '<h2>' + esc(title) + '</h2>' + innerHtml);
}

// ---- Small helpers -------------------------------------------------------------
function html(body, status, cookies) {
  const h = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  (cookies || []).forEach((c) => h.append('Set-Cookie', c));
  return new Response(body, { status, headers: h });
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
function redirect(location, cookies) {
  const h = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  (cookies || []).forEach((c) => h.append('Set-Cookie', c));
  return new Response(null, { status: 302, headers: h });
}
function cookie(name, value, maxAge) {
  return name + '=' + value + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAge;
}
function readCookies(request) {
  const out = {};
  (request.headers.get('Cookie') || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}
function randomHex(n) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function b64url(bytes) {
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
