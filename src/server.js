const express = require('express');

const ACTIVE_MS = 30_000;
const CLOSE_MS = 180_000;
const GC_INTERVAL_MS = 10_000;
const PORT = Number.parseInt(process.env.PORT, 10) || 8080;

const SESS = new Map();

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
  const value = normalizeString(path).trim().toLowerCase();
  if (!value) {
    return '/';
  }

  let normalized = value.startsWith('/') ? value : `/${value}`;

  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/u, '');
    if (!normalized.startsWith('/')) {
      normalized = `/${normalized}`;
    }
    if (!normalized) {
      normalized = '/';
    }
  }

  return normalized || '/';
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

  const normalizedUid = normUid(uid);
  const normalizedPath = normPath(path);
  let session = SESS.get(normalizedClientId);
  if (!session) {
    session = {
      uid: normalizedUid,
      lastActivityMs: nowMs,
      paths: new Set(),
    };
    SESS.set(normalizedClientId, session);
  }

  if (!(session.paths instanceof Set)) {
    session.paths = new Set();
  }

  if (session.uid !== normalizedUid) {
    session.paths.clear();
  }

  session.uid = normalizedUid;
  session.lastActivityMs = nowMs;
  session.paths.add(normalizedPath);

  return { ok: true };
}

function removeSession({ uid, path, clientId }) {
  const normalizedClientId = normClientId(clientId);
  if (!normalizedClientId) {
    return false;
  }

  const normalizedUid = normUid(uid);
  const session = SESS.get(normalizedClientId);
  if (!session || session.uid !== normalizedUid) {
    return false;
  }

  if (!(session.paths instanceof Set)) {
    return SESS.delete(normalizedClientId);
  }

  if (path === undefined) {
    return SESS.delete(normalizedClientId);
  }

  const normalizedPath = normPath(path);
  session.paths.delete(normalizedPath);

  if (session.paths.size === 0) {
    SESS.delete(normalizedClientId);
    return true;
  }

  return false;
}

function sweepExpiredSessions(nowMs = Date.now()) {
  for (const [clientId, session] of SESS.entries()) {
    if (nowMs - session.lastActivityMs >= CLOSE_MS) {
      SESS.delete(clientId);
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

    const sessionPaths =
      session.paths instanceof Set ? session.paths : session.path ? [session.path] : [];
    for (const p of sessionPaths) {
      entry.paths.add(normPath(p));
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
  'https://solar-system-82998.bubbleapps.io',
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
  return res.json({ ok: true });
});

app.post('/presence/hit', (req, res) => {
  if (!ensureBodyObject(req.body)) {
    return res.status(400).json({ ok: false, error: 'invalid_body' });
  }
  const result = touchSession(req.body);
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error });
  }
  return res.json({ ok: true });
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
      paths: Array.from(session.paths).sort(),
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
  constants: {
    ACTIVE_MS,
    CLOSE_MS,
    GC_INTERVAL_MS,
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
