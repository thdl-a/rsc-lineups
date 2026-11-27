// Tests for worker.js with Discord, Apps Script and the static assets mocked.
//   node --test test/
// The same file runs in both repos; it reads APP settings from worker.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const REQUIRE_ROLE = /requireRole:\s*true/.test(SRC);
const ALLOW_POST = /allowPost:\s*true/.test(SRC);
const PASS_SRC = /passParams:[^\n]*'src'/.test(SRC);
const IDENTITY = /identity:\s*true/.test(SRC);
const SESSION_DAYS = Number(/sessionDays:\s*(\d+)/.exec(SRC)[1]);
const DENIED_ROLE = /deniedNoRole:\s*'([^']*)'/.exec(SRC)[1];   // the message this app shows to members without the role

// ---- Workers runtime stubs -------------------------------------------------------
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
// Minimal HTMLRewriter: fills <span id="who"></span> the way the real one would.
globalThis.HTMLRewriter = class {
  on(selector, handler) { this.handler = handler; return this; }
  transform(res) {
    const h = this.handler;
    const stream = new ReadableStream({
      async start(c) {
        let t = await res.text();
        h.element({ setInnerContent: (v) => { t = t.replace('<span id="who"></span>', '<span id="who">' + v + '</span>'); } });
        c.enqueue(new TextEncoder().encode(t)); c.close();
      }
    });
    return new Response(stream, { status: res.status, headers: res.headers });
  }
};
const RealResponse = Response;

const { default: worker } = await import('../worker.js?' + Date.now());

const ORIGIN = 'https://app.example';
const env = {
  DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'csecret', SESSION_SECRET: 'x'.repeat(64),
  GAS_SECRET: 'gas-key', GAS_URL: 'https://gas.example/exec', SEASON_URL: 'https://season.example/exec', GUILD_ID: 'G1', MGMT_ROLE_IDS: 'R1, R2',
  ASSETS: {
    fetch: async (req) => {
      const p = new URL(req.url || req).pathname;
      if (p === '/rsc-logo.png') return new Response('png', { headers: { 'Content-Type': 'image/png' } });
      if (p === '/') return new Response('<html><span id="who"></span>' + p + '</html>', { headers: { 'Content-Type': 'text/html', ETag: '"abc"' } });
      return new Response('asset ' + p, { headers: { 'Content-Type': 'application/octet-stream' } });
    }
  }
};

// ---- fetch mock: Discord + Apps Script --------------------------------------------
let scene = {}; const calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input.url || input);
  calls.push({ url, init });
  const j = (o, s = 200) => new RealResponse(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (url.endsWith('/oauth2/token')) return scene.tokenFail ? j({ error: 'invalid_grant' }, 400) : j({ access_token: 'tok' });
  if (url.endsWith('/oauth2/token/revoke')) return j({});
  if (url.endsWith('/users/@me')) return j({ id: '42', username: scene.username || 'tester' });
  if (url.endsWith('/users/@me/guilds/G1/member')) return scene.member ? j(scene.member) : j({ message: 'Unknown Guild', code: 10004 }, 404);
  if (url.startsWith('https://season.example')) return scene.season ? scene.season() : j({ season: 'S28' });
  if (url.startsWith('https://gas.example/exec')) {
    if (scene.gas) return scene.gas(url, init);
    return j({ v: 1, season: 'S28', builtAt: 1 });
  }
  throw new Error('unexpected fetch ' + url);
};

const ctx = () => { const w = []; return { waitUntil: (p) => w.push(p), done: () => Promise.all(w) }; };
async function go(path, opts = {}) {
  const c = ctx();
  const res = await worker.fetch(new Request(ORIGIN + path, opts), env, c);
  await c.done();
  return res;
}
const setCookies = (res) => res.headers.getSetCookie();
const cookieVal = (res, name) => { const c = setCookies(res).find((x) => x.startsWith(name + '=')); return c ? c.split(';')[0].slice(name.length + 1) : null; };

async function signIn(member, { next = '/', username } = {}) {
  scene = { member, username };
  const login = await go('/auth/login?next=' + encodeURIComponent(next));
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  const stateCookie = cookieVal(login, '__Host-rsc_oauth');
  return go('/auth/callback?code=abc&state=' + state, { headers: { Cookie: '__Host-rsc_oauth=' + stateCookie } });
}
async function session(member = { roles: ['R2'] }, opts) {
  const res = await signIn(member, opts);
  return '__Host-rsc_session=' + cookieVal(res, '__Host-rsc_session');
}

