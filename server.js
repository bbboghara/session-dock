// Session Dock: a web app for starting, resuming, restarting and closing Claude
// Code sessions in real terminal windows on this machine's Linux desktop.
// Plain Node (no dependencies). Listens on localhost only; put a private HTTPS
// proxy in front of it (for example Tailscale Serve) to use it from a phone.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as cfg from './lib/config.js';
import { AuthStore } from './lib/auth.js';
import { HttpError } from './lib/util.js';
import * as folders from './lib/folders.js';
import * as tx from './lib/transcripts.js';
import * as actions from './lib/actions.js';
import { installedVersion } from './lib/active.js';
import { isTrusted } from './lib/trust.js';
import { createChangelog, recentChanges } from './lib/changelog.js';

const COOKIE = 'sd_session';
const auth = new AuthStore(cfg.AUTH_FILE, { firstPinFile: cfg.FIRST_PIN_FILE });
const log = (...a) => console.log(new Date().toISOString(), ...a);
const changelog = createChangelog({ localFile: cfg.CLAUDE_CHANGELOG, log });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
    "manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function send(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(data);
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* some other app's cookie on this host, not meant for us */
    }
  }
  return out;
}

const sessionCookie = (token, maxAge) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

async function readJson(req) {
  if (!(req.headers['content-type'] || '').includes('application/json')) {
    throw new HttpError(415, 'Expected JSON.');
  }
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 16 * 1024) throw new HttpError(413, 'Request too large.');
    chunks.push(c);
  }
  try {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    /* falls through */
  }
  throw new HttpError(400, 'Invalid JSON.');
}

/** Blocks cross-site POSTs: if the browser says where the request came from, it must be this site. */
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'Bad origin.');
  }
  if (host !== req.headers.host) throw new HttpError(403, 'Cross-site request blocked.');
}

const inRoot = (p) => folders.isInside(cfg.ROOT, p);
const protectedFolders = [cfg.ROOT, cfg.DEFAULT_DIR, cfg.APP_DIR];

function desktopStatus() {
  const d = actions.desktop();
  if (!d.ok) return { ok: false, reason: d.reason };
  const t = actions.terminal(d);
  // A desktop without a usable terminal can't open windows, so it counts as off.
  if (t.error) return { ok: false, reason: t.error, display: d.display, desktop: d.desktop };
  return { ok: true, display: d.display, desktop: d.desktop, terminal: t.name };
}

/** How many saved Claude sessions belong to this folder or folders inside it. */
async function historyInside(dir) {
  const enc = tx.encodeProjectDir(dir);
  let names = [];
  try {
    names = await fsp.readdir(cfg.PROJECTS_DIR);
  } catch {
    return 0;
  }
  let n = 0;
  for (const d of names) {
    if (d !== enc && !d.startsWith(`${enc}-`)) continue;
    const files = (await fsp.readdir(path.join(cfg.PROJECTS_DIR, d))).filter((f) => f.endsWith('.jsonl'));
    if (!files.length) continue;
    if (d !== enc) {
      // Name prefix matches can be a sibling ("app" vs "app-old"); check a real cwd.
      const s = await tx.summarizeTranscript(path.join(cfg.PROJECTS_DIR, d, files[0])).catch(() => null);
      if (!s || !s.cwd || !folders.isInside(dir, s.cwd)) continue;
    }
    n += files.length;
  }
  return n;
}

