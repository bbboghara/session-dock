// Paths and settings shared by the whole app. Everything that touches the
// machine (Claude's files, the desktop, the data folder) is defined here so it
// is easy to see what the app reads and writes. Every setting can be changed
// with an SD_* environment variable (see .env.example).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInside } from './folders.js';

const env = process.env;

export const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The real path: paths are compared after resolving links, so a home folder reached through one must match. */
function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export const HOME = real(os.homedir());

// Folder browsing is limited to ROOT; the app opens at DEFAULT_DIR.
export const ROOT = real(path.resolve(env.SD_ROOT || HOME));

/** SD_START_DIR, or ROOT if that folder is missing or outside ROOT. */
function startDir() {
  const dir = real(path.resolve(env.SD_START_DIR || ROOT));
  try {
    if (isInside(ROOT, dir) && fs.statSync(dir).isDirectory()) return dir;
  } catch {
    /* doesn't exist */
  }
  return ROOT;
}
export const DEFAULT_DIR = startDir();

// Claude Code's own files (read-only for this app, except that it starts and
// stops Claude processes). Claude moves them all if CLAUDE_CONFIG_DIR is set.
const CLAUDE_DIR = env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
export const CLAUDE_JSON = env.CLAUDE_CONFIG_DIR ? path.join(CLAUDE_DIR, '.claude.json') : path.join(HOME, '.claude.json');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');

/**
 * The claude command: SD_CLAUDE_BIN, the native installer's location, or the first
 * one on PATH. If there is none yet, the native location, so a Claude installed
 * later is found without restarting this app.
 */
function findClaude() {
  if (env.SD_CLAUDE_BIN) return env.SD_CLAUDE_BIN;
  const dirs = [path.join(HOME, '.local', 'bin'), ...(env.PATH || '').split(':').filter(Boolean)];
  for (const d of dirs) {
    const p = path.join(d, 'claude');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* not here */
    }
  }
  return path.join(HOME, '.local', 'bin', 'claude');
}
export const CLAUDE_BIN = findClaude();

// This app's own state: PIN hash, login tokens, per-window control folders.
export const DATA_DIR = path.resolve(env.SD_DATA_DIR || path.join(APP_DIR, 'data'));
export const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
export const FIRST_PIN_FILE = path.join(DATA_DIR, 'first-run-pin.txt');
export const WINDOWS_DIR = path.join(DATA_DIR, 'windows');
export const WRAPPER = path.join(APP_DIR, 'bin', 'claude-window.sh');
export const PUBLIC_DIR = path.join(APP_DIR, 'public');

export const PORT = Number(env.SD_PORT || 50760);
export const HOST = env.SD_HOST || '127.0.0.1';
// Terminal program for new windows (unset = picked to match the desktop).
export const TERMINAL = env.SD_TERMINAL || '';
// Extra desktop session process names to look for, comma separated.
export const DESKTOP_PROCESSES = (env.SD_DESKTOP_PROCESS || '').split(',').map((s) => s.trim()).filter(Boolean);

export const UID = process.getuid();
export const XDG_RUNTIME_DIR = env.XDG_RUNTIME_DIR || `/run/user/${UID}`;
