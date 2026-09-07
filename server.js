'use strict';
/**
 * CityLens AI server v2 — zero-dependency Node HTTP.
 * Transport concerns only: routing, auth, RBAC gate, body parsing, SSE,
 * static + evidence file streaming. All behaviour lives in src/.
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
require('./src/env');

const db = require('./src/db');
const auth = require('./src/auth');
const { seed } = require('./src/seed');
const cv = require('./src/cv');
const coverage = require('./src/coverage');
const realtime = require('./src/realtime');
const ai = require('./src/ai');
const storage = require('./src/storage');
const { ROUTES } = require('./src/api');

const PORT = process.env.PORT || 4000;
const PUB = path.join(__dirname, 'public');
const DATA = db.DATA_DIR;
const JSON_LIMIT = 2 * 1024 * 1024;
const RAW_LIMIT = 122 * 1024 * 1024;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.webm': 'video/webm' };

/* ---------- helpers ---------- */
function send(res, code, body, headers = {}) {
  const h = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin', 'Cross-Origin-Opener-Policy': 'same-origin', ...headers };
  res.writeHead(code, h); res.end(body);
}
function sendJson(res, code, obj, headers = {}) { send(res, code, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8', ...headers }); }
const safeSeg = s => typeof s === 'string' && !!s && !s.includes('/') && !s.includes('\\') && !s.includes('..');

function matchRoute(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const rp = r.pattern.split('/').filter(Boolean);
    const pp = pathname.split('/').filter(Boolean);
    if (rp.length !== pp.length) continue;
    const params = {}; let ok = true;
    for (let i = 0; i < rp.length; i++) {
      if (rp[i].startsWith(':')) params[rp[i].slice(1)] = decodeURIComponent(pp[i]);
      else if (rp[i] !== pp[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('payload too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function userFrom(req) {
  let token = parseCookies(req).citylens_session || null;
  const h = req.headers.authorization;
  if (!token && h && h.startsWith('Bearer ')) token = h.slice(7); // device/API compatibility
  if (!token) return null;
  const payload = auth.verify(token);
  if (!payload) return null;
  const user = db.get('users', payload.sub) || null;
  if (!user) return null;
  if ((payload.sv || 1) !== (user.sessionVersion || 1)) return null;
  return user;
}

/* Durable brute-force / registration throttles based on the persisted audit trail. */
function auditWindowLimited(action, ip, windowMs, max) {
  if (!ip) return false;
  const cutoff = Date.now() - windowMs;
  return db.count('audit_logs', a => a.action === action && a.ip === ip && +new Date(a.timestamp || a.ts || 0) >= cutoff) >= max;
}
const loginLimited = ip => auditWindowLimited('LOGIN_FAILED', ip, 60 * 1000, 8);          // 8 failed / min
const registerLimited = ip => auditWindowLimited('REGISTER_ATTEMPT', ip, 10 * 60 * 1000, 5); // 5 / 10 min

function crossOriginCookieWrite(req) {
  if (!['POST','PATCH','PUT','DELETE'].includes(req.method)) return false;
  if (!parseCookies(req).citylens_session) return false; // bearer/device and public auth flows are unaffected
  const origin = req.headers.origin;
  if (!origin) return false; // non-browser clients
  try {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return new URL(origin).host !== host;
  } catch { return true; }
}

function streamFile(req, res, filePath, disposition) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'File not found' });
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const range = req.headers.range;
    const base = { 'content-type': type, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
    if (disposition) base['content-disposition'] = disposition;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1]) : 0;
      let end = m && m[2] ? parseInt(m[2]) : st.size - 1;
      if (isNaN(start) || isNaN(end) || start > end || end >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...base, 'content-length': st.size });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

/* ---------- server ---------- */
async function handleRequestCore(req, res) {
  let rollbackPoint = null;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();

  try {
    /* --- SSE --- */
    if (p === '/api/stream' && req.method === 'GET') {
      await db.refresh();
      const user = userFrom(req);
      if (!user) return sendJson(res, 401, { error: 'Authentication required' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      return realtime.addClient(res);
    }

    /* --- protected private Vercel Blob redirect (5-minute signed URL) --- */
    if (p === '/api/blob' && req.method === 'GET') {
      await db.refresh();
      const user = userFrom(req);
      if (!user) return sendJson(res, 401, { error: 'Authentication required' });
      const key = url.searchParams.get('key') || '';
      if (!key.startsWith('citylens/') || key.includes('..')) return sendJson(res, 400, { error: 'Bad blob key' });
      try {
        const target = await storage.signedGetUrl(key);
        res.writeHead(302, { location: target, 'cache-control': 'private, max-age=240', 'X-Content-Type-Options': 'nosniff' });
        return res.end();
      } catch (err) { return sendJson(res, 503, { error: 'Private object storage unavailable' }); }
    }

    /* --- protected local-development object storage --- */
    if (p === '/api/object' && req.method === 'GET') {
      await db.refresh();
      const user = userFrom(req);
      if (!user) return sendJson(res, 401, { error: 'Authentication required' });
      const key = url.searchParams.get('key') || '';
      const root = path.join(DATA, 'objects');
      const fp = path.normalize(path.join(root, key));
      if (!(fp === root || fp.startsWith(root + path.sep))) return sendJson(res, 400, { error: 'Bad object key' });
      return streamFile(req, res, fp);
    }

    /* --- protected file streams (evidence / repairs / uploads) --- */
    const fileRoute = p.match(/^\/api\/(evidence|repairs|uploads)\/([^/]+)(?:\/([^/]+))?$/);
    if (fileRoute && req.method === 'GET') {
      await db.refresh();
      const user = userFrom(req);
      if (!user) return sendJson(res, 401, { error: 'Authentication required' });
      const [, kind, a, b] = fileRoute;
      if (!safeSeg(a) || (b !== undefined && !safeSeg(b))) return sendJson(res, 400, { error: 'Bad path' });
      let fp = null;
      if (kind === 'evidence' && b) fp = path.join(ai.EVIDENCE_DIR, a, b);
      if (kind === 'repairs' && b) fp = path.join(DATA, 'repairs', a, b);
      if (kind === 'uploads' && !b) fp = path.join(ai.UPLOAD_DIR, a);
      if (!fp) return sendJson(res, 400, { error: 'Bad path' });
      return streamFile(req, res, fp);
    }

    /* --- API routes --- */
    if (p.startsWith('/api/')) {
      await db.refresh();
      if (crossOriginCookieWrite(req)) return sendJson(res, 403, { error: 'Cross-origin state-changing request blocked' });
      const m = matchRoute(req.method, p);
      if (!m) return sendJson(res, 404, { error: `No such endpoint: ${req.method} ${p}` });
      const { route, params } = m;

      let user = null;
      if (!route.public) {
        user = userFrom(req);
        if (!user) return sendJson(res, 401, { error: 'Authentication required' });
        if (route.perm && !auth.can(user.role, route.perm)) {
          return sendJson(res, 403, { error: `Your role (${auth.ROLES[user.role].label}) lacks permission '${route.perm}'` });
        }
      }
      if (p === '/api/auth/login' && loginLimited(ip)) return sendJson(res, 429, { error: 'Too many login attempts — wait a minute.' });
      if (p === '/api/auth/register' && registerLimited(ip)) return sendJson(res, 429, { error: 'Too many registration attempts — please try again in a few minutes.' });

      let body = null, raw = null;
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
        const ct = (req.headers['content-type'] || '').split(';')[0].trim();
        if (route.raw && ct !== 'application/json') {
          raw = await readBody(req, RAW_LIMIT);
        } else {
          const buf = await readBody(req, JSON_LIMIT);
          if (buf.length) { try { body = JSON.parse(buf.toString('utf8')); } catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); } }
        }
      }

      const ctx = { req, res, user, params, query: Object.fromEntries(url.searchParams), body, raw, ip };
      if (['POST','PATCH','PUT','DELETE'].includes(req.method)) rollbackPoint = db.checkpoint();
      const out = await route.handler(ctx);
      await db.commit();
      rollbackPoint = null;
      if (!out) return; // handler streamed its own response
      if (out.body !== undefined) return send(res, out.code, out.body, out.headers || {});
      return sendJson(res, out.code, out.json, out.headers || {});
    }

    /* --- static --- */
    let file = p === '/' ? '/index.html' : p;
    if (file === '/app' || file.startsWith('/app/')) file = '/app.html';
    if (file === '/edge' || file.startsWith('/edge/')) file = '/edge.html';
    const fp = path.normalize(path.join(PUB, file));
    if (!(fp === PUB || fp.startsWith(PUB + path.sep))) return send(res, 403, 'Forbidden');
    fs.readFile(fp, (err, buf) => {
      if (err) return send(res, 404, 'Not found');
      send(res, 200, buf, { 'content-type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
    });
  } catch (err) {
    if (rollbackPoint) db.rollback(rollbackPoint);
    const concurrent = err && (err.code === '40001' || /concurrent update detected/i.test(err.message || ''));
    const code = /payload too large/.test(err.message || '') ? 413 : (concurrent ? 409 : 500);
    console.error('[server]', req.method, p, err.message);
    sendJson(res, code, { error: code === 413 ? 'Payload too large' : (concurrent ? 'Concurrent update detected — refresh and retry.' : 'Internal server error') });
  }
}

function handleRequest(req, res) {
  return db.runRequest(() => handleRequestCore(req, res));
}

const server = http.createServer(handleRequest);

/* ---------- boot ---------- */
async function boot() {
  auth.assertConfigured();
  await db.init();
  seed();
  await db.commit();
  const cap = cv.syncModelRegistry();
  coverage.ensureSegments();
  await db.commit();
  // Long-running timers/SSE are useful locally. Vercel serverless falls back to
  // request-driven refresh/polling and does not depend on process lifetime.
  if (!process.env.VERCEL) realtime.start();
  server.listen(PORT, () => {
    const n = c => db.count(c, () => true);
    console.log(`
  ┌─────────────────────────────────────────────────────────────┐
  │  CityLens AI v3 — SIH production build                      │
  │  http://localhost:${PORT}   (app: /app · edge client: /edge)   │
  ├─────────────────────────────────────────────────────────────┤
  │  database: ${db.status().backend.padEnd(34)}│
  │  CV engine: ${cap.classical.available ? 'OpenCV ready (classical-cv-v1)     ' : 'UNAVAILABLE — analysis will fail  '}          │
  │  YOLO adapter: ${cap.yolo.configured ? 'configured                     ' : 'Not Configured (YOLO_SERVICE_URL)'}         │
  │  data: users ${n('users')} · routes ${n('routes')} · buses ${n('buses')} · devices ${n('devices')}            │
  └─────────────────────────────────────────────────────────────┘`);
  });
}
if (require.main === module) boot().catch(err => { console.error('[boot]', err); process.exit(1); });
module.exports = { server, boot, handleRequest };
process.on('SIGINT', () => { db.flushNow(); process.exit(0); });
process.on('SIGTERM', () => { db.flushNow(); process.exit(0); });
