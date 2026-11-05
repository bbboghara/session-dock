// Opens real terminal windows on your logged-in Linux desktop.
//
// The app runs as a background service, which has no screen. To draw a window
// on the desktop it borrows the desktop's own environment (DISPLAY, D-Bus
// address, PATH…) from the desktop's session process. Each window is started
// as its own `systemd-run --user` unit, so restarting this app never closes the
// Claude windows.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { listPids, procComm, procUid, procEnv, procStartTime, HttpError } from './util.js';

// Process names of desktop sessions. /proc's "comm" is cut to 15 characters,
// so "gnome-session-binary" shows up as "gnome-session-b".
export const SESSION_PROCESSES = [
  'xfce4-session', 'gnome-session-binary', 'gnome-shell', 'ksmserver', 'plasmashell', 'mate-session',
  'cinnamon-session', 'lxsession', 'lxqt-session', 'budgie-desktop', 'i3', 'openbox', 'sway', 'Hyprland',
];

// Friendly names for the Settings page when XDG_CURRENT_DESKTOP isn't set (xrdp, for example).
const DESKTOP_NAMES = {
  'xfce4-session': 'XFCE', 'gnome-session-b': 'GNOME', 'gnome-shell': 'GNOME', ksmserver: 'KDE Plasma',
  plasmashell: 'KDE Plasma', 'mate-session': 'MATE', 'cinnamon-sessio': 'Cinnamon', lxsession: 'LXDE',
  'lxqt-session': 'LXQt', 'budgie-desktop': 'Budgie',
};

// Desktop variables that should not be copied into the new window.
const SKIP_ENV = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * How to open each supported terminal with a title, a folder and a command.
 * Each window must stay in the process we start (no "server" mode), so that
 * closing the window ends its systemd unit.
 */
export const TERMINALS = {
  'xfce4-terminal': ({ title, cwd, cmd }) =>
    ['--disable-server', `--title=${title}`, `--working-directory=${cwd}`, '--geometry=150x42', '-x', ...cmd],
  'gnome-terminal': ({ title, cwd, cmd }) =>
    ['--wait', `--title=${title}`, `--working-directory=${cwd}`, '--geometry=150x42', '--', ...cmd],
  konsole: ({ cwd, cmd }) => ['--nofork', '--workdir', cwd, '-e', ...cmd],
  'mate-terminal': ({ title, cwd, cmd }) =>
    ['--disable-factory', `--title=${title}`, `--working-directory=${cwd}`, '--geometry=150x42', '-x', ...cmd],
  kitty: ({ title, cwd, cmd }) => ['--title', title, '--directory', cwd, ...cmd],
  alacritty: ({ title, cwd, cmd }) => ['--title', title, '--working-directory', cwd, '-e', ...cmd],
  wezterm: ({ cwd, cmd }) => ['start', '--always-new-process', '--cwd', cwd, '--', ...cmd],
  foot: ({ title, cwd, cmd }) => ['-T', title, '-D', cwd, ...cmd],
  xterm: ({ title, cmd }) => ['-T', title, '-geometry', '150x42', '-e', ...cmd],
};

// Terminals that hand new windows to a shared D-Bus-activated server. That
// server would start outside the desktop session (without its DISPLAY) and the
// window would never appear, so each window gets its own private bus instead.
// Claude inside the window still gets the desktop's bus (see claude-window.sh).
const PRIVATE_BUS = new Set(['gnome-terminal']);

// The desktop's own terminal first, then the rest in this order.
const NATIVE_TERMINAL = { XFCE: 'xfce4-terminal', GNOME: 'gnome-terminal', KDE: 'konsole', MATE: 'mate-terminal', 'X-CINNAMON': 'gnome-terminal' };
const FALLBACK_ORDER = ['xfce4-terminal', 'gnome-terminal', 'konsole', 'mate-terminal', 'kitty', 'alacritty', 'wezterm', 'foot', 'xterm'];

/**
 * Picks the terminal program. `preferred` (SD_TERMINAL) wins and may be a
 * name or a full path. Returns { name, bin } or { error }.
 */
