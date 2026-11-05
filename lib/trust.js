// Claude asks "Do you trust this folder?" the first time it runs somewhere new,
// and that question blocks Remote Control from starting. A folder counts as
// trusted if it, or a folder above it, was trusted before (so trusting a parent
// folder like ~/projects covers everything inside it). Inside a git repository
// Claude only looks up to the top of the repository, so running `git init` in a
// folder takes away the trust it was inheriting: the next start asks again.
//
// When you approve trust on the phone, we answer the question through Claude
// itself: run it briefly in a hidden tmux pane, read the screen, move the
// cursor to "Yes, I trust this folder", press Enter, then stop it. We read the
// screen instead of pressing keys blindly because the default answer is
// "No, exit". An empty session leaves no transcript behind, and ~/.claude.json
// is only ever written by Claude.
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { procAlive, selfOrChildNamed, signal, sleep, waitFor } from './util.js';

let cached = { mtime: 0, projects: {} };

function projectsConfig(claudeJson) {
  try {
    const m = fs.statSync(claudeJson).mtimeMs;
    if (m !== cached.mtime) {
      cached = { mtime: m, projects: JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects || {} };
    }
  } catch {
    /* unreadable or mid-write: keep the last good copy */
  }
  return cached.projects;
}

/**
 * The git repository a folder is in, or null: { root, main }. `root` is the top
 * of this checkout. `main` differs from it only for a linked worktree, whose
 * .git file points into the main checkout ("gitdir: /repo/.git/worktrees/x").
 */
export function gitRepo(folder) {
  for (let p = folder; ; p = path.dirname(p)) {
    const dotGit = path.join(p, '.git');
    let st = null;
    try {
      st = fs.statSync(dotGit);
    } catch {
      /* no .git here: keep looking upwards */
    }
    if (st) {
      let main = p;
      if (st.isFile()) {
        try {
          const m = /^gitdir:\s*(.+?)\/\.git\/worktrees\//m.exec(fs.readFileSync(dotGit, 'utf8'));
          if (m) main = m[1];
        } catch {
          /* unreadable: treat it as a plain repository */
        }
      }
      return { root: p, main };
    }
    if (path.dirname(p) === p) return null;
  }
}

/** Claude's own rule for whether it will start in `folder` without asking. */
export function isTrusted(claudeJson, folder) {
  const projects = projectsConfig(claudeJson);
  const trusted = (p) => !!(projects[p] && projects[p].hasTrustDialogAccepted);
  const repo = gitRepo(folder);
  if (repo && trusted(repo.main)) return true;
  for (let p = folder; ; p = path.dirname(p)) {
    if (trusted(p)) return true;
    if ((repo && p === repo.root) || path.dirname(p) === p) return false;
  }
}

function tmux(sock, args, env, cwd) {
  return new Promise((resolve) => {
    const p = spawn('tmux', ['-L', sock, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 ? out : null));
  });
}

/** Decides the next key for the trust menu shown on `screen`, or null if not visible. */
export function trustMenuKey(screen) {
  if (!/trust this folder|Do you trust/i.test(screen)) return null;
  const lines = screen.split('\n');
  const yes = lines.findIndex((l) => /Yes,? I trust/i.test(l));
  const sel = lines.findIndex((l) => l.includes('❯'));
  if (yes < 0 || sel < 0) return null;
  if (sel === yes) return 'Enter';
  return yes > sel ? 'Down' : 'Up';
}

/**
 * Accepts the trust question for `folder` via a hidden Claude run.
 * Returns { ok, message }.
 */
export async function acceptTrust({ folder, claudeBin, sessionsDir, claudeJson, env, log = () => {} }) {
  const sock = `sd-trust-${crypto.randomBytes(4).toString('hex')}`;
  const tenv = { ...process.env, ...env };
  delete tenv.TMUX;
  // tmux would run "#(...)" in a -c folder name as a command, and hand a lone
  // command to a shell. So the folder is set as the working directory, and the
  // command is split up, which makes tmux start it without a shell.
  const command = ['/bin/sh', '-c', 'exec "$0"', claudeBin];
  const started = await tmux(sock, ['new-session', '-d', '-s', 't', '-x', '200', '-y', '50', ...command], tenv, folder);
  if (started === null) return { ok: false, message: 'Could not start the trust check (tmux failed).' };

  let claudePid = null;
  try {
    const panePid = Number((await tmux(sock, ['list-panes', '-t', 't', '-F', '#{pane_pid}'], tenv) || '').trim());
    claudePid = panePid ? await waitFor(() => selfOrChildNamed(panePid, 'claude'), { timeout: 5000 }) : null;
    let lastKeyAt = 0;
    const done = await waitFor(async () => {
      if (!claudePid || !procAlive(claudePid)) return 'exited';
      if (fs.existsSync(path.join(sessionsDir, `${claudePid}.json`))) return 'accepted';
      if (Date.now() - lastKeyAt < 400) return null;
      const screen = await tmux(sock, ['capture-pane', '-p', '-t', 't'], tenv);
      const key = screen && trustMenuKey(screen);
      if (key) {
        await tmux(sock, ['send-keys', '-t', 't', key], tenv);
        lastKeyAt = Date.now();
        log(`trust check: sent ${key}`);
      }
      return null;
    }, { timeout: 30000, interval: 250 });

    if (done === 'accepted' && isTrusted(claudeJson, folder)) return { ok: true, message: 'Folder trusted.' };
    if (done === 'exited') return { ok: false, message: 'Claude closed during the trust check.' };
    return { ok: false, message: 'Could not confirm trust automatically. Open the folder once in Remote Desktop.' };
  } finally {
    if (claudePid && procAlive(claudePid)) {
      signal(claudePid, 'SIGTERM');
      await waitFor(() => !procAlive(claudePid), { timeout: 5000 });
    }
    await tmux(sock, ['kill-server'], tenv);
    await sleep(50);
    // tmux leaves its socket file behind when the server ends on its own.
    fs.rmSync(path.join(tenv.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, sock), { force: true });
  }
}
