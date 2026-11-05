// Reads Claude Code's saved conversations (~/.claude/projects/<folder>/<id>.jsonl)
// to build the "Resume" list. Files can be 100+ MB, so only the start and end of
// big files are read; results are cached until the file changes.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const FULL_READ_MAX = 1024 * 1024; // files up to 1 MB are read whole
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 512 * 1024;
const SHORT_MAX_PROMPTS = 2; // "short" = at most this many of your own messages
const TEXT_MAX = 240;

/** Claude names a project's folder by replacing every non-alphanumeric char with "-". */
export const encodeProjectDir = (folder) => folder.replace(/[^a-zA-Z0-9]/g, '-');

const clip = (s, n = TEXT_MAX) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || null);

/** The text of a message you typed, or null for tool results, commands and system notes. */
export function promptText(o) {
  if (!o || o.type !== 'user' || o.isMeta || o.isSidechain) return null;
  const c = o.message && o.message.content;
  let t = null;
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) {
    const parts = c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
    if (parts.length) t = parts.join('\n');
  }
  if (!t) return null;
  t = t.trim();
  if (!t || t.startsWith('<') || t.startsWith('[Request interrupted')) return null;
  return t;
}

function parseLines(text, { dropFirst = false, dropLast = false } = {}) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out = [];
  for (const l of lines) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* partial or damaged line */
    }
  }
  return out;
}

async function readRange(fh, start, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, start);
  return buf.subarray(0, bytesRead).toString('utf8');
}

/** Builds a summary from parsed records. `full` = records cover the whole file. */
export function summarizeRecords(head, tail, { full }) {
  const s = {
    cwd: null, entrypoint: null, firstPrompt: null, lastPrompt: null,
    customTitle: null, aiTitle: null, agentName: null, prompts: full ? 0 : null, lastTimestamp: null,
  };
  for (const o of head) {
    if (!s.cwd && o.cwd) s.cwd = o.cwd;
    if (!s.entrypoint && o.type === 'user' && o.entrypoint) s.entrypoint = o.entrypoint;
    const p = promptText(o);
    if (p && !s.firstPrompt) s.firstPrompt = p;
  }
  // For titles and the last prompt, the latest record wins.
  const scan = (records) => {
    for (const o of records) {
      if (o.type === 'custom-title' && o.customTitle) s.customTitle = o.customTitle;
      else if (o.type === 'ai-title' && o.aiTitle) s.aiTitle = o.aiTitle;
      else if (o.type === 'agent-name' && o.agentName) s.agentName = o.agentName;
      else if (o.type === 'last-prompt' && o.lastPrompt) s.lastPrompt = o.lastPrompt;
      if (o.timestamp) s.lastTimestamp = o.timestamp;
      const p = promptText(o);
      if (p) {
        if (full) s.prompts++;
        s.lastTypedPrompt = p;
      }
    }
  };
  if (!full) scan(head); // titles set early in a big file may not repeat at the end
  scan(tail);
  if (!s.lastPrompt) s.lastPrompt = s.lastTypedPrompt || null;
  delete s.lastTypedPrompt;
  return s;
}

const cache = new Map();

export async function summarizeTranscript(file) {
  const st = await fsp.stat(file);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.value;

  const fh = await fsp.open(file, 'r');
  let sum;
  try {
    if (st.size <= FULL_READ_MAX) {
      const recs = parseLines(await readRange(fh, 0, st.size));
      sum = summarizeRecords(recs, recs, { full: true });
    } else {
      const head = parseLines(await readRange(fh, 0, HEAD_BYTES), { dropLast: true });
      const tail = parseLines(await readRange(fh, st.size - TAIL_BYTES, TAIL_BYTES), { dropFirst: true });
      sum = summarizeRecords(head, tail, { full: false });
    }
  } finally {
    await fh.close();
  }
  const value = {
    id: path.basename(file, '.jsonl'),
    file,
    size: st.size,
    mtime: st.mtimeMs,
    ...sum,
    ...classify(sum),
  };
  if (cache.size > 3000) cache.clear();
  cache.set(file, { key, value });
  return value;
}