// ---- tests ---------------------------------------------------------------------
test('not signed in: sign-in page, API 401', async () => {
  const r = await go('/');
  assert.equal(r.status, 401);
  const t = await r.text();
  assert.match(t, /Sign in with Discord/);
  assert.match(t, /href="\/demo\/"/);
  const a = await go('/api/data');
  assert.equal(a.status, 401);
  assert.equal((await a.json()).error, 'auth');
});

test('demo and logo are public', async () => {
  const d = await go('/demo');
  assert.equal(d.status, 302);
  assert.equal(d.headers.get('Location'), ORIGIN + '/demo/');
  assert.match(await (await go('/demo/')).text(), /<html>/);
  assert.equal(await (await go('/demo/demo-data.json')).text(), 'asset /demo-data.json');
  assert.equal(await (await go('/rsc-logo.png')).text(), 'png');
});

test('/auth/login redirects to Discord with state cookie', async () => {
  const r = await go('/auth/login');
  assert.equal(r.status, 302);
  const u = new URL(r.headers.get('Location'));
  assert.equal(u.origin + u.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), ORIGIN + '/auth/callback');
  assert.equal(u.searchParams.get('scope'), 'identify guilds.members.read');
  const c = setCookies(r)[0];
  assert.match(c, /^__Host-rsc_oauth=[0-9a-f]{32}\./);
  assert.match(c, /HttpOnly; Secure; SameSite=Lax/);
});

test('callback rejects a bad state and a cancelled sign-in', async () => {
  const bad = await go('/auth/callback?code=x&state=nope', { headers: { Cookie: '__Host-rsc_oauth=abc.%2F' } });
  assert.equal(bad.status, 400);
  assert.equal(cookieVal(bad, '__Host-rsc_session'), null);
  const cancel = await go('/auth/callback?error=access_denied');
  assert.equal(cancel.status, 401);
  scene = { member: { roles: ['R1'] }, tokenFail: true };
  const login = await go('/auth/login');
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  const r = await go('/auth/callback?code=abc&state=' + state, { headers: { Cookie: '__Host-rsc_oauth=' + cookieVal(login, '__Host-rsc_oauth') } });
  assert.equal(r.status, 502);
});

test('matrix: logged in, not in the RSC server -> denied', async () => {
  const r = await signIn(null);
  assert.equal(r.status, 403);
  const t = await r.text();
  assert.match(t, /Signed in as tester/);
  assert.match(t, /Join the RSC Discord server at <a href="https:\/\/discord\.gg\/rsc">discord\.gg\/rsc<\/a>/);
  assert.equal(cookieVal(r, '__Host-rsc_session'), '');
});

test('matrix: in server, no Management role', async () => {
  const r = await signIn({ roles: ['R9'] });
  if (REQUIRE_ROLE) {
    assert.equal(r.status, 403);
    const t = await r.text();
    assert.ok(t.includes(DENIED_ROLE), 'shows the own "no role" message');
    assert.doesNotMatch(t, /discord\.gg\/rsc/);   // in the server: no join prompt
  } else {
    assert.equal(r.status, 302);
    assert.ok(cookieVal(r, '__Host-rsc_session'));
  }
});

test('matrix: in server with any one of the Management roles', async () => {
  for (const role of ['R1', 'R2']) {
    const r = await signIn({ roles: ['R9', role] });
    assert.equal(r.status, 302, role);
    assert.equal(r.headers.get('Location'), '/');
    const c = setCookies(r).find((x) => x.startsWith('__Host-rsc_session='));
    assert.match(c, new RegExp('Max-Age=' + SESSION_DAYS * 86400));   // this apps own sessionDays
  }
});

test('callback returns to the page (and #hash) the visitor started on, never off-site', async () => {
  const r = await signIn({ roles: ['R1'] }, { next: '/?x=1#c=L_abc' });
  assert.equal(r.headers.get('Location'), '/?x=1#c=L_abc');
  for (const evil of ['//evil.example/', 'https://evil.example/', '/\\evil.example', '/auth/logout']) {
    const e = await signIn({ roles: ['R1'] }, { next: evil });
    assert.equal(e.headers.get('Location'), '/', evil);
  }
});

