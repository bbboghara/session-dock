// The things the web app can ask for: open a new Claude, resume one, restart one
// (same conversation, newest Claude), close one. Each action checks its safety
// rules before stopping anything.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as cfg from './config.js';
import { listActive, listPending, managedWindow } from './active.js';
import { claudeEnv, desktopTerminal, findDesktop, openWindow } from './desktop.js';
import { acceptTrust, isTrusted } from './trust.js';
import { findTranscript, summarizeTranscript } from './transcripts.js';
import { HttpError, procAlive, signal, waitFor } from './util.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const busyKeys = new Set(); // stops double taps from running the same action twice

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function exclusive(key, fn) {
  if (busyKeys.has(key)) throw new HttpError(409, 'That is already in progress.');
  busyKeys.add(key);
  try {
    return await fn();
  } finally {
    busyKeys.delete(key);
  }
}

/** The logged-in desktop, if any (see desktop.js). */
export function desktop() {
  const d = findDesktop(cfg.UID, { extraProcesses: cfg.DESKTOP_PROCESSES, xdgRuntimeDir: cfg.XDG_RUNTIME_DIR });
  return d.ok ? { ...d, env: claudeEnv(d.env, cfg.CLAUDE_BIN, process.env.CLAUDE_CONFIG_DIR) } : d;
}

/** The terminal program new windows will use on this desktop: { name, bin } or { error }. */
export const terminal = (d = desktop()) => (d.ok ? desktopTerminal(d, cfg.TERMINAL) : { error: d.reason });

export function active() {
  return listActive({ sessionsDir: cfg.SESSIONS_DIR, windowsDir: cfg.WINDOWS_DIR, claudeBin: cfg.CLAUDE_BIN });
}

const pending = (sessions = active().sessions) => listPending({ windowsDir: cfg.WINDOWS_DIR, sessions });

/** GET /api/active — running sessions, plus windows whose Claude has not started. */
export function overview() {
  const a = active();
  const needsTrust = (x) => !!x.cwd && x.cwd !== cfg.HOME && !isTrusted(cfg.CLAUDE_JSON, x.cwd);
  return {
    ...a,
    sessions: a.sessions.map((s) => ({ ...s, needsTrust: needsTrust(s) })),
    pending: pending(a.sessions).filter((p) => p.stuck).map((p) => ({ ...p, needsTrust: needsTrust(p) })),
  };
}

const findBySession = (sessionId) => active().sessions.find((s) => s.sessionId === sessionId) || null;

/**
 * Display name for a session: plain text, no leading dashes. It is passed to
 * Claude on the command line and written to a line-based file. The fallback is
 * usually a folder name, which can be anything, so it gets the same treatment.
 */
