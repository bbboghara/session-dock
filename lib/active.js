// Finds running interactive Claude sessions. Each running Claude writes
// ~/.claude/sessions/<pid>.json (session id, folder, version, idle/busy status,
// Remote Control id). We only trust a file if that PID is alive AND its start
// time matches "procStart", so a reused PID can never point us at the wrong
// process. Older Claudes don't record procStart; then it must at least be a Claude.
import fs from 'node:fs';
import path from 'node:path';
import {
  listPids, procAlive, procArgs, procComm, procPpid, procStartedAt, procStartTime, procHasTty, readlinkSafe,
  versionFromPath, compareVersions,
} from './util.js';

// A healthy Claude registers within a few seconds of starting.
const STUCK_AFTER_MS = 20000;

export function installedVersion(claudeBin) {
  try {
    return versionFromPath(fs.realpathSync(claudeBin));
  } catch {
    return null;
  }
}

/** True if this process is the wrapper of that window, not something that reused its process ID. */
function isWrapperOf(pid, tag) {
  const names = procArgs(pid).map((a) => path.basename(a));
  return names.includes('claude-window.sh') && names.includes(tag);
}

/** For session files with no start time. Looks at the program itself, not at text in its arguments. */
function looksLikeClaude(pid) {
  if (procComm(pid) === 'claude') return true;
  const [program = '', script = ''] = procArgs(pid);
  return path.basename(program) === 'claude' || path.basename(script) === 'claude' || script.endsWith('claude-code/cli.js');
}

/**
 * A command from Claude's Bash tool runs in a shell that loads one of Claude's
 * snapshots. Claude's other child processes (MCP servers, for example) stay for
 * the whole session, so they say nothing about whether it is busy.
 */
const isToolShell = (pid) => procArgs(pid).join(' ').includes('shell-snapshots/snapshot-');

/** Window-control folder of a window opened by this app, if it is still open. */
export function managedWindow(windowsDir, tag) {
  if (!tag || !/^[a-z0-9]+$/.test(tag)) return null;
  const dir = path.join(windowsDir, tag);
  try {
    const wpid = Number(fs.readFileSync(path.join(dir, 'wrapper.pid'), 'utf8').trim());
    if (wpid && procAlive(wpid) && isWrapperOf(wpid, tag)) return { tag, dir, wrapperPid: wpid };
  } catch {
    /* not ours or already closed */
  }
  return null;
}

/** Every window opened by this app that is still open, by the process ID of its wrapper. */
function managedWindows(windowsDir) {
  let tags = [];
  try {
    tags = fs.readdirSync(windowsDir);
  } catch {
    return new Map();
  }
  return new Map(tags.map((t) => managedWindow(windowsDir, t)).filter(Boolean).map((w) => [w.wrapperPid, w]));
}

/**
 * Returns live sessions. Each has: pid, sessionId, name, cwd, version, outdated,
 * status (idle | busy | waiting | unknown), remoteControl, window
 * (desktop = opened by this app, terminal = some other terminal, none = no terminal).
 */