export function pickTerminal({ preferred, currentDesktop = '', pathDirs = [], exists = isExecutable }) {
  const dirs = [...pathDirs, '/usr/local/bin', '/usr/bin', '/bin'];
  const find = (name) => dirs.map((d) => path.join(d, name)).find(exists) || null;
  if (preferred) {
    const name = path.basename(preferred);
    if (!TERMINALS[name]) {
      return { error: `Unsupported terminal "${name}". Use one of: ${Object.keys(TERMINALS).join(', ')}.` };
    }
    const bin = preferred.includes('/') ? (exists(preferred) ? preferred : null) : find(name);
    return bin ? { name, bin } : { error: `The terminal "${preferred}" is not installed.` };
  }
  const native = currentDesktop.toUpperCase().split(':').map((d) => NATIVE_TERMINAL[d]).find(Boolean);
  for (const name of [native, ...FALLBACK_ORDER].filter(Boolean)) {
    const bin = find(name);
    if (bin) return { name, bin };
  }
  return { error: `No supported terminal found. Install one of: ${FALLBACK_ORDER.join(', ')}.` };
}

/** Full path of a helper program, looked up on the desktop's PATH and the usual folders. */
function pickBin(name, env) {
  const dirs = [...(env.PATH || '').split(':').filter((d) => d.startsWith('/')), '/usr/local/bin', '/usr/bin', '/bin'];
  return dirs.map((d) => path.join(d, name)).find(isExecutable) || null;
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True if the session's display (X11 or Wayland) can actually be reached. */
function displayWorks(env, xdgRuntimeDir) {
  const x = env.DISPLAY && /^:(\d+)/.exec(env.DISPLAY);
  if (x && fs.existsSync(`/tmp/.X11-unix/X${x[1]}`)) return true;
  if (env.WAYLAND_DISPLAY) {
    const sock = path.isAbsolute(env.WAYLAND_DISPLAY)
      ? env.WAYLAND_DISPLAY
      : path.join(env.XDG_RUNTIME_DIR || xdgRuntimeDir, env.WAYLAND_DISPLAY);
    if (fs.existsSync(sock)) return true;
  }
  return false;
}

/**
 * Long-running sessions (xrdp, for example) can lose their private D-Bus
 * socket when /tmp is cleaned. Then use the systemd user bus instead, which
 * every systemd login has.
 */
export function repairBus(env, xdgRuntimeDir, exists = fs.existsSync) {
  const m = /^unix:path=([^,;]+)/.exec(env.DBUS_SESSION_BUS_ADDRESS || '');
  const userBus = path.join(env.XDG_RUNTIME_DIR || xdgRuntimeDir, 'bus');
  if (m && !exists(m[1]) && exists(userBus)) return { ...env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${userBus}` };
  return env;
}

/** Reads the output of `systemctl show-environment`. Values with escapes are left out: nothing needed here has them. */
export function parseManagerEnv(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    const quoted = /^\$?'(.*)'$/.exec(m[2]) || /^"(.*)"$/.exec(m[2]);
    const value = quoted ? quoted[1] : m[2];
    if (!value.includes('\\')) env[m[1]] = value;
  }
  return env;
}

/** The systemd user service's environment. */
function readManagerEnv(xdgRuntimeDir) {
  try {
    return parseManagerEnv(execFileSync('systemctl', ['--user', 'show-environment'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, XDG_RUNTIME_DIR: xdgRuntimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${xdgRuntimeDir}/bus` },
    }));
  } catch {
    return {};
  }
}

/**
 * What Claude needs in a window on top of the desktop's own variables. A Claude
 * from npm starts with `env node`, and Node is usually next to it but not on the
 * desktop's PATH. CLAUDE_CONFIG_DIR may be set only in this app's .env.
 */
export function claudeEnv(env, claudeBin, configDir) {
  const out = { ...env };
  if (claudeBin.includes('/')) {
    const dir = path.dirname(claudeBin);
    if (!(out.PATH || '').split(':').includes(dir)) out.PATH = out.PATH ? `${out.PATH}:${dir}` : dir;
  }
  if (configDir) out.CLAUDE_CONFIG_DIR = configDir;
  return out;
}

