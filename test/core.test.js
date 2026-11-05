import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import * as folders from '../lib/folders.js';
import * as tx from '../lib/transcripts.js';
import { AuthStore, hashPin, verifyPin, pinProblem, setPinFile } from '../lib/auth.js';
import { acceptTrust, gitRepo, isTrusted, trustMenuKey } from '../lib/trust.js';
import { listActive, listPending, managedWindow } from '../lib/active.js';
import { cleanName } from '../lib/actions.js';
import { compareVersions, versionFromPath } from '../lib/util.js';
import { claudeEnv, findDesktop, openWindow, parseManagerEnv, pickTerminal, repairBus, TERMINALS } from '../lib/desktop.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-test-')));
const line = (o) => `${JSON.stringify(o)}\n`;
const userMsg = (text, extra = {}) => ({ type: 'user', message: { role: 'user', content: text }, entrypoint: 'cli', cwd: '/w', ...extra });

// ---------- folders ----------
test('isInside handles prefixes correctly', () => {
  assert.equal(folders.isInside('/home/u', '/home/u'), true);
  assert.equal(folders.isInside('/home/u', '/home/u/apps'), true);
  assert.equal(folders.isInside('/home/u', '/home/user2'), false);
  assert.equal(folders.isInside('/home/u', '/etc'), false);
});

test('resolveDir blocks .. and symlinks that leave the root', async () => {
  const root = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(root, 'a'));
  fs.symlinkSync(outside, path.join(root, 'escape'));
  assert.equal(await folders.resolveDir(root, path.join(root, 'a')), path.join(root, 'a'));
  await assert.rejects(folders.resolveDir(root, path.join(root, '..')), { status: 403 });
  await assert.rejects(folders.resolveDir(root, '/etc'), { status: 403 });
  await assert.rejects(folders.resolveDir(root, path.join(root, 'escape')), { status: 403 });
  await assert.rejects(folders.resolveDir(root, path.join(root, 'missing')), { status: 404 });
});

test('validateName rejects unsafe names and trims', () => {
  assert.throws(() => folders.validateName('a\nb'), /control characters/);
  assert.throws(() => folders.validateName('a\x1b[31m'), /control characters/);
  assert.throws(() => folders.validateName('a\0b'), /control characters/);
  assert.equal(folders.validateName('  My Project '), 'My Project');
  for (const bad of ['', '  ', '.', '..', 'a/b', 'x\0y', 'é'.repeat(200)]) {
    assert.throws(() => folders.validateName(bad), { status: 400 }, bad);
  }
});

test('renaming a link renames the link, and leaves the folder it points to alone', async () => {
  const root = tmp();
  const deep = path.join(root, 'deep');
  const target = path.join(deep, 'target');
  fs.mkdirSync(target, { recursive: true });
  const link = path.join(root, 'shortcut');
  fs.symlinkSync(target, link);
  assert.equal(await folders.linkPath(root, link), link);
  assert.equal(await folders.linkPath(root, target), null, 'an ordinary folder');
  assert.equal(await folders.linkPath(root, path.join(root, 'nope')), null);
  await folders.renameFolder(await folders.linkPath(root, link), 'renamed');
  assert.ok(fs.lstatSync(path.join(root, 'renamed')).isSymbolicLink());
  assert.ok(fs.existsSync(target), 'the target stays where it was');
  assert.ok(fs.existsSync(path.join(root, 'renamed', '.')), 'the link still works');
  // Links the rest of the app refuses are refused here too.
  fs.writeFileSync(path.join(root, 'file'), '');
  fs.symlinkSync(path.join(root, 'file'), path.join(root, 'to-file'));
  fs.symlinkSync(path.join(root, 'gone'), path.join(root, 'dangling'));
  fs.symlinkSync(tmp(), path.join(root, 'to-outside'));
  await assert.rejects(folders.linkPath(root, path.join(root, 'to-file')), /not a folder/);
  await assert.rejects(folders.linkPath(root, path.join(root, 'dangling')), /not found/);
  await assert.rejects(folders.linkPath(root, path.join(root, 'to-outside')), /links outside/);
});

test('create and rename folders; protected folders cannot move', async () => {
  const root = tmp();
  const made = await folders.createFolder(root, 'New One');
  assert.ok(fs.statSync(made).isDirectory());
  await assert.rejects(folders.createFolder(root, 'New One'), { status: 409 });
  const renamed = await folders.renameFolder(made, 'Renamed');
  assert.equal(renamed, path.join(root, 'Renamed'));
  assert.ok(!fs.existsSync(made));
  const app = path.join(root, 'apps', 'session-dock');
  fs.mkdirSync(app, { recursive: true });
  // Renaming ~/apps would move the app's own folder: blocked.
  await assert.rejects(folders.renameFolder(path.join(root, 'apps'), 'x', { protectedPaths: [app] }), { status: 403 });
  await assert.rejects(folders.renameFolder(app, 'x', { protectedPaths: [app] }), { status: 403 });
  fs.mkdirSync(path.join(root, 'taken'));
  await assert.rejects(folders.renameFolder(renamed, 'taken'), { status: 409 });
});

test('listSubfolders lists only folders, hides dot-folders by default', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'b'));
  fs.mkdirSync(path.join(root, 'A'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, 'file.txt'), 'x');
  fs.symlinkSync(path.join(root, 'b'), path.join(root, 'link-to-b'));
  const names = (await folders.listSubfolders(root)).map((f) => f.name);
  assert.deepEqual(names, ['A', 'b', 'link-to-b']);
  const all = (await folders.listSubfolders(root, { showHidden: true })).map((f) => f.name);
  assert.ok(all.includes('.hidden'));
});

