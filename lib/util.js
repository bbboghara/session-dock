// Small helpers: HTTP errors, waiting, and reading facts about processes
// from /proc (Linux only).
import fs from 'node:fs';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls fn() until it returns a truthy value or the timeout passes. */
export async function waitFor(fn, { timeout = 10000, interval = 250 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(interval);
  }
}

/** Fields of /proc/<pid>/stat after the "(comm)" part; index 0 is field 3 (state). */
function statFields(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return s.slice(s.lastIndexOf(')') + 2).split(' ');
  } catch {
    return null;
  }
}

/** Process start time in clock ticks since boot (field 22). Claude stores the
 *  same value as "procStart", which lets us reject stale PID files. */
export function procStartTime(pid) {
  const f = statFields(pid);
  return f ? f[19] : null;
}

/** When the process started, in ms since 1970, or null. */
export function procStartedAt(pid) {
  const ticks = Number(procStartTime(pid));
  if (!ticks) return null;
  try {
    const boot = Number(/^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'))[1]);
    return boot * 1000 + ticks * 10; // Linux reports start times in 1/100 s
  } catch {
    return null;
  }
}

/** True if the process exists and is not a zombie. */
export function procAlive(pid) {
  const f = statFields(pid);
  return !!f && f[0] !== 'Z' && f[0] !== 'X';
}

/** True if the process still has a controlling terminal (stat field 7, tty_nr).
 *  A Claude whose terminal window died keeps a "(deleted)" stdin but tty_nr 0. */
export function procHasTty(pid) {
  const f = statFields(pid);
  return !!f && Number(f[4]) !== 0;
}

export function procPpid(pid) {
  const f = statFields(pid);
  return f ? Number(f[1]) : null;
}

/** The process itself if it has this name, else its first child with this name. */
export function selfOrChildNamed(pid, name) {
  if (procComm(pid) === name) return pid;
  for (const p of listPids()) {
    if (procPpid(p) === pid && procComm(p) === name) return p;
  }
  return null;
}

/** The process's command line as a list of arguments. */
export function procArgs(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

export function procEnv(pid) {
  try {
    const out = {};
    for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const i = kv.indexOf('=');
      if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return out;
  } catch {
    return {};
  }
}

export function procComm(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return null;
  }
}

export function procUid(pid) {
  try {
    return fs.statSync(`/proc/${pid}`).uid;
  } catch {
    return null;
  }
}

export function readlinkSafe(p) {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

export function listPids() {
  return fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number);
}

/** Sends a signal; returns false if the process is already gone. */
export function signal(pid, sig) {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/** Version string of the Claude binary that `~/.local/bin/claude` points at. */
export function versionFromPath(p) {
  const m = /(\d+\.\d+\.\d+)/.exec(p ? p.split('/').pop() : '');
  return m ? m[1] : null;
}

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