/** Finds the newest logged-in desktop session of this user that has a working display. */
export function findDesktop(uid, { extraProcesses = [], xdgRuntimeDir = `/run/user/${uid}`, managerEnv = readManagerEnv } = {}) {
  const names = new Set([...SESSION_PROCESSES, ...extraProcesses].map((n) => n.slice(0, 15)));
  const found = [];
  for (const pid of listPids()) {
    if (!names.has(procComm(pid)) || procUid(pid) !== uid) continue;
    found.push({ pid, start: Number(procStartTime(pid)) });
  }
  if (!found.length) {
    return { ok: false, reason: 'No desktop session is logged in. Log in to the desktop (on screen or with Remote Desktop), then try again.' };
  }
  found.sort((a, b) => b.start - a.start);
  for (const { pid } of found) {
    let env = repairBus(procEnv(pid), xdgRuntimeDir);
    if (!displayWorks(env, xdgRuntimeDir)) {
      // /proc only shows what a process started with, and GNOME on Wayland and
      // others create their display after that. They tell the user service instead.
      const manager = managerEnv(xdgRuntimeDir);
      env = repairBus({ ...manager, ...env }, xdgRuntimeDir);
      for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']) if (manager[k]) env[k] = manager[k];
      if (!displayWorks(env, xdgRuntimeDir)) continue;
    }
    return {
      ok: true, pid, env,
      display: env.WAYLAND_DISPLAY && !env.DISPLAY ? env.WAYLAND_DISPLAY : env.DISPLAY,
      desktop: env.XDG_CURRENT_DESKTOP || DESKTOP_NAMES[procComm(pid)] || procComm(pid),
    };
  }
  return { ok: false, reason: 'The desktop session has no working display.' };
}

/** The terminal that windows will open in, for this desktop. */
export function desktopTerminal(desktop, preferred) {
  return pickTerminal({
    preferred,
    currentDesktop: (desktop && desktop.env && desktop.env.XDG_CURRENT_DESKTOP) || '',
    pathDirs: ((desktop && desktop.env && desktop.env.PATH) || '').split(':').filter((d) => d.startsWith('/')),
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `${cmd} exited with ${code}`))));
  });
}

/**
 * Opens a terminal window on the desktop running the Claude wrapper.
 * args: { desktop, terminal, xdgRuntimeDir, wrapper, claudeBin, controlDir, tag, cwd, mode, sessionId, name, title }
 */
export async function openWindow(o) {
  if (!o.desktop || !o.desktop.ok) throw new HttpError(503, (o.desktop && o.desktop.reason) || 'Desktop not available.');
  const term = desktopTerminal(o.desktop, o.terminal);
  if (term.error) throw new HttpError(503, term.error);
  // systemd-run needs these two for itself, to reach the systemd user service.
  const ownEnv = { XDG_RUNTIME_DIR: o.xdgRuntimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${o.xdgRuntimeDir}/bus` };
  // Everything else is passed by name, with the value in systemd-run's own
  // environment: any user on the machine can read a command line, and desktop
  // sessions can hold API keys and tokens.
  const values = {};
  const setenv = [];
  for (const [k, v] of Object.entries(o.desktop.env)) {
    if (SKIP_ENV.has(k) || v.includes('\n') || !ENV_NAME.test(k)) continue;
    if (k in ownEnv && v !== ownEnv[k]) {
      setenv.push(`--setenv=${k}=${v}`); // a bus address or folder, not a secret
    } else {
      setenv.push(`--setenv=${k}`);
      values[k] = v;
    }
  }
  if (o.claudeBin) setenv.push(`--setenv=SD_CLAUDE_BIN=${o.claudeBin}`);
  const cmd = [o.wrapper, o.controlDir, o.cwd, o.mode, o.sessionId, o.name || ''];
  const prefix = [];
  const runSession = PRIVATE_BUS.has(term.name) && pickBin('dbus-run-session', o.desktop.env);
  if (runSession) {
    prefix.push(runSession, '--');
    if (o.desktop.env.DBUS_SESSION_BUS_ADDRESS) setenv.push(`--setenv=SD_DESKTOP_DBUS=${o.desktop.env.DBUS_SESSION_BUS_ADDRESS}`);
  }
  const args = [
    '--user', '--collect', '--quiet',
    `--unit=sd-win-${o.tag}`,
    `--description=Session Dock: ${o.title}`,
    `--working-directory=${o.cwd}`,
    ...setenv,
    '--',
    // systemd expands ${VAR} and a lone $VAR in a command, and folder names can hold anything.
    ...[...prefix, term.bin, ...TERMINALS[term.name]({ title: o.title, cwd: o.cwd, cmd })].map((a) => a.replaceAll('$', () => '$$')),
  ];
  try {
    await run('systemd-run', args, { env: { ...process.env, ...values, ...ownEnv } });
  } catch (e) {
    throw new HttpError(500, `Could not open a window on the desktop: ${e.message}`);
  }
}