// ---------- transcripts ----------
test('encodeProjectDir matches Claude naming', () => {
  assert.equal(tx.encodeProjectDir('/home/me/code/My App'), '-home-me-code-My-App');
  assert.equal(tx.encodeProjectDir('/home/me/code/my_app.v2'), '-home-me-code-my-app-v2');
});

test('promptText keeps typed prompts only', () => {
  assert.equal(tx.promptText(userMsg('fix the bug')), 'fix the bug');
  assert.equal(tx.promptText(userMsg('<command-name>/clear</command-name>')), null);
  assert.equal(tx.promptText(userMsg('hi', { isMeta: true })), null);
  assert.equal(tx.promptText(userMsg('hi', { isSidechain: true })), null);
  assert.equal(tx.promptText(userMsg([{ type: 'tool_result', content: 'x' }])), null);
  assert.equal(tx.promptText(userMsg([{ type: 'text', text: 'array form' }])), 'array form');
  assert.equal(tx.promptText(userMsg('[Request interrupted by user]')), null);
});

test('small transcript: titles, counts, classification', async () => {
  const dir = tmp();
  const f = path.join(dir, '11111111-1111-4111-8111-111111111111.jsonl');
  fs.writeFileSync(f,
    line(userMsg('first question')) + line({ type: 'assistant' }) + line(userMsg('second')) +
    line({ type: 'ai-title', aiTitle: 'AI title' }) + line(userMsg('third')) +
    line({ type: 'custom-title', customTitle: 'My name' }) + line({ type: 'last-prompt', lastPrompt: 'third' }) + '{"broken');
  const s = await tx.summarizeTranscript(f);
  assert.equal(s.prompts, 3);
  assert.equal(s.firstPrompt, 'first question');
  assert.equal(s.lastPrompt, 'third');
  assert.equal(tx.displayTitle(s), 'My name');
  assert.equal(s.other, false);
});

test('automated and short sessions go to "other"', () => {
  assert.equal(tx.classify({ entrypoint: 'sdk-py', prompts: 30 }).other, true);
  assert.equal(tx.classify({ entrypoint: 'cli', prompts: 2 }).other, true);
  assert.equal(tx.classify({ entrypoint: 'cli', prompts: 3 }).other, false);
  assert.equal(tx.classify({ entrypoint: 'cli', prompts: null }).other, false); // big file: never "short"
});

test('big transcript is read from head and tail only', async () => {
  const dir = tmp();
  const f = path.join(dir, '22222222-2222-4222-8222-222222222222.jsonl');
  const filler = line({ type: 'assistant', message: { content: 'x'.repeat(2000) } });
  let body = line(userMsg('the very first prompt')) + line({ type: 'custom-title', customTitle: 'Early title' });
  while (body.length < 1.6 * 1024 * 1024) body += filler;
  body += line(userMsg('latest prompt')) + line({ type: 'ai-title', aiTitle: 'Late AI title' });
  fs.writeFileSync(f, body);
  const s = await tx.summarizeTranscript(f);
  assert.equal(s.prompts, null);
  assert.equal(s.firstPrompt, 'the very first prompt');
  assert.equal(s.lastPrompt, 'latest prompt');
  assert.equal(s.customTitle, 'Early title'); // found in head even though not repeated
  assert.equal(s.other, false);
});

test('folderSessions skips transcripts of a different folder with the same encoding', async () => {
  const projects = tmp();
  const pd = path.join(projects, tx.encodeProjectDir('/w/a_b'));
  fs.mkdirSync(pd);
  const mk = (id, cwd, n) => fs.writeFileSync(path.join(pd, `${id}.jsonl`),
    Array.from({ length: n }, (_, i) => line(userMsg(`p${i}`, { cwd }))).join(''));
  mk('33333333-3333-4333-8333-333333333333', '/w/a_b', 5);
  mk('44444444-4444-4444-8444-444444444444', '/w/a-b', 5); // collides, other folder
  mk('55555555-5555-4555-8555-555555555555', '/w/a_b', 1); // short
  const r = await tx.folderSessions(projects, '/w/a_b');
  assert.deepEqual(r.main.map((s) => s.id), ['33333333-3333-4333-8333-333333333333']);
  assert.deepEqual(r.other.map((s) => s.id), ['55555555-5555-4555-8555-555555555555']);
});

// ---------- auth ----------
test('PIN hashing, and which new PINs are accepted', () => {
  const h = hashPin('482913');
  assert.ok(verifyPin('482913', h));
  assert.ok(!verifyPin('482914', h));
  for (const good of ['482913', '482913005127', '135790']) assert.equal(pinProblem(good), null, good);
  for (const bad of ['48291', '4829130051270', '48a913', 482913, '', '000000', '999999999', '123456', '654321', '890123', '109876', '123456789012']) {
    assert.ok(pinProblem(bad), `should refuse ${bad}`);
  }
});