test('signed in: page has the username (escaped) and Log out, never 304', async () => {
  const c = await session({ roles: ['R1'] }, { username: 'a<b>' });
  const r = await go('/', { headers: { Cookie: c, 'If-None-Match': '"abc"' } });
  assert.equal(r.status, 200);
  const t = await r.text();
  assert.match(t, /<span id="who"><span title="Signed in with Discord">a&lt;b&gt;<\/span><a href="\/auth\/logout">Log out<\/a><\/span>/);
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(r.headers.get('ETag'), null);
});

test('tampered or expired session is refused', async () => {
  const c = await session({ roles: ['R1'] });
  const [body, sig] = c.split('=')[1].split('.');
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  const forged = Buffer.from(JSON.stringify({ ...p, u: 'someone-else' })).toString('base64url');
  assert.equal((await go('/', { headers: { Cookie: '__Host-rsc_session=' + forged + '.' + sig } })).status, 401);
  // expired: sign a past expiry with the real secret
  const crypto = globalThis.crypto.subtle;
  const key = await crypto.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const old = Buffer.from(JSON.stringify({ ...p, exp: Date.now() - 1000 })).toString('base64url');
  const oldSig = Buffer.from(await crypto.sign('HMAC', key, new TextEncoder().encode(old))).toString('base64url');
  assert.equal((await go('/', { headers: { Cookie: '__Host-rsc_session=' + old + '.' + oldSig } })).status, 401);
  // a fresh one signed the same way works (checks the test's signing matches the Worker's)
  const ok = Buffer.from(JSON.stringify({ ...p, exp: Date.now() + 60000 })).toString('base64url');
  const okSig = Buffer.from(await crypto.sign('HMAC', key, new TextEncoder().encode(ok))).toString('base64url');
  assert.equal((await go('/', { headers: { Cookie: '__Host-rsc_session=' + ok + '.' + okSig } })).status, 200);
});

test('logout clears the session', async () => {
  const r = await go('/auth/logout');
  assert.equal(r.status, 302);
  assert.match(setCookies(r)[0], /^__Host-rsc_session=; .*Max-Age=0/);
});

test('/api/data adds the key, caches 60 s, Refresh bypasses the cache', async () => {
  const c = await session({ roles: ['R1'] });
  scene = {};
  const n = () => calls.filter((x) => x.url.startsWith('https://gas.example')).length;
  const before = n();
  const a = await go('/api/data?force=1', { headers: { Cookie: c } }); // fills the cache
  assert.equal(a.headers.get('X-Cache'), 'MISS');
  const sent = new URL(calls.filter((x) => x.url.startsWith('https://gas.example')).pop().url);
  assert.equal(sent.searchParams.get('action'), 'data');
  assert.equal(sent.searchParams.get('key'), 'gas-key');
  assert.equal(sent.searchParams.get('force'), '1');
  assert.equal((await a.json()).season, 'S28');
  const b = await go('/api/data', { headers: { Cookie: c } });
  assert.equal(b.headers.get('X-Cache'), 'HIT');
  assert.equal(n(), before + 1);
  const f = await go('/api/data?force=1', { headers: { Cookie: c } });
  assert.equal(f.headers.get('X-Cache'), 'MISS');
  assert.equal(n(), before + 2);
  // the visitor cannot smuggle a different key or action
  await go('/api/data?force=1&key=evil&action=other', { headers: { Cookie: c } });
  const s2 = new URL(calls.filter((x) => x.url.startsWith('https://gas.example')).pop().url);
  assert.equal(s2.searchParams.get('key'), 'gas-key');
  assert.equal(s2.searchParams.get('action'), 'data');
});

test('/api/data reports a key mismatch or a non-JSON reply as 502', async () => {
  const c = await session({ roles: ['R1'] });
  scene = { gas: () => new RealResponse(JSON.stringify({ error: 'unauthorized' })) };
  const r = await go('/api/data?force=1', { headers: { Cookie: c } });
  assert.equal(r.status, 502);
  assert.match((await r.json()).message, /GAS_SECRET/);
  scene = { gas: () => new RealResponse('<html>Google error</html>', { status: 500 }) };
  const h = await go('/api/data?force=1', { headers: { Cookie: c } });
  assert.equal(h.status, 502);
});

