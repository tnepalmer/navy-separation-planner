// Navy Separation Planner reminder server.
// Stores each device's push subscription and its reminder dates, and sends a
// notification 7 days before and on the due date, at 9 a.m. in the device's time zone.
// No names, notes or other personal details are stored: only the browser's push
// address, the time zone, and a list of {id, title, date}.

const MAX_REMINDERS = 120;
const MAX_TITLE = 160;
const MAX_BODY = 48 * 1024;
const SEND_HOUR = 9;
const SUB_TTL_DAYS = 800; // records untouched this long are deleted

const enc = new TextEncoder();
const b64u = {
  enc(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '==='.slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
};
const concat = (...parts) => {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// ---------- HKDF (RFC 5869) with SHA-256 ----------
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  const t = await hmac(prk, concat(info, new Uint8Array([1])));
  return t.slice(0, length);
}

// ---------- Web Push payload encryption (RFC 8291, aes128gcm) ----------
export async function encryptPayload(subKeys, plaintext) {
  const uaPublic = b64u.dec(subKeys.p256dh);
  const authSecret = b64u.dec(subKeys.auth);
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const padded = concat(enc.encode(plaintext), new Uint8Array([2])); // final record delimiter
  const aes = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, padded));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

// ---------- VAPID (RFC 8292) ----------
export async function vapidAuth(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u.enc(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.enc(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + claims)));
  return 'vapid t=' + header + '.' + claims + '.' + b64u.enc(sig) + ', k=' + vapid.publicKey;
}

export async function sendPush(sub, payload, vapid, subject) {
  const body = await encryptPayload(sub.keys, JSON.stringify(payload));
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(20 * 3600),
      Urgency: 'normal',
      Authorization: await vapidAuth(sub.endpoint, vapid, subject)
    },
    body
  });
}

// ---------- helpers ----------
function localParts(tz, when) {
  let fmt;
  try { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }); }
  catch (e) { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }); }
  const p = Object.fromEntries(fmt.formatToParts(when).map((x) => [x.type, x.value]));
  return { date: p.year + '-' + p.month + '-' + p.day, hour: Number(p.hour) };
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmtDate(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}
async function idFor(endpoint) {
  return b64u.enc(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(endpoint)))).slice(0, 32);
}
function validSub(s, env) {
  try {
    const u = new URL(s.endpoint);
    return (u.protocol === 'https:' || (env && env.TEST_ALLOW_HTTP === 'yes' && u.hostname === '127.0.0.1')) && s.endpoint.length < 1200 && b64u.dec(s.keys.p256dh).length === 65 && b64u.dec(s.keys.auth).length === 16;
  } catch (e) { return false; }
}
function cleanReminders(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_REMINDERS).filter((r) => r && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && typeof r.title === 'string')
    .map((r) => ({ id: String(r.id || '').slice(0, 40), title: r.title.slice(0, MAX_TITLE), date: r.date }));
}