test('a PIN you set: lockout after 5 misses, and a change signs out other devices', () => {
  let now = 1_000_000;
  const file = path.join(tmp(), 'auth.json');
  setPinFile(file, '482913');
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  const a = new AuthStore(file, { now: () => now });
  assert.equal(a.pinIsDefault, false);
  for (let i = 0; i < 4; i++) assert.equal(a.login('999999').ok, false);
  const locked = a.login('999999');
  assert.ok(locked.lockedMs > 0);
  assert.ok(a.login('482913').lockedMs > 0, 'correct PIN still refused while locked');
  now += locked.lockedMs + 1;
  const phone = a.login('482913');
  const tablet = a.login('482913');
  assert.ok(phone.ok && a.validate(phone.token) && a.validate(tablet.token));
  assert.equal(a.changePin(phone.token, '000000', '571946').ok, false);
  assert.equal(a.changePin(phone.token, '482913', '12').ok, false);
  assert.equal(a.changePin(phone.token, '482913', '123456').ok, false);
  assert.equal(a.changePin(phone.token, '482913', '482913').ok, false, 'must be a different PIN');
  assert.equal(a.changePin(phone.token, '482913', '571946').ok, true);
  assert.ok(a.validate(phone.token), 'device that changed the PIN stays signed in');
  assert.ok(!a.validate(tablet.token), 'other devices are signed out');
  const reloaded = new AuthStore(file, { now: () => now });
  assert.ok(reloaded.login('571946').ok);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(phone.token), 'raw tokens are never stored');
});

test('a short PIN set before the 6-digit rule keeps working', () => {
  const file = path.join(tmp(), 'auth.json');
  fs.writeFileSync(file, JSON.stringify({ pinHash: hashPin('2468'), pinIsDefault: false, tokens: [] }));
  assert.ok(new AuthStore(file).login('2468').ok);
});

test('lockouts survive a restart, but setting a new PIN from the command line clears them', () => {
  let now = 1_000_000;
  const file = path.join(tmp(), 'auth.json');
  setPinFile(file, '482913');
  const a = new AuthStore(file, { now: () => now });
  for (let i = 0; i < 3; i++) a.login('999999');
  let b = new AuthStore(file, { now: () => now });
  assert.equal(b.login('999999').attemptsLeft, 1, 'misses are remembered');
  assert.ok(b.login('999999').lockedMs > 0);
  b = new AuthStore(file, { now: () => now });
  assert.ok(b.login('482913').lockedMs > 0, 'still locked after a restart');
  const later = b.login('482913').lockedMs;
  assert.ok(later > 0 && later <= 30_000);
  setPinFile(file, '571946');
  assert.ok(new AuthStore(file, { now: () => now }).login('571946').ok);
});

test('guessing at the login page cannot stop a signed-in device from changing the PIN', () => {
  const file = path.join(tmp(), 'auth.json');
  setPinFile(file, '482913');
  const a = new AuthStore(file);
  const phone = a.login('482913');
  for (let i = 0; i < 5; i++) a.login('999999');
  assert.ok(a.login('482913').lockedMs > 0);
  assert.equal(a.changePin(phone.token, '482913', '571946').ok, true);
  assert.ok(a.login('571946').ok, 'a new PIN also ends the lockout');
});

test('no PIN chosen: a temporary one in a private file, gone once replaced', () => {
  const dir = tmp();
  const firstPinFile = path.join(dir, 'first-run-pin.txt');
  const a = new AuthStore(path.join(dir, 'auth.json'), { firstPinFile });
  const pin = fs.readFileSync(firstPinFile, 'utf8').trim();
  assert.match(pin, /^\d{6}$/);
  assert.equal((fs.statSync(firstPinFile).mode & 0o777).toString(8), '600');
  assert.ok(!fs.readFileSync(path.join(dir, 'auth.json'), 'utf8').includes(pin));
  assert.equal(a.pinIsDefault, true);
  const t = a.login(pin);
  assert.ok(t.ok);
  assert.equal(a.changePin(t.token, '', pin).ok, false, 'cannot keep the temporary PIN');
  assert.ok(a.changePin(t.token, '', '482913').ok, 'no need to type the temporary PIN again');
  assert.equal(a.pinIsDefault, false);
  assert.ok(!fs.existsSync(firstPinFile), 'the file is deleted once the PIN is replaced');
  // An existing auth file is never replaced by a new random PIN.
  const again = new AuthStore(path.join(dir, 'auth.json'), { firstPinFile });
  assert.ok(again.login('482913').ok);
  assert.ok(!fs.existsSync(firstPinFile));
});

// ---------- names that reach the command line ----------
test('session names are plain text and cannot become an option, even when they come from a folder', () => {
  assert.equal(cleanName('My Chat', 'folder'), 'My Chat');
  assert.equal(cleanName('', 'folder'), 'folder');
  assert.equal(cleanName('', '--dangerously-skip-permissions'), 'dangerously-skip-permissions');
  assert.equal(cleanName('--', '---'), '');
  assert.equal(cleanName('', 'a\nb\x1b[31mc'), 'a b [31mc');
  assert.equal(cleanName(null), '');
});

test('the window wrapper passes a name to Claude as one joined argument', () => {
  const dir = tmp();
  const log = path.join(dir, 'args');
  const fake = path.join(dir, 'fake-claude');
  fs.writeFileSync(fake, `#!/bin/bash\nprintf '%s\\n' "$@" > "${log}"\n`, { mode: 0o755 });
  const wrapper = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'bin', 'claude-window.sh');
  const id = '0b6c2a1e-1111-4111-8111-000000000009';
  const r = spawnSync(wrapper, [path.join(dir, 'ctl'), dir, 'new', id, '--version'], { env: { ...process.env, SD_CLAUDE_BIN: fake }, stdio: 'ignore' });
  assert.equal(r.status, 0);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['--session-id', id, '--name=--version', '--remote-control=--version']);
  assert.ok(!fs.existsSync(path.join(dir, 'ctl')), 'the control folder goes when the window closes');
});