const api = {
  'GET /api/health': async () => ({ ok: true }),

  'POST /api/login': async (req, res) => {
    const { pin } = await readJson(req);
    const r = auth.login(String(pin ?? ''), req.headers['user-agent']);
    if (!r.ok) {
      if (r.lockedMs) throw new HttpError(429, `Too many wrong PINs. Try again in ${Math.ceil(r.lockedMs / 1000)} seconds.`, r);
      throw new HttpError(401, 'Wrong PIN.', r);
    }
    log('login ok');
    res.setHeader('Set-Cookie', sessionCookie(r.token, 31536000));
    return { ok: true };
  },

  'POST /api/logout': async (req, res, ctx) => {
    auth.logout(ctx.token);
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    return { ok: true };
  },

  'POST /api/pin': async (req, res, ctx) => {
    const { oldPin, newPin } = await readJson(req);
    const r = auth.changePin(ctx.token, String(oldPin ?? ''), String(newPin ?? ''));
    if (!r.ok) throw new HttpError(r.lockedMs ? 429 : 400, r.error);
    log('PIN changed');
    return { ok: true };
  },

  'GET /api/me': async () => ({
    pinIsDefault: auth.pinIsDefault,
    installedVersion: installedVersion(cfg.CLAUDE_BIN),
    desktop: desktopStatus(),
    root: cfg.ROOT,
    home: cfg.HOME,
    defaultDir: cfg.DEFAULT_DIR,
  }),

  'GET /api/folders': async (req, res, ctx) => {
    const dir = await folders.resolveDir(cfg.ROOT, ctx.query.get('path') || cfg.DEFAULT_DIR);
    const showHidden = ctx.query.get('hidden') === '1';
    const trusted = isTrusted(cfg.CLAUDE_JSON, dir);
    const [subs, counts] = await Promise.all([folders.listSubfolders(dir, { showHidden }), tx.sessionCounts(cfg.PROJECTS_DIR)]);
    const running = actions.active().sessions;
    const runningIn = (p) => running.filter((s) => s.cwd && folders.isInside(p, s.cwd)).length;
    // Folders whose names differ only in punctuation share one Claude project
    // dir; for those, count by each transcript's real folder instead.
    const exact = new Map();
    const byEnc = new Map();
    for (const f of subs) {
      const e = tx.encodeProjectDir(f.path);
      byEnc.set(e, (byEnc.get(e) || 0) + 1);
    }
    for (const [e, n] of byEnc) {
      if (n > 1 && counts.has(e)) for (const [cwd, c] of await tx.countsByCwd(cfg.PROJECTS_DIR, e)) exact.set(cwd, c);
    }
    const savedFor = (p) => {
      const e = tx.encodeProjectDir(p);
      return byEnc.get(e) > 1 ? exact.get(p) || 0 : counts.get(e) || 0;
    };
    return {
      path: dir,
      parent: dir === cfg.ROOT ? null : path.dirname(dir),
      crumbs: folders.breadcrumbs(cfg.ROOT, dir),
      here: {
        saved: counts.has(tx.encodeProjectDir(dir))
          ? (await tx.countsByCwd(cfg.PROJECTS_DIR, tx.encodeProjectDir(dir))).get(dir) || 0
          : 0,
        running: running.filter((s) => s.cwd === dir).length,
        trusted,
        cannotTrust: !trusted && dir === cfg.HOME,
      },
      folders: subs.map((f) => ({
        ...f,
        saved: savedFor(f.path),
        running: runningIn(f.path),
      })),
    };
  },

  'POST /api/folders/create': async (req) => {
    const { parent, name } = await readJson(req);
    const dir = await folders.resolveDir(cfg.ROOT, parent);
    const created = await folders.createFolder(dir, name);
    log(`created folder ${created}`);
    return { ok: true, path: created };
  },

  'POST /api/folders/rename': async (req) => {
    const { path: p, name, confirm } = await readJson(req);
    const link = await folders.linkPath(cfg.ROOT, p);
    if (link) {
      const dest = await folders.renameFolder(link, name);
      log(`renamed link ${link} -> ${dest}`);
      return { ok: true, path: dest };
    }
    const src = await folders.resolveDir(cfg.ROOT, p);
    folders.validateName(name);
    const running = actions.active().sessions.filter((s) => s.cwd && folders.isInside(src, s.cwd));
    if (running.length) {
      throw new HttpError(409, `Claude is running in this folder (${running.map((s) => s.name).join(', ')}). Close it first.`);
    }
    const history = await historyInside(src);
    if (history && !confirm) {
      throw new HttpError(409, `This folder has ${history} saved Claude session${history > 1 ? 's' : ''}. ` +
        'After renaming they will no longer appear for this folder, and cannot be resumed from the new name.',
      { needsConfirm: true, sessions: history });
    }
    const dest = await folders.renameFolder(src, name, { protectedPaths: protectedFolders });
    log(`renamed ${src} -> ${dest}`);
    return { ok: true, path: dest };
  },

  'GET /api/sessions': async (req, res, ctx) => {
    const dir = await folders.resolveDir(cfg.ROOT, ctx.query.get('path'));
    const lists = await tx.folderSessions(cfg.PROJECTS_DIR, dir);
    const live = new Map(actions.active().sessions.map((s) => [s.sessionId, { pid: s.pid, status: s.status }]));
    const mark = (s) => ({ ...s, running: live.get(s.id) || null });
    return { path: dir, trusted: isTrusted(cfg.CLAUDE_JSON, dir), main: lists.main.map(mark), other: lists.other.map(mark) };
  },

  'GET /api/recent': async () => {
    const items = await tx.recentFolders(cfg.PROJECTS_DIR, { isAllowed: inRoot, limit: 8 });
    const running = actions.active().sessions;
    return { items: items.map((i) => ({ ...i, running: running.filter((s) => s.cwd === i.path).length })) };
  },

  'GET /api/active': async () => ({ ...actions.overview(), desktop: desktopStatus(), now: Date.now() }),

  'GET /api/changelog': async () => {
    const { installedVersion: installed, sessions } = actions.active();
    const { versions, behind } = await changelog.load(installed);
    return { installedVersion: installed, behind, changes: recentChanges(versions, sessions.map((s) => s.version), installed) };
  },

  'POST /api/launch': async (req) => {
    const b = await readJson(req);
    const folder = await folders.resolveDir(cfg.ROOT, b.path);
    return actions.launch({ folder, mode: b.mode, sessionId: b.sessionId, name: b.name, trust: b.trust === true });
  },

  'POST /api/restart': async (req) => {
    const b = await readJson(req);
    return actions.restart({ pid: Number(b.pid), sessionId: b.sessionId, confirmUnknown: b.confirmUnknown === true, trust: b.trust === true });
  },

  'POST /api/retry': async (req) => {
    const b = await readJson(req);
    // The folder is only needed if the session has to be reopened in a new window.
    const folder = typeof b.path === 'string' ? await folders.resolveDir(cfg.ROOT, b.path).catch(() => null) : null;
    return actions.retry({ sessionId: b.sessionId, pid: Number(b.pid) || null, folder, trust: b.trust === true });
  },

  'POST /api/close': async (req) => {
    const b = await readJson(req);
    return actions.close({ pid: Number(b.pid), sessionId: b.sessionId, force: b.force === true });
  },

  'POST /api/restart-outdated': async () => actions.restartOutdated(),
};