export function listActive({ sessionsDir, windowsDir, claudeBin }) {
  const latest = installedVersion(claudeBin);
  let files = [];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return { installedVersion: latest, sessions: [] };
  }
  const windows = managedWindows(windowsDir);
  let children = null;
  const childrenOf = (pid) => {
    if (!children) {
      children = new Map();
      for (const p of listPids()) children.set(procPpid(p), [...(children.get(procPpid(p)) || []), p]);
    }
    return children.get(pid) || [];
  };
  const sessions = [];
  for (const f of files) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
    } catch {
      continue; // being written right now
    }
    const pid = Number(d.pid);
    if (!pid || f !== `${pid}.json` || !procAlive(pid)) continue;
    if (d.procStart ? String(d.procStart) !== procStartTime(pid) : !looksLikeClaude(pid)) continue;
    if (d.kind && d.kind !== 'interactive') continue;
    if (String(d.entrypoint || '').startsWith('sdk-')) continue; // run by a program, with no window to manage

    const version = versionFromPath(readlinkSafe(`/proc/${pid}/exe`)) || d.version || null;
    // Ours only if the window's wrapper started it directly, not a Claude run from inside that Claude.
    const win = windows.get(procPpid(pid));
    // Stopping Claude stops any command it is running, so that counts as working.
    // Claude says "shell" for one in the background. Older versions may not, and
    // those are the ones Restart outdated acts on, so look for the command as well.
    const reported = d.status === 'shell' ? 'busy' : ['idle', 'busy', 'waiting'].includes(d.status) ? d.status : 'unknown';
    const status = (reported === 'idle' || reported === 'unknown') && childrenOf(pid).some(isToolShell) ? 'busy' : reported;
    sessions.push({
      pid,
      sessionId: d.sessionId,
      name: d.name || path.basename(d.cwd || '') || 'Claude',
      cwd: d.cwd,
      version,
      outdated: !!(version && latest && compareVersions(version, latest) < 0),
      status,
      statusSince: d.statusUpdatedAt || null,
      startedAt: d.startedAt || null,
      remoteControl: !!d.bridgeSessionId,
      window: win ? 'desktop' : procHasTty(pid) ? 'terminal' : 'none',
      windowTag: win ? win.tag : null,
    });
  }
  sessions.sort((a, b) => (a.cwd || '').localeCompare(b.cwd || '') || a.pid - b.pid);
  return { installedVersion: latest, sessions };
}

/** A window whose Claude stopped with an error, now waiting for someone to press Enter. */
function stoppedInWindow(win, sessions) {
  let lines;
  try {
    lines = fs.readFileSync(path.join(win.dir, 'exited'), 'utf8').split('\n');
  } catch {
    return null;
  }
  const [code, sessionId, name] = lines;
  const cwd = readlinkSafe(`/proc/${win.wrapperPid}/cwd`);
  const opened = procStartedAt(win.wrapperPid);
  return {
    pid: win.wrapperPid, // nothing else is left to stop in this window
    tag: win.tag,
    sessionId,
    name: name || path.basename(cwd || '') || 'Claude',
    cwd,
    startedAt: opened,
    windowOpenedAt: opened,
    stuck: true,
    duplicate: sessions.some((s) => s.sessionId === sessionId),
    exitCode: Number(code),
  };
}

/**
 * Claudes in our windows that are not running as a session: still starting,
 * blocked on a question in the window before Claude gets as far as registering
 * (the folder trust question, for example), or stopped with an error (these have
 * an exitCode). `sessions` is the list from listActive; `duplicate` means that
 * conversation is running elsewhere.
 */
export function listPending({ windowsDir, sessions, now = Date.now() }) {
  const windows = managedWindows(windowsDir);
  if (!windows.size) return [];
  const childOf = new Map(listPids().map((p) => [procPpid(p), p]));
  const pending = [];
  for (const win of windows.values()) {
    const pid = childOf.get(win.wrapperPid); // while the wrapper waits, its only child is Claude
    if (!pid) {
      const stopped = stoppedInWindow(win, sessions);
      if (stopped) pending.push(stopped);
      continue;
    }
    if (sessions.some((s) => s.pid === pid)) continue;
    const args = procArgs(pid);
    const value = (flag) => {
      const joined = args.find((a) => a.startsWith(`${flag}=`));
      if (joined) return joined.slice(flag.length + 1);
      return args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
    };
    const sessionId = value('--resume') || value('--session-id');
    if (!sessionId) continue;
    const cwd = readlinkSafe(`/proc/${pid}/cwd`);
    const startedAt = procStartedAt(pid);
    pending.push({
      pid,
      tag: win.tag,
      sessionId,
      name: value('--name') || path.basename(cwd || '') || 'Claude',
      cwd,
      startedAt,
      windowOpenedAt: procStartedAt(win.wrapperPid),
      stuck: !startedAt || now - startedAt >= STUCK_AFTER_MS,
      duplicate: sessions.some((s) => s.sessionId === sessionId),
    });
  }
  // Oldest window first: it is the one that may also hold other programs.
  return pending.sort((a, b) => (a.windowOpenedAt || 0) - (b.windowOpenedAt || 0));
}