// ---------- opening windows ----------
test('desktop variables reach the window without appearing on a command line', async () => {
  const dir = tmp();
  const argsFile = path.join(dir, 'args');
  const envFile = path.join(dir, 'env');
  fs.writeFileSync(path.join(dir, 'systemd-run'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nenv > "${envFile}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'xterm'), '#!/bin/sh\n', { mode: 0o755 });
  const secret = 'sk-do-not-show-this';
  await openWindow({
    desktop: { ok: true, env: {
      PATH: `${dir}:/usr/bin:/bin`, MY_API_KEY: secret, 'BASH_FUNC_x%%': '() { :; }', PWD: '/skipped', MULTI: 'a\nb',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/dbus-desktop', XDG_RUNTIME_DIR: '/run/user/1234',
    } },
    terminal: 'xterm', xdgRuntimeDir: '/run/user/1234', wrapper: '/w', controlDir: '/c', tag: 'abc', cwd: dir, mode: 'new', sessionId: 'id', name: 'a${HOME}b $$', title: 't',
  });
  const args = fs.readFileSync(argsFile, 'utf8').split('\n');
  const env = fs.readFileSync(envFile, 'utf8').split('\n');
  assert.ok(!args.join('\n').includes(secret), 'the secret is not in the command line');
  assert.ok(args.includes('--setenv=MY_API_KEY'));
  assert.ok(env.includes(`MY_API_KEY=${secret}`), 'systemd-run gets the value from its environment');
  assert.ok(args.includes('--setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-desktop'), "the window keeps the desktop's own bus");
  assert.ok(env.includes('DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1234/bus'), 'systemd-run itself uses the user bus');
  assert.ok(args.includes('--setenv=XDG_RUNTIME_DIR'));
  assert.ok(!args.some((a) => /^--setenv=(PWD|MULTI|BASH_FUNC)/.test(a)), 'skipped and unusable variables are left out');
  assert.ok(args.includes('a$${HOME}b $$$$'), 'dollar signs are escaped, so systemd leaves the name alone');
});

test('a Claude from npm finds its Node, and a config folder set only in .env reaches the window', () => {
  const env = claudeEnv({ PATH: '/usr/bin:/bin', OTHER: 'x' }, '/home/me/.nvm/bin/claude', '/home/me/claude-config');
  assert.equal(env.PATH, '/usr/bin:/bin:/home/me/.nvm/bin');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/me/claude-config');
  assert.equal(env.OTHER, 'x');
  assert.equal(claudeEnv({ PATH: '/a:/b' }, '/a/claude').PATH, '/a:/b', 'not added twice');
  assert.equal(claudeEnv({ PATH: '/a' }, 'claude').PATH, '/a', 'a bare command says nothing about folders');
});

test('a desktop that creates its display after starting is found through the user service', async () => {
  assert.deepEqual(parseManagerEnv(`A=1\nB='two words'\nC=$'tab\\there'\nD="x y"\nnot a line\nE=\n`), { A: '1', B: 'two words', D: 'x y', E: '' });
  const dir = tmp();
  const runtime = path.join(dir, 'run');
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'wayland-9'), '');
  const session = path.join(dir, 'fake-session-x');
  fs.writeFileSync(session, '#!/bin/bash\nsleep 30\n', { mode: 0o755 });
  const proc = spawn(session, [], { stdio: 'ignore', env: { PATH: process.env.PATH } });
  try {
    await new Promise((r) => proc.once('spawn', r));
    await new Promise((r) => setTimeout(r, 50));
    const opts = { extraProcesses: ['fake-session-x'], xdgRuntimeDir: runtime };
    const found = findDesktop(process.getuid(), { ...opts, managerEnv: () => ({ WAYLAND_DISPLAY: 'wayland-9', XDG_CURRENT_DESKTOP: 'GNOME' }) });
    assert.equal(found.pid, proc.pid);
    assert.equal(found.env.WAYLAND_DISPLAY, 'wayland-9');
    assert.equal(found.desktop, 'GNOME');
    const none = findDesktop(process.getuid(), { ...opts, managerEnv: () => ({}) });
    assert.notEqual(none.pid, proc.pid, 'no display anywhere: this session is not usable');
  } finally {
    proc.kill();
  }
});

// ---------- windows ----------
test('a Claude that stops with an error shows up, and its window can be closed', async () => {
  const dir = tmp();
  const fake = path.join(dir, 'fake-claude');
  fs.writeFileSync(fake, '#!/bin/bash\nexit 3\n', { mode: 0o755 });
  const wrapperFile = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'bin', 'claude-window.sh');
  const windowsDir = path.join(dir, 'windows');
  const ctl = path.join(windowsDir, 'abc123');
  fs.mkdirSync(windowsDir);
  const id = '0b6c2a1e-1111-4111-8111-000000000009';
  const wrapper = spawn(wrapperFile, [ctl, dir, 'new', id, 'My Chat'], { env: { ...process.env, SD_CLAUDE_BIN: fake }, stdio: ['pipe', 'ignore', 'ignore'] });
  const gone = new Promise((r) => wrapper.once('exit', r));
  try {
    let found = [];
    for (let i = 0; i < 100 && !found.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      found = listPending({ windowsDir, sessions: [] });
    }
    assert.equal(found.length, 1);
    const p = found[0];
    assert.equal(p.exitCode, 3);
    assert.equal(p.sessionId, id);
    assert.equal(p.name, 'My Chat');
    assert.equal(p.cwd, dir);
    assert.equal(p.pid, wrapper.pid);
    assert.equal(p.stuck, true);
    process.kill(p.pid, 'SIGTERM');
    await gone;
    assert.ok(!fs.existsSync(ctl), 'the window cleans up after itself');
  } finally {
    wrapper.kill();
  }
});