test('Tier Maker requests are forwarded but never shared through the cache', { skip: !PASS_SRC }, async () => {
  const c = await session({ roles: ['R1'] });
  scene = {};
  const n = () => calls.filter((x) => x.url.startsWith('https://gas.example')).length;
  const before = n();
  await go('/api/data?src=tm&tmkey=pass', { headers: { Cookie: c } });
  const r = await go('/api/data?src=tm&tmkey=pass', { headers: { Cookie: c } });
  assert.equal(r.headers.get('X-Cache'), 'MISS');
  assert.equal(n(), before + 2);
  const sent = new URL(calls.filter((x) => x.url.startsWith('https://gas.example')).pop().url);
  assert.equal(sent.searchParams.get('src'), 'tm');
  assert.equal(sent.searchParams.get('tmkey'), 'pass');
  assert.equal(sent.searchParams.get('key'), 'gas-key');
});

test('/api/post: origin check, key in query, Discord username as postedBy', { skip: !ALLOW_POST }, async () => {
  const c = await session({ roles: ['R1'] }, { username: 'poster' });
  const body = JSON.stringify({ action: 'add', gm: 'X', key: 'client-tried', postedBy: 'spoof' });
  const cross = await go('/api/post', { method: 'POST', body, headers: { Cookie: c, Origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  let seen;
  scene = { gas: (url, init) => { seen = { url, init }; return new RealResponse(JSON.stringify({ postError: 'Unknown GM: X' })); } };
  const r = await go('/api/post', { method: 'POST', body, headers: { Cookie: c, Origin: ORIGIN } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).postError, 'Unknown GM: X');
  assert.equal(new URL(seen.url).searchParams.get('key'), 'gas-key');
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.postedBy, 'poster');
  assert.equal(sent.key, undefined);
  assert.equal(sent.action, 'add');
  const anon = await go('/api/post', { method: 'POST', body, headers: { Origin: ORIGIN } });
  assert.equal(anon.status, 401);
});

test('/api/post is off when the app only reads', { skip: ALLOW_POST }, async () => {
  const c = await session({ roles: ['R1'] });
  const r = await go('/api/post', { method: 'POST', body: '{}', headers: { Cookie: c, Origin: ORIGIN } });
  assert.equal(r.status, 404);
});

test('missing secrets: sign-in says it is not set up', async () => {
  const c = ctx();
  const r = await worker.fetch(new Request(ORIGIN + '/auth/login'), { ...env, DISCORD_CLIENT_SECRET: '' }, c);
  assert.equal(r.status, 503);
});

test('/api/season: needs sign-in, is cached for visitors, and fails soft', async () => {
  assert.equal((await go('/api/season')).status, 401);
  const c = await session({ roles: ['R1'] });
  const n = () => calls.filter((x) => x.url.startsWith('https://season.example')).length;
  scene = {};
  const before = n();
  const a = await go('/api/season', { headers: { Cookie: c } });
  assert.equal((await a.json()).season, 'S28');
  const b = await go('/api/season', { headers: { Cookie: c } });
  assert.equal(b.headers.get('X-Cache'), 'HIT');
  assert.equal(n(), before + 1);                       // many visitors, one call to Apps Script
  assert.match(calls.filter((x) => x.url.startsWith('https://season.example')).pop().url, /[?]action=season$/);
});

// ---- who may post (Draft Board: roles kept in the session, /api/me) ---------------------
const sessionBody = (cookie) => JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0], 'base64url').toString());

test('identity: the session keeps the Discord id and role ids', { skip: !IDENTITY }, async () => {
  const c = await session({ roles: ['R1', 'R9', 'R10'] }, { username: 'gm1' });
  const b = sessionBody(c);
  assert.equal(b.id, '42');
  assert.deepEqual(b.r, ['R1', 'R9', 'R10']);
  assert.ok(c.length < 1500);
});

test('identity: a session from before roles were kept must sign in again', { skip: !IDENTITY }, async () => {
  const body = Buffer.from(JSON.stringify({ id: '42', u: 'old', exp: Date.now() + 60000 })).toString('base64url');
  const sig = createHmac('sha256', env.SESSION_SECRET).update(body).digest('base64url');
  const old = '__Host-rsc_session=' + body + '.' + sig;
  assert.equal((await go('/', { headers: { Cookie: old } })).status, 401);
  assert.equal((await go('/api/me', { headers: { Cookie: old } })).status, 401);
});