// ---------- storage: one SQLite-backed Durable Object ----------
export class Store {
  constructor(state, env) {
    this.state = state; this.env = env; this.sql = state.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS subs (id TEXT PRIMARY KEY, sub TEXT NOT NULL, tz TEXT NOT NULL, reminders TEXT NOT NULL, sent TEXT NOT NULL DEFAULT \'{}\', updated INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  }
  async vapid() {
    const row = this.sql.exec('SELECT v FROM meta WHERE k = ?', 'vapid').toArray()[0];
    if (row) return JSON.parse(row.v);
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const v = { publicKey: b64u.enc(await crypto.subtle.exportKey('raw', kp.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
    this.sql.exec('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)', 'vapid', JSON.stringify(v));
    return JSON.parse(this.sql.exec('SELECT v FROM meta WHERE k = ?', 'vapid').toArray()[0].v);
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/key') return Response.json({ publicKey: (await this.vapid()).publicKey });
    if (url.pathname === '/save') {
      const b = await req.json();
      const id = await idFor(b.subscription.endpoint);
      const reminders = cleanReminders(b.reminders);
      const prev = this.sql.exec('SELECT sent FROM subs WHERE id = ?', id).toArray()[0];
      this.sql.exec('INSERT OR REPLACE INTO subs (id, sub, tz, reminders, sent, updated) VALUES (?, ?, ?, ?, ?, ?)',
        id, JSON.stringify({ endpoint: b.subscription.endpoint, keys: b.subscription.keys }), String(b.tz || 'America/New_York').slice(0, 64), JSON.stringify(reminders), prev ? prev.sent : '{}', Date.now());
      const count = this.sql.exec('SELECT COUNT(*) AS n FROM subs').toArray()[0].n;
      return Response.json({ ok: true, reminders: reminders.length, devices: count });
    }
    if (url.pathname === '/remove') {
      const b = await req.json();
      this.sql.exec('DELETE FROM subs WHERE id = ?', await idFor(b.endpoint));
      return Response.json({ ok: true });
    }
    if (url.pathname === '/test') {
      const b = await req.json();
      const id = await idFor(b.endpoint);
      const row = this.sql.exec('SELECT sub FROM subs WHERE id = ?', id).toArray()[0];
      if (!row) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
      const r = await sendPush(JSON.parse(row.sub), { title: 'Reminders are on', body: 'You’ll get a heads-up 7 days before each item you’ve belled, and again on the day.', tag: 'test' }, await this.vapid(), this.env.CONTACT || 'mailto:noreply@example.com');
      return Response.json({ ok: r.ok, status: r.status });
    }
    if (url.pathname === '/run') return Response.json(await this.run(url.searchParams.get('now')));
    return new Response('Not found', { status: 404 });
  }
  async run(nowParam) {
    const now = nowParam ? new Date(nowParam) : new Date();
    const vapid = await this.vapid(), subject = this.env.CONTACT || 'mailto:noreply@example.com';
    let sent = 0, gone = 0, failed = 0;
    const rows = this.sql.exec('SELECT id, sub, tz, reminders, sent, updated FROM subs').toArray();
    for (const row of rows) {
      if (Date.now() - row.updated > SUB_TTL_DAYS * 864e5) { this.sql.exec('DELETE FROM subs WHERE id = ?', row.id); continue; }
      const { date, hour } = localParts(row.tz, now);
      if (hour < SEND_HOUR) continue;
      const reminders = JSON.parse(row.reminders), done = JSON.parse(row.sent), due = [];
      for (const r of reminders) {
        for (const [kind, when] of [['week', addDays(r.date, -7)], ['day', r.date]]) {
          const key = r.id + '|' + r.date + '|' + kind;
          if (when === date && !done[key]) due.push({ r, kind, key });
        }
      }
      if (!due.length) continue;
      const sub = JSON.parse(row.sub);
      const today = due.filter((x) => x.kind === 'day'), week = due.filter((x) => x.kind === 'week');
      const payload = due.length === 1
        ? { title: (due[0].kind === 'day' ? 'Due today: ' : 'Due in 7 days: ') + due[0].r.title, body: due[0].kind === 'day' ? 'Open your planner to check it off.' : 'Due ' + fmtDate(due[0].r.date) + '. Open your planner for details.', tag: due[0].key }
        : { title: (today.length ? today.length + ' due today' : '') + (today.length && week.length ? ', ' : '') + (week.length ? week.length + ' due in 7 days' : ''), body: due.map((x) => (x.kind === 'day' ? 'Today: ' : fmtDate(x.r.date) + ': ') + x.r.title).join('\n').slice(0, 900), tag: 'batch-' + date };
      let res;
      try { res = await sendPush(sub, payload, vapid, subject); } catch (e) { failed++; continue; }
      if (res.status === 404 || res.status === 410) { this.sql.exec('DELETE FROM subs WHERE id = ?', row.id); gone++; continue; }
      if (!res.ok) { failed++; continue; }
      for (const x of due) done[x.key] = date;
      for (const k of Object.keys(done)) if (done[k] < addDays(date, -400)) delete done[k];
      this.sql.exec('UPDATE subs SET sent = ? WHERE id = ?', JSON.stringify(done), row.id);
      sent++;
    }
    return { checked: rows.length, sent, gone, failed };
  }
}

// ---------- public API ----------
function cors(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = !allowed.length || allowed.includes(origin);
  return { 'Access-Control-Allow-Origin': ok ? origin || '*' : allowed[0], 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
}
const store = (env) => env.STORE.get(env.STORE.idFromName('main'));

export default {
  async fetch(req, env) {
    const url = new URL(req.url), h = cors(req.headers.get('Origin') || '', env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...h, 'Content-Type': 'application/json' } });
    try {
      if (req.method === 'GET' && url.pathname === '/') return reply({ ok: true, service: 'navy-separation-planner-reminders' });
      if (req.method === 'GET' && url.pathname === '/key') return reply(await (await store(env).fetch('https://do/key')).json());
      if (req.method === 'GET' && url.pathname === '/run' && env.ALLOW_MANUAL_RUN === 'yes') {
        return reply(await (await store(env).fetch('https://do/run' + (url.searchParams.get('now') ? '?now=' + encodeURIComponent(url.searchParams.get('now')) : ''))).json());
      }
      if (req.method !== 'POST') return reply({ error: 'not_found' }, 404);
      const len = Number(req.headers.get('Content-Length') || 0);
      if (len > MAX_BODY) return reply({ error: 'too_large' }, 413);
      const text = await req.text();
      if (text.length > MAX_BODY) return reply({ error: 'too_large' }, 413);
      let b; try { b = JSON.parse(text); } catch (e) { return reply({ error: 'bad_json' }, 400); }
      if (url.pathname === '/subscribe') {
        if (!b || !b.subscription || !b.subscription.keys || !validSub(b.subscription, env)) return reply({ error: 'bad_subscription' }, 400);
        const r = await store(env).fetch('https://do/save', { method: 'POST', body: JSON.stringify(b) });
        const out = await r.json(); return reply({ ok: out.ok, reminders: out.reminders });
      }
      if (url.pathname === '/unsubscribe') {
        if (!b || typeof b.endpoint !== 'string') return reply({ error: 'bad_request' }, 400);
        return reply(await (await store(env).fetch('https://do/remove', { method: 'POST', body: JSON.stringify({ endpoint: b.endpoint }) })).json());
      }
      if (url.pathname === '/test') {
        if (!b || typeof b.endpoint !== 'string') return reply({ error: 'bad_request' }, 400);
        const r = await store(env).fetch('https://do/test', { method: 'POST', body: JSON.stringify({ endpoint: b.endpoint }) });
        return reply(await r.json(), r.status);
      }
      return reply({ error: 'not_found' }, 404);
    } catch (e) {
      return reply({ error: 'server_error' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(store(env).fetch('https://do/run'));
  }
};
