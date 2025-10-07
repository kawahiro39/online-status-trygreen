const express = require('express');

const ACTIVE_MS = 30_000;
const CLOSE_MS = 180_000;
const GC_INTERVAL_MS = 10_000;
const TOMBSTONE_MS = 60_000;
const PORT = Number.parseInt(process.env.PORT, 10) || 8080;

const SESS = new Map();
const TOMBSTONES = new Map();

function ensureBodyObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return false;
  }
  return true;
}

function normalizeString(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}

function normUid(uid) {
  const trimmed = normalizeString(uid).trim();
  return trimmed ? trimmed : 'logout user';
}

function normPath(path) {
  const trimmedValue = normalizeString(path).trim();
  const value = trimmedValue || '/';
  const prefix = value.startsWith('/') ? '' : '/';
  const url = new URL(`http://x${prefix}${value}`);
  const trimmedPath = url.pathname.replace(/^\/+/u, '').replace(/\/+$/u, '');
  const normalizedPath = trimmedPath ? `/${trimmedPath}` : '/';
  return `${normalizedPath}${url.search}`.toLowerCase();
}

function normClientId(clientId) {
  const value = normalizeString(clientId).trim();
  return value ? value : '';
}

function touchSession({ uid, path, clientId }, nowMs = Date.now()) {
  const normalizedClientId = normClientId(clientId);
  if (!normalizedClientId) {
    return { ok: false, error: 'invalid_clientId' };
  }

  const tombstoneExpires = TOMBSTONES.get(normalizedClientId);
  if (tombstoneExpires !== undefined) {
    if (tombstoneExpires > nowMs) {
      return { ok: true, ignored: 'tombstoned' };
    }
    TOMBSTONES.delete(normalizedClientId);
  }

  const normalizedUid = normUid(uid);
  const normalizedPath = normPath(path);
  let session = SESS.get(normalizedClientId);
  if (!session) {
    session = {
      uid: normalizedUid,
      lastActivityMs: nowMs,
      currentPath: normalizedPath,
    };
    SESS.set(normalizedClientId, session);
  } else {
    session.uid = normalizedUid;
    session.lastActivityMs = nowMs;
    session.currentPath = normalizedPath;
  }

  return { ok: true };
}

function removeSession({ clientId }, nowMs = Date.now()) {
  const normalizedClientId = normClientId(clientId);
  if (!normalizedClientId) {
    return false;
  }
  const deleted = SESS.delete(normalizedClientId);
  TOMBSTONES.set(normalizedClientId, nowMs + TOMBSTONE_MS);
  return deleted;
}

function sweepExpiredSessions(nowMs = Date.now()) {
  for (const [clientId, session] of SESS.entries()) {
    if (nowMs - session.lastActivityMs >= CLOSE_MS) {
      SESS.delete(clientId);
    }
  }
  for (const [clientId, expiresMs] of TOMBSTONES.entries()) {
    if (expiresMs <= nowMs) {
      TOMBSTONES.delete(clientId);
    }
  }
}

function summarizeSessions(nowMs = Date.now()) {
  const tracker = new Map();

  for (const session of SESS.values()) {
    if (nowMs - session.lastActivityMs >= CLOSE_MS) {
      continue;
    }

    const uid = normUid(session.uid);
    let entry = tracker.get(uid);
    if (!entry) {
      entry = { latest: 0, paths: new Set() };
      tracker.set(uid, entry);
    }

    if (session.lastActivityMs > entry.latest) {
      entry.latest = session.lastActivityMs;
    }

    if (session.currentPath) {
      entry.paths.add(normPath(session.currentPath));
    }
  }

  const active = [];
  const idle = [];

  for (const [uid, entry] of tracker.entries()) {
    const elapsed = nowMs - entry.latest;
    const paths = Array.from(entry.paths).sort();
    const item = { uid, paths };

    if (elapsed < ACTIVE_MS) {
      active.push(item);
    } else {
      idle.push(item);
    }
  }

  const sortByUid = (a, b) => a.uid.localeCompare(b.uid);
  active.sort(sortByUid);
  idle.sort(sortByUid);

  return { active, idle };
}

const ALLOW_ORIGINS = new Set([
  'https://solar-nova.online',
  // Add additional production domains as needed.
]);

const app = express();

app.use(express.json());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOW_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  return next();
});

app.post('/presence/ping', (req, res) => {
  if (!ensureBodyObject(req.body)) {
    return res.status(400).json({ ok: false, error: 'invalid_body' });
  }
  const result = touchSession(req.body);
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error });
  }
  return res.json(result);
});

app.post('/presence/hit', (req, res) => {
  if (!ensureBodyObject(req.body)) {
    return res.status(400).json({ ok: false, error: 'invalid_body' });
  }
  const result = touchSession(req.body);
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error });
  }
  return res.json(result);
});

app.post('/presence/leave', (req, res) => {
  if (!ensureBodyObject(req.body)) {
    return res.status(400).json({ ok: false, error: 'invalid_body' });
  }

  const deleted = removeSession(req.body);
  const normalizedPath =
    req.body.path === undefined ? undefined : normPath(req.body.path);
  // eslint-disable-next-line no-console
  console.log('presence_leave', {
    uid: normUid(req.body.uid),
    clientId: normClientId(req.body.clientId),
    path: normalizedPath,
    deleted,
  });
  return res.json({ ok: true, deleted: deleted ? 1 : 0 });
});

app.get('/presence/summary', (_req, res) => {
  const { active, idle } = summarizeSessions(Date.now());
  return res.json({ ok: true, active, idle });
});

if (process.env.NODE_ENV !== 'production') {
  app.get('/presence/debug/sessions', (_req, res) => {
    const sessionsDebug = Array.from(SESS.entries()).map(([clientId, session]) => ({
      clientId,
      uid: session.uid,
      lastActivityMs: session.lastActivityMs,
      currentPath: session.currentPath,
    }));
    res.json({ size: SESS.size, sessions: sessionsDebug });
  });
}

app.get('/healthz', (_req, res) => {
  sweepExpiredSessions(Date.now());
  res.json({ ok: true, sessions: SESS.size });
});

let server = null;

function startServer() {
  if (!server) {
    server = app.listen(PORT, '0.0.0.0', () => {
      // eslint-disable-next-line no-console
      console.log(`Presence API listening on port ${PORT}`);
    });
  }
  return server;
}

const gcTimer = setInterval(() => {
  sweepExpiredSessions(Date.now());
}, GC_INTERVAL_MS);

gcTimer.unref?.();

function shutdown() {
  clearInterval(gcTimer);
  if (server) {
    server.close(() => {
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
  get server() {
    return server;
  },
  sessions: SESS,
  tombstones: TOMBSTONES,
  constants: {
    ACTIVE_MS,
    CLOSE_MS,
    GC_INTERVAL_MS,
    TOMBSTONE_MS,
  },
  helpers: {
    normUid,
    normPath,
    normClientId,
    touchSession,
    removeSession,
    sweepExpiredSessions,
    summarizeSessions,
  },
};