// ---------- the trust check ----------
const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

test('the trust check is not fooled by a folder name tmux would run as a command', { skip: !hasTmux }, async () => {
  const dir = tmp();
  const marker = path.join(dir, 'ran');
  const folder = path.join(dir, '#(touch $SD_TEST_MARKER)');
  const sessionsDir = path.join(dir, 'sessions');
  const claudeJson = path.join(dir, 'claude.json');
  fs.mkdirSync(folder);
  fs.mkdirSync(sessionsDir);
  // Stands in for Claude: shows the question, and on Enter records the answer for the folder it runs in.
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/bash
printf 'Do you trust this folder?\\n\\u276f Yes, I trust this folder\\n  No, exit\\n'
read -r _
node -e 'fs.writeFileSync(process.argv[1], JSON.stringify({projects:{[process.cwd()]:{hasTrustDialogAccepted:true}}}))' "${claudeJson}"
echo '{}' > "${sessionsDir}/$$.json"
sleep 30
`, { mode: 0o755 });
  const r = await acceptTrust({ folder, claudeBin: bin, sessionsDir, claudeJson, env: { SD_TEST_MARKER: marker, LC_ALL: 'C.UTF-8', TMUX_TMPDIR: dir } });
  assert.deepEqual(r, { ok: true, message: 'Folder trusted.' }, 'Claude ran in the folder itself');
  assert.ok(!fs.existsSync(marker), 'the folder name was not run as a command');
});

// ---------- trust ----------
test('trust is inherited from parent folders', () => {
  const f = path.join(tmp(), 'claude.json');
  fs.writeFileSync(f, JSON.stringify({ projects: {
    '/home/u/apps': { hasTrustDialogAccepted: true },
    '/home/u/apps/x': { hasTrustDialogAccepted: false },
    '/home/u': { hasTrustDialogAccepted: false },
  } }));
  assert.equal(isTrusted(f, '/home/u/apps/x/deep'), true);
  assert.equal(isTrusted(f, '/home/u/apps'), true);
  assert.equal(isTrusted(f, '/home/u/other'), false);
  assert.equal(isTrusted(f, '/home/u'), false);
});

test('trust menu: reads the cursor position from the real screen', () => {
  // Captured from Claude Code 2.1.316 during development.
  const screen = [
    ' Accessing workspace:', ' /tmp/x/trusttest',
    ' Quick safety check: Is this a project you created or one you trust?',
    ' Security guide', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel',
  ].join('\n');
  assert.equal(trustMenuKey(screen), 'Down');
  assert.equal(trustMenuKey(screen.replace(' ❯ No, exit', '   No, exit').replace('   Yes, I trust', ' ❯ Yes, I trust')), 'Enter');
  const reordered = [' Do you trust the files in this folder?', ' ❯ 1. Yes, I trust this folder', '   2. No, exit'].join('\n');
  assert.equal(trustMenuKey(reordered), 'Enter');
  assert.equal(trustMenuKey('> normal claude prompt'), null);
});

// ---------- versions ----------
test('version helpers', () => {
  assert.equal(versionFromPath('/home/u/.local/share/claude/versions/2.1.316'), '2.1.316');
  assert.ok(compareVersions('2.1.219', '2.1.316') < 0);
  assert.ok(compareVersions('2.10.0', '2.9.9') > 0);
  assert.equal(compareVersions('2.1.316', '2.1.316'), 0);
});

// ---------- terminals ----------
test('terminal choice: matches the desktop, falls back, honours SD_TERMINAL', () => {
  const installed = (...names) => (p) => names.includes(path.basename(p)) && p.startsWith('/usr/bin/');
  const has = installed('xterm', 'gnome-terminal', 'konsole');
  assert.equal(pickTerminal({ currentDesktop: 'KDE', exists: has }).name, 'konsole');
  assert.equal(pickTerminal({ currentDesktop: 'ubuntu:GNOME', exists: has }).name, 'gnome-terminal');
  assert.equal(pickTerminal({ currentDesktop: 'XFCE', exists: has }).name, 'gnome-terminal', 'xfce4-terminal missing: next in order');
  assert.equal(pickTerminal({ currentDesktop: '', exists: installed('xterm') }).bin, '/usr/bin/xterm');
  assert.equal(pickTerminal({ preferred: 'xterm', currentDesktop: 'KDE', exists: has }).name, 'xterm');
  assert.equal(pickTerminal({ preferred: '/usr/bin/konsole', exists: has }).bin, '/usr/bin/konsole');
  assert.match(pickTerminal({ preferred: 'kitty', exists: has }).error, /not installed/);
  assert.match(pickTerminal({ preferred: 'tmux', exists: has }).error, /Unsupported/);
  assert.match(pickTerminal({ exists: () => false }).error, /No supported terminal/);
});

test('terminal arguments keep the command intact, even with spaces in names', () => {
  const cmd = ['/opt/sd/bin/claude-window.sh', '/data/windows/ab12', '/home/me/My App', 'resume', 'id-1', 'my session'];
  for (const [name, build] of Object.entries(TERMINALS)) {
    const args = build({ title: 'Claude · my session', cwd: '/home/me/My App', cmd });
    assert.deepEqual(args.slice(-cmd.length), cmd, `${name}: the command comes last, one argument per item`);
  }
});

test('a desktop whose D-Bus socket was deleted falls back to the systemd user bus', () => {
  const env = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/dbus-gone,guid=abc', DISPLAY: ':10' };
  const exists = (p) => p === '/run/user/7/bus';
  assert.equal(repairBus(env, '/run/user/7', exists).DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/7/bus');
  assert.equal(repairBus(env, '/run/user/7', () => true), env, 'working bus is left alone');
  const abstract = { DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/tmp/dbus-x' };
  assert.equal(repairBus(abstract, '/run/user/7', exists), abstract, 'abstract sockets cannot be checked: left alone');
});

// ---------- trust inside git repositories ----------
test('trust is inherited from parent folders, but not past the top of a git repository', () => {
  const home = tmp();
  const plain = path.join(home, 'plain');
  const repo = path.join(home, 'repo');
  const sub = path.join(repo, 'src');
  fs.mkdirSync(plain);
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(sub);
  const json = path.join(home, '.claude.json');
  const write = (projects, mtime) => {
    fs.writeFileSync(json, JSON.stringify({ projects }));
    fs.utimesSync(json, mtime, mtime);
  };
  write({ [home]: { hasTrustDialogAccepted: true } }, 1000);
  assert.equal(isTrusted(json, plain), true);
  assert.equal(isTrusted(json, repo), false);
  assert.equal(isTrusted(json, sub), false);
  write({ [home]: { hasTrustDialogAccepted: true }, [repo]: { hasTrustDialogAccepted: true } }, 2000);
  assert.equal(isTrusted(json, repo), true);
  assert.equal(isTrusted(json, sub), true);
});

test('a linked worktree counts as trusted through its main checkout', () => {
  const home = tmp();
  const main = path.join(home, 'app');
  const wt = path.join(home, 'app-feature');
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'app-feature'), { recursive: true });
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${main}/.git/worktrees/app-feature\n`);
  assert.deepEqual(gitRepo(wt), { root: wt, main });
  assert.deepEqual(gitRepo(main), { root: main, main });
  const json = path.join(home, '.claude.json');
  fs.writeFileSync(json, JSON.stringify({ projects: { [main]: { hasTrustDialogAccepted: true } } }));
  fs.utimesSync(json, 3000, 3000);
  assert.equal(isTrusted(json, wt), true);
});