test('/api/me: asks Apps Script who the person may post for, with the id and roles from the session', { skip: !IDENTITY }, async () => {
  const c = await session({ roles: ['R1', 'ROLE_ART'] }, { username: 'agm1' });
  let seen;
  scene = { gas: (url, init) => { seen = { url, init }; return new RealResponse(JSON.stringify({ who: { canPost: true, gm: 'Alpha', franchise: 'Art Club', how: 'agm', why: '' } })); } };
  const r = await go('/api/me', { headers: { Cookie: c } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).who.gm, 'Alpha');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.equal(seen.init.method, 'POST');
  assert.equal(new URL(seen.url).searchParams.get('key'), 'gas-key');
  assert.deepEqual(JSON.parse(seen.init.body), { action: 'who', discordId: '42', roles: ['R1', 'ROLE_ART'] });
  assert.equal((await go('/api/me')).status, 401);
  scene = { gas: () => new RealResponse(JSON.stringify({ error: 'unauthorized' })) };
  assert.equal((await go('/api/me', { headers: { Cookie: c } })).status, 502);
});

test('/api/post: the Discord id and roles come from the session, never from the browser', { skip: !(IDENTITY && ALLOW_POST) }, async () => {
  const c = await session({ roles: ['R1', 'ROLE_ART'] }, { username: 'poster' });
  let seen;
  scene = { gas: (url, init) => { seen = JSON.parse(init.body); return new RealResponse(JSON.stringify({ postError: 'x' })); } };
  await go('/api/post', { method: 'POST', body: JSON.stringify({ action: 'paste', gm: 'Bravo', discordId: '999', roles: ['AGM'], postedBy: 'spoof' }), headers: { Cookie: c, Origin: ORIGIN } });
  assert.equal(seen.discordId, '42');
  assert.deepEqual(seen.roles, ['R1', 'ROLE_ART']);
  assert.equal(seen.postedBy, 'poster');
});

test('/api/me does not exist for the app that does not use it', { skip: IDENTITY }, async () => {
  const c = await session({ roles: ['R1'] });
  assert.equal((await go('/api/me', { headers: { Cookie: c } })).status, 404);
});

// ---- maintenance mode ------------------------------------------------------------------------
const MAINT = /maintenance:\s*true/.test(SRC);
const ADMIN_ROLE = (/adminRoleId:\s*'(\d+)'/.exec(SRC) || [])[1];
// A fresh copy of the Worker has an empty flag memory, so each test starts from "not read yet".
async function freshWorker() { return (await import('../worker.js?m' + Math.random())).default; }
async function goWith(w, path, opts = {}) {
  const c = ctx(); const res = await w.fetch(new Request(ORIGIN + path, opts), env, c); await c.done(); return res;
}
const maintCalls = () => calls.filter((c) => /"action":"maint"/.test(String(c.init && c.init.body)));
const flag = (on) => ({ gas: (url, init) => new RealResponse(JSON.stringify(/"action":"maint"/.test(String(init && init.body)) ? { maintenance: on } : { tiers: [], posts: [], v: 1 })) });

test('maintenance on: everyone except Admins gets "back soon" (page 503, API 503); Admins get in; sign-in still works', { skip: !MAINT }, async () => {
  const gm = await session({ roles: ['R2'] }, { username: 'gm' });
  const admin = await session({ roles: ['R1', ADMIN_ROLE] }, { username: 'boss' });
  const w = await freshWorker();
  scene = flag(true);
  const page = await goWith(w, '/', { headers: { Cookie: gm } });
  assert.equal(page.status, 503);
  assert.match(await page.text(), /down for a short update/);
  const api = await goWith(w, '/api/data', { headers: { Cookie: gm } });
  assert.equal(api.status, 503);
  const o = await api.json(); assert.equal(o.error, 'maintenance'); assert.match(o.message, /short update/);
  assert.equal((await goWith(w, '/api/post', { method: 'POST', body: '{}', headers: { Cookie: gm, Origin: ORIGIN } })).status, 503);
  assert.equal((await goWith(w, '/api/me', { headers: { Cookie: gm } })).status, 503);
  assert.equal((await goWith(w, '/', { headers: { Cookie: admin } })).status, 200);
  assert.equal((await goWith(w, '/api/data', { headers: { Cookie: admin } })).status, 200);
  assert.equal((await goWith(w, '/api/me', { headers: { Cookie: admin } })).status, 200);
  assert.equal((await goWith(w, '/')).status, 401);                                   // signed out: the sign-in page
  assert.equal((await goWith(w, '/auth/login')).status, 302);                          // and signing in works
  assert.equal((await goWith(w, '/demo/')).status, 200);
});

