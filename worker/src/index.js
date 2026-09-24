/**
 * Secret Santa mailbox API.
 *
 * Stores encrypted blobs and nothing else. It has no idea who anyone is, who is
 * buying for whom, or what any message says.
 *
 * Authorisation comes from the published roster: data/santa.json lists each
 * mailbox id alongside the SHA-256 of its secret. A caller proves they hold one
 * end of a mailbox by presenting the secret itself in `x-santa-auth`. Both the
 * mailbox owner and their Secret Santa hold it; nobody else does.
 */

const MAX_WISHLIST_CT = 32 * 1024;
const MAX_MESSAGE_CT = 8 * 1024;
const MAX_MESSAGES = 500;
const ROSTER_TTL_MS = 60 * 1000;

// Isolates are short-lived, so this is a best-effort cache, not a source of truth.
let rosterCache = { at: 0, mailboxes: null };

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const body = await route(request, env, ctx);
      return json(body, 200, cors);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code }, err.status, cors);
      return json({ error: 'server_error' }, 500, cors);
    }
  }
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts.length === 1 && parts[0] === 'health') {
    return { ok: true };
  }

  if (parts[0] !== 'm' || parts.length < 2) throw new HttpError(404, 'not_found');

  const mailboxId = parts[1];
  await authorise(request, env, mailboxId);

  const box = (await env.SANTA_KV.get(kvKey(mailboxId), 'json')) || { wishlist: null, messages: [] };

  // GET /m/:id
  if (parts.length === 2 && request.method === 'GET') {
    return box;
  }

  // PUT /m/:id/wishlist
  if (parts.length === 3 && parts[2] === 'wishlist' && request.method === 'PUT') {
    const ct = await readCiphertext(request, MAX_WISHLIST_CT);
    box.wishlist = { ct, ts: Date.now() };
    await env.SANTA_KV.put(kvKey(mailboxId), JSON.stringify(box));
    ctx.waitUntil(notify(env, mailboxId));
    return { ok: true };
  }

  // POST /m/:id/messages
  if (parts.length === 3 && parts[2] === 'messages' && request.method === 'POST') {
    const ct = await readCiphertext(request, MAX_MESSAGE_CT);
    if (box.messages.length >= MAX_MESSAGES) throw new HttpError(409, 'mailbox_full');
    box.messages.push({ id: crypto.randomUUID(), ts: Date.now(), ct });
    await env.SANTA_KV.put(kvKey(mailboxId), JSON.stringify(box));
    ctx.waitUntil(notify(env, mailboxId));
    return { ok: true };
  }

  throw new HttpError(405, 'method_not_allowed');
}

function kvKey(mailboxId) { return `mb:${mailboxId}`; }

/* ---- authorisation ----------------------------------------------------- */

async function authorise(request, env, mailboxId) {
  const secret = request.headers.get('x-santa-auth');
  if (!secret) throw new HttpError(401, 'missing_auth');

  const mailboxes = await loadRoster(env);
  const expected = mailboxes[mailboxId];
  if (!expected) throw new HttpError(404, 'not_found');

  const digest = await sha256Base64Url(secret);
  if (!timingSafeEqual(digest, expected)) throw new HttpError(403, 'bad_auth');
}

async function loadRoster(env) {
  const fresh = rosterCache.mailboxes && Date.now() - rosterCache.at < ROSTER_TTL_MS;
  if (fresh) return rosterCache.mailboxes;

  try {
    const res = await fetch(env.DATA_URL, { cf: { cacheTtl: 60, cacheEverything: true } });
    if (!res.ok) throw new Error('bad_status');
    const data = await res.json();
    rosterCache = { at: Date.now(), mailboxes: data.mailboxes || {} };
  } catch (err) {
    // A blip fetching the roster shouldn't take the mailboxes offline.
    if (!rosterCache.mailboxes) throw new HttpError(503, 'roster_unavailable');
  }
  return rosterCache.mailboxes;
}

async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let binary = '';
  const bytes = new Uint8Array(digest);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---- request helpers --------------------------------------------------- */

async function readCiphertext(request, limit) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    throw new HttpError(400, 'bad_json');
  }
  const ct = body && body.ct;
  if (typeof ct !== 'string' || ct.length === 0) throw new HttpError(400, 'missing_ct');
  if (ct.length > limit) throw new HttpError(413, 'too_large');
  if (!/^[A-Za-z0-9_-]+$/.test(ct)) throw new HttpError(400, 'bad_ct');
  return ct;
}

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const headers = {
    'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-santa-auth',
    'access-control-max-age': '86400',
    vary: 'Origin'
  };

  if (allowed.length === 0 || allowed.includes('*')) {
    headers['access-control-allow-origin'] = '*';
  } else if (allowed.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
  }
  return headers;
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...cors
    }
  });
}

/* ---- notifications ----------------------------------------------------- */

/**
 * Tells the organiser that *something* changed, and deliberately not what or
 * whose. Debounced per mailbox so a burst of edits is one nudge, not twenty.
 */
async function notify(env, mailboxId) {
  const quietMinutes = Number(env.NOTIFY_MIN_MINUTES ?? 360);
  const key = `notified:${mailboxId}`;

  try {
    // 0 means notify on every update, so skip the bookkeeping entirely rather
    // than reading and rewriting a timestamp that can never suppress anything.
    if (quietMinutes > 0) {
      const last = Number((await env.SANTA_KV.get(key)) || 0);
      if (Date.now() - last < quietMinutes * 60 * 1000) return;
      await env.SANTA_KV.put(key, String(Date.now()));
    }

    const ref = String(env.NOTIFY_INCLUDE_REF) === 'true' ? ` (ref ${mailboxId.slice(0, 4)})` : '';
    const text =
      `Someone has updated their Secret Santa wishlist or sent a message${ref}. ` +
      `Let everyone know to log in and check.`;

    if (env.NOTIFY_WEBHOOK_URL) {
      await fetch(env.NOTIFY_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text, text })
      });
    }

    if (env.RESEND_API_KEY && env.NOTIFY_EMAIL) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          from: env.NOTIFY_FROM || 'Secret Santa <onboarding@resend.dev>',
          to: [env.NOTIFY_EMAIL],
          subject: 'Secret Santa: there is an update',
          text
        })
      });
    }
  } catch (err) {
    // Notifications are a nicety; never let one fail a write.
  }
}