// ---------- windows whose Claude has not registered ----------
test('listPending finds a Claude that has not registered, and ignores one that has', async () => {
  const dir = tmp();
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/bash\nsleep 30\n', { mode: 0o755 });
  const id = '0b6c2a1e-1111-4111-8111-000000000009';
  const wrapper = spawn('bash', ['-c', `cd "${dir}"; "${bin}" --resume ${id} --name="My Chat"; true`, 'claude-window.sh', 'abc123'], { stdio: 'ignore' });
  try {
    const windowsDir = path.join(dir, 'windows');
    fs.mkdirSync(path.join(windowsDir, 'abc123'), { recursive: true });
    fs.writeFileSync(path.join(windowsDir, 'abc123', 'wrapper.pid'), String(wrapper.pid));
    let found = [];
    for (let i = 0; i < 40 && !found.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      found = listPending({ windowsDir, sessions: [] });
    }
    assert.equal(found.length, 1);
    const p = found[0];
    assert.equal(p.sessionId, id);
    assert.equal(p.name, 'My Chat');
    assert.equal(p.cwd, dir);
    assert.equal(p.tag, 'abc123');
    assert.equal(p.stuck, false);
    assert.equal(listPending({ windowsDir, sessions: [], now: Date.now() + 60000 })[0].stuck, true);
    // Registered: not pending. Same conversation under another process: a duplicate.
    assert.deepEqual(listPending({ windowsDir, sessions: [{ pid: p.pid, sessionId: id }] }), []);
    assert.equal(listPending({ windowsDir, sessions: [{ pid: 1, sessionId: id }] })[0].duplicate, true);
    process.kill(p.pid);
  } finally {
    wrapper.kill();
  }
});