test('maintenance off, or the flag cannot be read: the site stays up', { skip: !MAINT }, async () => {
  const gm = await session({ roles: ['R2'] }, { username: 'gm' });
  let w = await freshWorker(); scene = flag(false);
  assert.equal((await goWith(w, '/', { headers: { Cookie: gm } })).status, 200);
  w = await freshWorker(); scene = { gas: () => { throw new Error('Apps Script is down'); } };
  assert.equal((await goWith(w, '/', { headers: { Cookie: gm } })).status, 200);
  w = await freshWorker(); scene = { gas: () => new RealResponse('<html>not json</html>') };
  assert.equal((await goWith(w, '/', { headers: { Cookie: gm } })).status, 200);
  w = await freshWorker(); scene = { gas: () => new RealResponse(JSON.stringify({ error: 'unauthorized' })) };
  assert.equal((await goWith(w, '/', { headers: { Cookie: gm } })).status, 200);
});

test('maintenance: the flag is read with the key, and remembered for a few seconds', { skip: !MAINT }, async () => {
  const gm = await session({ roles: ['R2'] }, { username: 'gm' });
  const w = await freshWorker(); scene = flag(false);
  calls.length = 0;
  for (let i = 0; i < 4; i++) await goWith(w, '/', { headers: { Cookie: gm } });
  assert.equal(maintCalls().length, 1);
  assert.equal(new URL(maintCalls()[0].url).searchParams.get('key'), 'gas-key');
});

test('maintenance: an app without it never asks Apps Script about it', { skip: MAINT }, async () => {
  const c = await session({ roles: ['R1'] });
  scene = flag(true);
  calls.length = 0;
  assert.equal((await go('/', { headers: { Cookie: c } })).status, 200);
  assert.equal(maintCalls().length, 0);
});

// ---- only real board data is shared through the cache ----------------------------------------
test('an Admin reply (AGM list, backups) is passed on but never cached as board data', { skip: !(ALLOW_POST && IDENTITY) }, async () => {
  const c = await session({ roles: ['R1'] }, { username: 'a' });
  const w = await freshWorker();
  scene = { gas: () => new RealResponse(JSON.stringify({ agms: [{ id: '1' }] })) };
  const post = await goWith(w, '/api/post', { method: 'POST', body: JSON.stringify({ action: 'agmlist' }), headers: { Cookie: c, Origin: ORIGIN } });
  assert.deepEqual((await post.json()).agms, [{ id: '1' }]);
  scene = { gas: () => new RealResponse(JSON.stringify({ tiers: [], posts: [], v: 1 })) };
  calls.length = 0;
  const data = await (await goWith(w, '/api/data', { headers: { Cookie: c } })).json();
  assert.ok(Array.isArray(data.tiers), 'the board data, not the AGM list');
  assert.equal(calls.filter((x) => x.url.startsWith('https://gas.example')).length >= 1, true);
});
test('a Trade Board save reply (the fresh board) is still shared through the cache', { skip: !(ALLOW_POST && IDENTITY) }, async () => {
  const c = await session({ roles: ['R1'] }, { username: 'a' });
  const w = await freshWorker();
  scene = { gas: () => new RealResponse(JSON.stringify({ tiers: [], posts: [['fresh']], v: 1 })) };
  await goWith(w, '/api/post', { method: 'POST', body: JSON.stringify({ action: 'add' }), headers: { Cookie: c, Origin: ORIGIN } });
  scene = { gas: () => { throw new Error('should have been served from the cache'); } };
  const data = await (await goWith(w, '/api/data', { headers: { Cookie: c } })).json();
  assert.deepEqual(data.posts, [['fresh']]);
});