/** "Other sessions" = started by a script/SDK, or very short. */
export function classify(sum) {
  const automated = !!sum.entrypoint && sum.entrypoint.startsWith('sdk');
  const short = sum.prompts !== null && sum.prompts <= SHORT_MAX_PROMPTS;
  return { automated, short, other: automated || short };
}

export function displayTitle(s) {
  return clip(s.customTitle || s.aiTitle || s.agentName || s.firstPrompt || 'Untitled session', 120);
}

async function jsonlFiles(dir) {
  try {
    return (await fsp.readdir(dir)).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** All saved sessions for one folder, newest first, split into main / other. */
export async function folderSessions(projectsDir, folder) {
  const files = await jsonlFiles(path.join(projectsDir, encodeProjectDir(folder)));
  const sums = [];
  for (const f of files) {
    try {
      const s = await summarizeTranscript(f);
      // Different folders can encode to the same name; keep only this folder's.
      if (s.cwd && s.cwd !== folder) continue;
      sums.push(s);
    } catch {
      /* unreadable file */
    }
  }
  sums.sort((a, b) => b.mtime - a.mtime);
  const view = (s) => ({
    id: s.id,
    title: displayTitle(s),
    lastPrompt: clip(s.lastPrompt),
    firstPrompt: clip(s.firstPrompt),
    mtime: s.mtime,
    size: s.size,
    prompts: s.prompts,
    entrypoint: s.entrypoint,
    automated: s.automated,
    short: s.short,
  });
  return {
    main: sums.filter((s) => !s.other).map(view),
    other: sums.filter((s) => s.other).map(view),
  };
}

/** Number of saved sessions per project folder name (cheap: no file reads). */
export async function sessionCounts(projectsDir) {
  const counts = new Map();
  let dirs = [];
  try {
    dirs = await fsp.readdir(projectsDir);
  } catch {
    return counts;
  }
  await Promise.all(
    dirs.map(async (d) => {
      const n = (await jsonlFiles(path.join(projectsDir, d))).length;
      if (n) counts.set(d, n);
    }),
  );
  return counts;
}

/**
 * Exact per-folder counts for one encoded project dir, by reading each
 * transcript's real cwd. Used only when two folders encode to the same name
 * (e.g. "my app" and "my_app").
 */
export async function countsByCwd(projectsDir, encodedName) {
  const counts = new Map();
  for (const f of await jsonlFiles(path.join(projectsDir, encodedName))) {
    try {
      const { cwd } = await summarizeTranscript(f);
      if (cwd) counts.set(cwd, (counts.get(cwd) || 0) + 1);
    } catch {
      /* unreadable */
    }
  }
  return counts;
}

/** Finds the transcript file for a session id (preferring the given folder). */
export function findTranscript(projectsDir, sessionId, folder) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  if (folder) {
    const f = path.join(projectsDir, encodeProjectDir(folder), `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  try {
    for (const d of fs.readdirSync(projectsDir)) {
      const f = path.join(projectsDir, d, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {
    /* no projects dir */
  }
  return null;
}

/** Folders with the most recent Claude activity (for the "Recent" shortcuts). */
export async function recentFolders(projectsDir, { isAllowed, limit = 8 } = {}) {
  let dirs = [];
  try {
    dirs = await fsp.readdir(projectsDir);
  } catch {
    return [];
  }
  const newest = [];
  for (const d of dirs) {
    let best = null;
    for (const f of await jsonlFiles(path.join(projectsDir, d))) {
      try {
        const m = (await fsp.stat(f)).mtimeMs;
        if (!best || m > best.m) best = { f, m };
      } catch {
        /* vanished */
      }
    }
    if (best) newest.push({ ...best, count: 0, dir: d });
  }
  newest.sort((a, b) => b.m - a.m);
  const out = [];
  const seen = new Set();
  for (const n of newest) {
    if (out.length >= limit) break;
    try {
      const s = await summarizeTranscript(n.f);
      if (!s.cwd || seen.has(s.cwd) || !fs.existsSync(s.cwd)) continue;
      if (isAllowed && !isAllowed(s.cwd)) continue;
      seen.add(s.cwd);
      out.push({ path: s.cwd, name: path.basename(s.cwd) || s.cwd, lastActive: n.m });
    } catch {
      /* skip */
    }
  }
  return out;
}