test('a session belongs to a window only if the window started it directly', async () => {
  const dir = tmp();
  const bin = path.join(dir, 'claude');
  const pidFile = path.join(dir, 'inner.pid');
  // The wrapper starts "claude", and that starts a second one, like a Claude running claude in its shell.
  fs.writeFileSync(bin, `#!/bin/bash\nif [ "$1" = outer ]; then "$0" inner & echo $! > "${pidFile}"; wait; else sleep 30; fi\n`, { mode: 0o755 });
  const wrapper = spawn('bash', ['-c', `"${bin}" outer; true`, 'claude-window.sh', 'abc123'], { stdio: 'ignore' });
  const kids = (p) => fs.readFileSync(`/proc/${p}/task/${p}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
  try {
    while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, 'utf8').trim() || !kids(wrapper.pid).length) await new Promise((r) => setTimeout(r, 20));
    const outer = kids(wrapper.pid)[0];
    const inner = Number(fs.readFileSync(pidFile, 'utf8'));
    const windowsDir = path.join(dir, 'windows');
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(path.join(windowsDir, 'abc123'), { recursive: true });
    fs.mkdirSync(sessionsDir);
    fs.writeFileSync(path.join(windowsDir, 'abc123', 'wrapper.pid'), String(wrapper.pid));
    for (const pid of [outer, inner]) fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({ pid, sessionId: `s${pid}`, cwd: dir, status: 'idle', kind: 'interactive' }));
    const { sessions } = listActive({ sessionsDir, windowsDir, claudeBin: bin });
    assert.equal(sessions.find((s) => s.pid === outer).windowTag, 'abc123');
    assert.equal(sessions.find((s) => s.pid === inner).windowTag, null);
    for (const p of [...kids(inner), inner, outer]) process.kill(p);
  } finally {
    wrapper.kill();
  }
});

test('a process that merely reused a window\'s or session\'s process ID is not mistaken for it', async () => {
  const dir = tmp();
  const windowsDir = path.join(dir, 'windows');
  const sessionsDir = path.join(dir, 'sessions');
  fs.mkdirSync(path.join(windowsDir, 'abc123'), { recursive: true });
  fs.mkdirSync(sessionsDir);
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    await new Promise((r) => other.once('spawn', r));
    await new Promise((r) => setTimeout(r, 50)); // until it has become "sleep"
    // A window left behind by a crash or reboot, whose process ID now belongs to something else.
    fs.writeFileSync(path.join(windowsDir, 'abc123', 'wrapper.pid'), String(other.pid));
    assert.equal(managedWindow(windowsDir, 'abc123'), null);
    assert.deepEqual(listPending({ windowsDir, sessions: [] }), []);
    // A session file from an older Claude (no start time), same story.
    const session = { pid: other.pid, sessionId: 's', cwd: dir, status: 'idle', kind: 'interactive' };
    fs.writeFileSync(path.join(sessionsDir, `${other.pid}.json`), JSON.stringify(session));
    assert.deepEqual(listActive({ sessionsDir, windowsDir, claudeBin: 'claude' }).sessions, []);
    // "claude" somewhere in its arguments doesn't make a program a Claude.
    const editor = spawn('bash', ['-c', 'sleep 30; true', 'x', '/home/me/.claude/settings.json', 'claude'], { stdio: 'ignore' });
    try {
      await new Promise((r) => editor.once('spawn', r));
      fs.writeFileSync(path.join(sessionsDir, `${editor.pid}.json`), JSON.stringify({ ...session, pid: editor.pid }));
      assert.deepEqual(listActive({ sessionsDir, windowsDir, claudeBin: 'claude' }).sessions, []);
    } finally {
      editor.kill();
    }
  } finally {
    other.kill();
  }
});

test('session files only count under their own process ID, and script-run Claudes are left out', async () => {
  const dir = tmp();
  const sessionsDir = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsDir);
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/bash\nsleep 30\n', { mode: 0o755 });
  const real = spawn(bin, [], { stdio: 'ignore' });
  const list = () => listActive({ sessionsDir, windowsDir: path.join(dir, 'none'), claudeBin: bin }).sessions;
  try {
    await new Promise((r) => real.once('spawn', r));
    const session = { pid: real.pid, sessionId: 's', cwd: dir, status: 'idle', kind: 'interactive', entrypoint: 'cli' };
    const file = path.join(sessionsDir, `${real.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(session));
    assert.equal(list().length, 1);
    fs.writeFileSync(file, JSON.stringify({ ...session, status: 'shell' }));
    assert.equal(list()[0].status, 'busy', 'running a command counts as working');
    fs.writeFileSync(file, JSON.stringify({ ...session, entrypoint: 'sdk-py' }));
    assert.equal(list().length, 0);
    fs.writeFileSync(file, JSON.stringify(session));
    fs.renameSync(file, path.join(sessionsDir, '1.json'));
    assert.equal(list().length, 0, 'file name and process ID disagree');
  } finally {
    real.kill();
  }
});

// ---------- the server itself ----------
async function startServer(dir, env = {}) {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.dirname(path.dirname(new URL(import.meta.url).pathname)),
    env: { ...process.env, SD_PORT: '0', SD_DATA_DIR: path.join(dir, 'data'), SD_ROOT: dir, ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    srv.stdout.on('data', (d) => { out += d; const m = /:(\d{4,5})/.exec(out); if (m) resolve(m[1]); });
    srv.on('exit', () => reject(new Error('server exited')));
  });
  return { srv, port };
}

