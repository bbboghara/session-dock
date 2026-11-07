// What changed in recent Claude Code versions, to help decide whether to restart
// a session now or let it wait. Claude keeps its own copy of its changelog, but
// that copy can lag behind the installed version, so only then is the public file
// fetched. Its text is treated as untrusted: the page escapes everything it shows.
import fs from 'node:fs';
import { compareVersions } from './util.js';

export const CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md';
const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const RETRY_MS = 30 * 60_000;
const RECENT_VERSIONS = 5; // shown even when every session already has them
const MOST_VERSIONS = 12;

// A rough shortlist of changes that can matter to a long-running terminal session
// on Linux. The page says it's only a starting point, and always offers the full list.
const MATTERS = /\b(secur\w*|vulnerab\w*|credential\w*|data loss|los(?:e|es|ing|t)|corrupt\w*|crash\w*|hang\w*|froze|freez\w*|stall\w*|memory (?:leak|grew|growth|usage)|sign(?:ed|s)? (?:you )?out|not logged in|remote control|remote-control|resum\w*|--continue|compact\w*|long[- ]running|restart\w*)\b/i;
const ELSEWHERE = /^(\[(VSCode|Claude Tag|Cloud sessions|Code Review)\]|Windows:|Gateway:|Self-hosted)|claude -p\b|\bAgent SDK\b|\bSDK sessions?\b|\bheadless\b|\bBedrock\b|\bVertex\b|\bFoundry\b|\bself-hosted\b|\bcloud sessions?\b|\bgateway\b|\bVS ?Code\b|\bWindows\b/i;

export function isNotable(item) {
  if (/\bmacOS\b/.test(item) && !/\bLinux\b/.test(item)) return false;
  return MATTERS.test(item) && !ELSEWHERE.test(item);
}

/** Turns the changelog's text into [{ version, items }], in the file's order. */
export function parseChangelog(text) {
  const versions = [];
  let current = null;
  for (const line of String(text).split('\n')) {
    const heading = /^##\s+\[?(\d+\.\d+\.\d+)\]?/.exec(line);
    if (heading) {
      current = { version: heading[1], items: [] };
      versions.push(current);
    } else if (/^##?\s/.test(line)) {
      current = null; // a heading of some other kind
    } else if (current && line.startsWith('- ')) {
      current.items.push(line.slice(2).trim());
    } else if (current && current.items.length && line.trim()) {
      current.items[current.items.length - 1] += ` ${line.trim()}`; // a wrapped line
    }
  }
  return versions;
}

/**
 * Reads the answer, giving up as soon as it passes the limit. Bytes are counted as
 * they arrive because Content-Length can be missing, or be the compressed size.
 */
async function readLimited(res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('too large'); // leaving the loop cancels the download
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const hasVersion = (versions, version) => versions.some((v) => v.version === version);

/** Keeps the fetched copy in memory, and doesn't ask again for a while if a fetch fails or lags too. */
export function createChangelog({ localFile, fetchFn = (...a) => fetch(...a), now = () => Date.now(), log = () => {} }) {
  let fetched = [];
  let triedAt = -Infinity;

  function readLocal() {
    try {
      return parseChangelog(fs.readFileSync(localFile, 'utf8'));
    } catch {
      return [];
    }
  }

  async function fetchLatest() {
    triedAt = now();
    try {
      const res = await fetchFn(CHANGELOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('too large');
      fetched = parseChangelog(await readLimited(res));
    } catch (e) {
      log(`could not fetch the Claude changelog: ${e.message}`);
    }
  }

  return {
    /** The newest changelog available, and whether it still lacks the installed version. */
    async load(installed) {
      const local = readLocal();
      const enough = (list) => list.length > 0 && (!installed || hasVersion(list, installed));
      if (enough(local)) return { versions: local, behind: false };
      if (!enough(fetched) && now() - triedAt >= RETRY_MS) await fetchLatest();
      const best = enough(fetched) || fetched.length > local.length ? fetched : local;
      return { versions: best, behind: !enough(best) };
    },
  };
}

/**
 * The versions worth showing, newest first: the last few, and everything your
 * running sessions don't have yet. `missing` says how many sessions lack each one.
 */
export function recentChanges(versions, sessionVersions, installed) {
  const running = sessionVersions.filter(Boolean);
  const missing = (version) => running.filter((r) => compareVersions(r, version) < 0).length;
  return [...versions]
    .filter((v) => !installed || compareVersions(v.version, installed) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))
    .filter((v, i) => i < RECENT_VERSIONS || missing(v.version) > 0)
    .slice(0, MOST_VERSIONS)
    .map((v) => ({
      version: v.version,
      missing: missing(v.version),
      items: v.items.map((text) => ({ text, notable: isNotable(text) })),
    }));
}