const PUBLIC_ROUTES = new Set(['GET /api/health', 'POST /api/login']);
// All that works while the temporary first-run PIN is still in use.
const BEFORE_OWN_PIN = new Set(['GET /api/me', 'POST /api/pin', 'POST /api/logout']);

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(cfg.PUBLIC_DIR, rel);
  if (!file.startsWith(cfg.PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Not found' });
  let data;
  try {
    data = await fsp.readFile(file);
  } catch {
    return send(res, 404, { error: 'Not found' });
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ...SECURITY_HEADERS,
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://local');
  } catch {
    return send(res, 400, { error: 'Bad request.' }); // a path like "//" must not take the server down
  }
  const key = `${req.method} ${url.pathname}`;
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      return await serveStatic(req, res, url.pathname);
    }
    const handler = api[key];
    if (!handler) throw new HttpError(404, 'Not found.');
    if (req.method === 'POST') checkOrigin(req);
    const token = cookies(req)[COOKIE];
    if (!PUBLIC_ROUTES.has(key)) {
      if (!auth.validate(token)) throw new HttpError(401, 'Please enter your PIN.', { login: true });
      if (auth.pinIsDefault && !BEFORE_OWN_PIN.has(key)) throw new HttpError(403, 'Set your own PIN first.', { mustSetPin: true });
    }
    const body = await handler(req, res, { token, query: url.searchParams });
    send(res, 200, body);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...e.extra });
    log(`ERROR ${key}:`, e && e.stack ? e.stack : e);
    send(res, 500, { error: 'Something went wrong on the server.' });
  }
});

server.requestTimeout = 180_000;
fs.mkdirSync(cfg.WINDOWS_DIR, { recursive: true });
server.listen(cfg.PORT, cfg.HOST, () => {
  const { address, port } = server.address();
  log(`Session Dock listening on http://${address}:${port}`);
  if (auth.pinIsDefault && fs.existsSync(cfg.FIRST_PIN_FILE)) log(`First-run PIN is in ${cfg.FIRST_PIN_FILE}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`${sig}: shutting down (desktop windows keep running)`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