test('with a temporary PIN, nothing works until you set your own', async () => {
  const dir = tmp();
  const { srv, port } = await startServer(dir);
  try {
    const url = `http://127.0.0.1:${port}/api`;
    const post = (p, body, cookie) => fetch(`${url}/${p}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    const pin = fs.readFileSync(path.join(dir, 'data', 'first-run-pin.txt'), 'utf8').trim();
    const login = await post('login', { pin });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const get = (p) => fetch(`${url}/${p}`, { headers: { cookie } });

    assert.equal((await get('me').then((r) => r.json())).pinIsDefault, true);
    const blocked = await get('folders');
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).mustSetPin, true);
    assert.equal((await post('launch', { path: dir, mode: 'new' }, cookie)).status, 403);
    assert.equal((await post('pin', { newPin: '123456' }, cookie)).status, 400, 'too easy');
    assert.equal((await post('pin', { newPin: pin }, cookie)).status, 400, 'still the temporary one');

    assert.equal((await post('pin', { newPin: '482913' }, cookie)).status, 200);
    assert.equal((await get('me').then((r) => r.json())).pinIsDefault, false);
    assert.equal((await get('folders')).status, 200);
    assert.equal((await post('login', { pin })).status, 401, 'the temporary PIN no longer works');
    assert.ok(!fs.existsSync(path.join(dir, 'data', 'first-run-pin.txt')));
    // From here on, changing the PIN takes the current one.
    assert.equal((await post('pin', { newPin: '571946' }, cookie)).status, 400);
  } finally {
    srv.removeAllListeners('exit');
    srv.kill();
  }
});

test('the folder settings cope with links, a missing start folder, and the home folder', async () => {
  const dir = tmp();
  const home = path.join(dir, 'real-home');
  const link = path.join(dir, 'home-link');
  fs.mkdirSync(path.join(home, 'project'), { recursive: true });
  fs.symlinkSync(home, link);
  const { srv, port } = await startServer(dir, { HOME: link, SD_ROOT: link, SD_START_DIR: path.join(link, 'no-such-folder'), SD_DATA_DIR: path.join(dir, 'data'), CLAUDE_CONFIG_DIR: '' });
  try {
    const url = `http://127.0.0.1:${port}/api`;
    const post = (p, body, cookie) => fetch(`${url}/${p}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    const pin = fs.readFileSync(path.join(dir, 'data', 'first-run-pin.txt'), 'utf8').trim();
    const cookie = (await post('login', { pin })).headers.get('set-cookie').split(';')[0];
    await post('pin', { newPin: '482913' }, cookie);
    const get = (p) => fetch(`${url}/${p}`, { headers: { cookie } }).then((r) => r.json());
    const me = await get('me');
    assert.equal(me.root, home, 'links are resolved, so the root still matches real paths');
    assert.equal(me.defaultDir, home, 'a missing start folder falls back to the root');
    const atHome = await get(`folders?path=${encodeURIComponent(home)}`);
    assert.equal(atHome.here.cannotTrust, true, 'Claude never saves trust for the home folder');
    const inside = await get(`folders?path=${encodeURIComponent(path.join(home, 'project'))}`);
    assert.equal(inside.here.cannotTrust, false);
  } finally {
    srv.removeAllListeners('exit');
    srv.kill();
  }
});

test('a new session cannot take the id of a conversation that exists or is running', async () => {
  const dir = tmp();
  const config = path.join(dir, 'claude');
  const saved = '0b6c2a1e-1111-4111-8111-00000000000a';
  const live = '0b6c2a1e-1111-4111-8111-00000000000b';
  fs.mkdirSync(path.join(config, 'projects', 'somewhere'), { recursive: true });
  fs.mkdirSync(path.join(config, 'sessions'));
  fs.writeFileSync(path.join(config, 'projects', 'somewhere', `${saved}.jsonl`), '');
  const bin = path.join(dir, 'claude-bin', 'claude');
  fs.mkdirSync(path.dirname(bin));
  fs.writeFileSync(bin, '#!/bin/bash\nsleep 30\n', { mode: 0o755 });
  const proc = spawn(bin, [], { stdio: 'ignore' });
  await new Promise((r) => proc.once('spawn', r));
  await new Promise((r) => setTimeout(r, 50));
  fs.writeFileSync(path.join(config, 'sessions', `${proc.pid}.json`), JSON.stringify({ pid: proc.pid, sessionId: live, cwd: dir, status: 'idle', kind: 'interactive' }));
  const { srv, port } = await startServer(dir, { CLAUDE_CONFIG_DIR: config });
  try {
    const post = (p, body, cookie) => fetch(`http://127.0.0.1:${port}/api/${p}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    const pin = fs.readFileSync(path.join(dir, 'data', 'first-run-pin.txt'), 'utf8').trim();
    const cookie = (await post('login', { pin })).headers.get('set-cookie').split(';')[0];
    await post('pin', { newPin: '482913' }, cookie);
    assert.equal((await post('launch', { path: dir, mode: 'new', sessionId: 'not-an-id' }, cookie)).status, 400);
    const withHistory = await post('launch', { path: dir, mode: 'new', sessionId: saved }, cookie);
    assert.equal(withHistory.status, 409);
    assert.match((await withHistory.json()).error, /already started/);
    const running = await post('launch', { path: dir, mode: 'new', sessionId: live }, cookie);
    assert.equal(running.status, 409);
    assert.equal((await running.json()).alreadyRunning, proc.pid);
  } finally {
    srv.removeAllListeners('exit');
    srv.kill();
    proc.kill();
  }
});

test('malformed requests get an error and do not take the server down', async () => {
  const { srv, port } = await startServer(tmp());
  try {
    const raw = (request) => new Promise((resolve) => {
      const c = net.connect(Number(port), '127.0.0.1', () => c.write(request));
      let out = '';
      c.on('data', (d) => { out += d; });
      c.on('close', () => resolve(out));
      c.on('error', () => resolve(out));
      setTimeout(() => c.destroy(), 1000);
    });
    for (const target of ['//', '/%', '/%ff', '/api/%', '///x']) {
      await raw(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      assert.equal(srv.exitCode, null, `server died on ${target}`);
    }
    await raw('GET /api/me HTTP/1.1\r\nHost: x\r\nCookie: sd_session=%\r\nConnection: close\r\n\r\n');
    assert.match(await raw('GET /api/me HTTP/1.1\r\nHost: x\r\nCookie: other=100%; sd_session=x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 401/, "another app's cookie is ignored");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(srv.exitCode, null, 'server died on a malformed cookie');
    assert.match(await raw('GET //  HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 400/);
    for (const body of ['null', '[1]', '7', '{oops']) {
      const r = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      assert.equal(r.status, 400, `body ${body}`);
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
  } finally {
    srv.removeAllListeners('exit');
    srv.kill();
  }
});