export function cleanName(name, fallback = '') {
  const plain = (s) => String(s || '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/^[-\s]+/, '').trim().slice(0, 200);
  return plain(name) || plain(fallback);
}

/** The name you gave a saved session (/rename or --name), or '' to let Claude pick one. */
async function savedName(sessionId, folder) {
  const f = findTranscript(cfg.PROJECTS_DIR, sessionId, folder);
  if (!f) return '';
  try {
    const s = await summarizeTranscript(f);
    return cleanName(s.customTitle || s.agentName);
  } catch {
    return '';
  }
}

async function startWindow({ cwd, mode, sessionId, name, desktop }) {
  const tag = crypto.randomBytes(5).toString('hex');
  fs.mkdirSync(cfg.WINDOWS_DIR, { recursive: true });
  const title = `Claude · ${cleanName(name, path.basename(cwd)) || 'session'}`;
  await openWindow({
    desktop, terminal: cfg.TERMINAL, claudeBin: cfg.CLAUDE_BIN, xdgRuntimeDir: cfg.XDG_RUNTIME_DIR, wrapper: cfg.WRAPPER,
    controlDir: path.join(cfg.WINDOWS_DIR, tag), tag, cwd, mode, sessionId, name, title,
  });
  log(`window ${tag}: ${mode} ${sessionId} in ${cwd}`);
  return tag;
}

/**
 * Claude will not start in a folder it doesn't trust: it stops at a question in
 * the window. So get the answer first, from you, and give it before anything is
 * stopped or opened.
 */
async function ensureTrust(folder, trust, desk) {
  if (isTrusted(cfg.CLAUDE_JSON, folder)) return;
  // Claude never saves this answer for the home folder, so it would ask in the window every time.
  if (folder === cfg.HOME) {
    throw new HttpError(409, 'Claude asks about your home folder every time and never saves the answer, so it can\'t start here from Session Dock. Use a folder inside it.');
  }
  if (!trust) throw new HttpError(409, 'Claude needs your OK to work in this folder.', { needsTrust: true });
  log(`trusting ${folder}`);
  const t = await acceptTrust({
    folder, claudeBin: fs.existsSync(cfg.CLAUDE_BIN) ? cfg.CLAUDE_BIN : 'claude', sessionsDir: cfg.SESSIONS_DIR, claudeJson: cfg.CLAUDE_JSON,
    env: desk.env, log,
  });
  if (!t.ok) throw new HttpError(500, t.message);
}

/** Waits until Claude reports in for this session, then briefly for Remote Control. */
async function awaitSession(sessionId, { notPid } = {}) {
  const s = await waitFor(() => {
    const x = findBySession(sessionId);
    if (x && x.pid !== notPid) return x;
    return pending().find((p) => p.sessionId === sessionId && p.exitCode !== undefined) || null;
  }, { timeout: 30000, interval: 400 });
  if (!s) return { started: false };
  if (s.exitCode !== undefined) return { started: false, exitCode: s.exitCode };
  const rc = await waitFor(() => {
    const x = findBySession(sessionId);
    return x && x.remoteControl ? x : null;
  }, { timeout: 15000, interval: 500 });
  // Claude may apply --name a moment after it first reports in: use the latest.
  const last = findBySession(sessionId) || rc || s;
  return { started: true, pid: s.pid, name: last.name, remoteControl: !!rc };
}

/** Stops a Claude process: SIGTERM, then SIGKILL if it hangs. Returns true once gone. */
async function stopProcess(pid) {
  signal(pid, 'SIGTERM');
  if (await waitFor(() => !procAlive(pid), { timeout: 10000, interval: 200 })) return true;
  log(`pid ${pid} ignored SIGTERM; sending SIGKILL`);
  signal(pid, 'SIGKILL');
  return !!(await waitFor(() => !procAlive(pid), { timeout: 5000, interval: 200 }));
}

function writeAction(tag, lines) {
  fs.writeFileSync(path.join(cfg.WINDOWS_DIR, tag, 'action'), `${lines.join('\n')}\n`);
}

/** POST /api/launch — open a new or resumed Claude in a desktop window. */
export async function launch({ folder, mode, sessionId, name, trust }) {
  if (mode !== 'new' && mode !== 'resume') throw new HttpError(400, 'Unknown launch mode.');
  return exclusive(`launch:${folder}:${sessionId || 'new'}`, async () => {
    // An id means one particular conversation, so it must not clash with one already open.
    if (mode === 'resume' || sessionId) {
      if (!UUID_RE.test(sessionId || '')) throw new HttpError(400, 'Invalid session id.');
      const running = findBySession(sessionId);
      if (running) {
        throw new HttpError(409, 'This session is already running. Use Restart in the Running tab instead.', { alreadyRunning: running.pid });
      }
      if (pending().some((p) => p.sessionId === sessionId && p.exitCode === undefined)) {
        throw new HttpError(409, 'This session is already open in a window but has not finished starting. Opening it twice could damage the conversation. See the Running tab.', { alreadyOpening: true });
      }
      const saved = findTranscript(cfg.PROJECTS_DIR, sessionId, folder);
      if (mode === 'resume' && !saved) throw new HttpError(404, 'Saved session not found.');
      if (mode === 'new' && saved) throw new HttpError(409, 'That conversation has already started. Resume it instead.');
    }

    const desk = desktop();
    if (!desk.ok) throw new HttpError(503, desk.reason);
    const term = terminal(desk); // checked before anything is stopped
    if (term.error) throw new HttpError(503, term.error);

    await ensureTrust(folder, trust, desk);

    // A retry of a new session keeps its id; it has no saved conversation yet.
    const id = sessionId || crypto.randomUUID();
    for (const p of pending().filter((x) => x.sessionId === id && x.exitCode !== undefined)) await stopProcess(p.pid);
    // Resumes keep the name you gave the session; without it Claude would
    // invent a new one and the session would show up renamed in the Claude app.
    const display = mode === 'new' ? cleanName(name, path.basename(folder)) : await savedName(sessionId, folder);
    await startWindow({ cwd: folder, mode, sessionId: id, name: display, desktop: desk });
    const r = await awaitSession(id);
    return { ok: true, sessionId: id, ...r };
  });
}

function getLive(pid, sessionId) {
  const s = active().sessions.find((x) => x.pid === pid);
  if (!s || (sessionId && s.sessionId !== sessionId)) {
    throw new HttpError(404, 'That session is no longer running. Pull to refresh.');
  }
  return s;
}

/** POST /api/restart — same conversation, newest Claude. Only when idle. */
export async function restart({ pid, sessionId, confirmUnknown, trust }) {
  return exclusive(`pid:${pid}`, async () => {
    const s = getLive(pid, sessionId);
    if (s.status === 'busy' || s.status === 'waiting') {
      throw new HttpError(409, s.status === 'busy'
        ? 'Claude is working, or a command it started is still running. Restart is only allowed when it is idle.'
        : 'Claude is waiting for an answer (for example a permission question). Answer it first, or use Close.',
      { notIdle: s.status });
    }
    if (s.status === 'unknown' && !confirmUnknown) {
      throw new HttpError(409, 'This Claude does not report whether it is busy.', { needsConfirm: 'unknown' });
    }
    if (!s.cwd || !fs.existsSync(s.cwd)) throw new HttpError(409, 'The session folder no longer exists, so it cannot be reopened.');
    const desk = desktop();
    if (!desk.ok) throw new HttpError(503, desk.reason);
    const term = terminal(desk); // checked before anything is stopped
    if (term.error) throw new HttpError(503, term.error);
    await ensureTrust(s.cwd, trust, desk);

    // Conversations with no messages yet have no transcript: start them fresh with the same id.
    const mode = findTranscript(cfg.PROJECTS_DIR, s.sessionId, s.cwd) ? 'resume' : 'new';
    const name = cleanName(s.name, path.basename(s.cwd)); // keep the live name across the restart

    // Last-moment check: it may have started working since the page loaded.
    const again = getLive(pid, s.sessionId);
    if (again.status === 'busy' || again.status === 'waiting') {
      throw new HttpError(409, 'Claude just started working. Try again when it is idle.', { notIdle: again.status });
    }

    const win = s.windowTag && managedWindow(cfg.WINDOWS_DIR, s.windowTag);
    log(`restart ${s.sessionId} (pid ${pid}, ${win ? 'same window' : 'new window'})`);
    if (win) {
      writeAction(win.tag, ['restart', mode, s.sessionId, name]);
      if (!(await stopProcess(pid))) throw new HttpError(500, 'Claude did not stop.');
    } else {
      if (!(await stopProcess(pid))) throw new HttpError(500, 'Claude did not stop.');
      await startWindow({ cwd: s.cwd, mode, sessionId: s.sessionId, name, desktop: desk });
    }
    const r = await awaitSession(s.sessionId, { notPid: pid });
    return { ok: true, sessionId: s.sessionId, sameWindow: !!win, ...r };
  });
}

/** Restarts a Claude that is stuck before registering, in its own window. */
async function restartPending(p, trust) {
  const desk = desktop();
  if (!desk.ok) throw new HttpError(503, desk.reason);
  await ensureTrust(p.cwd, trust, desk);
  const mode = findTranscript(cfg.PROJECTS_DIR, p.sessionId, p.cwd) ? 'resume' : 'new';
  log(`retry ${p.sessionId} (pid ${p.pid}, same window)`);
  writeAction(p.tag, ['restart', mode, p.sessionId, cleanName(p.name, path.basename(p.cwd))]);
  if (!(await stopProcess(p.pid))) throw new HttpError(500, 'Claude did not stop.');
  const r = await awaitSession(p.sessionId, { notPid: p.pid });
  return { ok: true, sessionId: p.sessionId, sameWindow: true, ...r };
}

/**
 * POST /api/retry — try again for a session that didn't come back. It may have
 * got there late, be waiting in its window, or be gone altogether.
 */
export async function retry({ sessionId, pid, folder, trust }) {
  if (!UUID_RE.test(sessionId || '')) throw new HttpError(400, 'Invalid session id.');
  return exclusive(`retry:${sessionId}`, async () => {
    const live = findBySession(sessionId);
    if (live && !live.outdated) {
      return { ok: true, sessionId, started: true, alreadyRunning: true, pid: live.pid, name: live.name, remoteControl: live.remoteControl };
    }
    if (live) return restart({ pid: live.pid, sessionId, trust });
    const inWindows = pending().filter((p) => p.sessionId === sessionId);
    const waiting = inWindows.filter((p) => p.exitCode === undefined);
    const target = waiting.find((p) => p.pid === pid) || waiting[0];
    if (target) return restartPending(target, trust);
    const stopped = inWindows[0];
    const where = folder || (stopped && stopped.cwd);
    if (!where) throw new HttpError(404, 'That session is no longer running. Resume it from its folder.');
    const mode = findTranscript(cfg.PROJECTS_DIR, sessionId, where) ? 'resume' : 'new';
    return launch({ folder: where, mode, sessionId, name: stopped && stopped.name, trust });
  });
}

/** POST /api/close — stop a session (the conversation stays saved). */
export async function close({ pid, sessionId, force }) {
  return exclusive(`pid:${pid}`, async () => {
    const stuck = pending().find((p) => p.pid === pid && p.sessionId === sessionId);
    if (stuck) {
      writeAction(stuck.tag, ['close', '', '', '']);
      log(`close ${sessionId} (pid ${pid}, not started)`);
      if (!(await stopProcess(pid))) throw new HttpError(500, 'Claude did not stop.');
      return { ok: true };
    }
    const s = getLive(pid, sessionId);
    if (s.status !== 'idle' && !force) {
      throw new HttpError(409, s.status === 'unknown'
        ? 'This Claude does not report whether it is busy.'
        : 'Claude is not idle. Closing will stop what it is doing.', { needsConfirm: s.status });
    }
    const win = s.windowTag && managedWindow(cfg.WINDOWS_DIR, s.windowTag);
    if (win) writeAction(win.tag, ['close', '', '', '']);
    log(`close ${s.sessionId} (pid ${pid})`);
    if (!(await stopProcess(pid))) throw new HttpError(500, 'Claude did not stop.');
    return { ok: true };
  });
}

/** POST /api/restart-outdated — restarts every idle session on an old version. */
export async function restartOutdated() {
  const results = [];
  for (const s of active().sessions.filter((x) => x.outdated)) {
    const who = { name: s.name, pid: s.pid, sessionId: s.sessionId, cwd: s.cwd };
    if (s.status !== 'idle') {
      results.push({ ...who, ok: false, skipped: true,
        reason: s.status === 'unknown' ? 'cannot tell if busy (restart it on its own)' : `not idle (${s.status === 'busy' ? 'working' : 'waiting'})` });
      continue;
    }
    try {
      const r = await restart({ pid: s.pid, sessionId: s.sessionId });
      const why = r.exitCode === undefined ? 'Claude has not finished starting. It may be waiting in its window.' : `Claude stopped (exit code ${r.exitCode}). Its window shows why.`;
      results.push({ ...who, ok: r.started, newPid: r.pid, reason: r.started ? null : why });
    } catch (e) {
      results.push({ ...who, ok: false, reason: e.message, needsTrust: !!e.extra?.needsTrust });
    }
  }
  return { ok: true, results };
}
