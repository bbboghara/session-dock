// Session Dock — web UI (phone first). No framework: state + render functions + one
// click handler per root (event delegation via data-act attributes).

// ---------- icons (24px stroke icons) ----------
const ICONS = {
  terminal: '<path d="m5 17 6-5-6-5"/><path d="M13 19h7"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  folderPlus: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M12 10.5v6M9 13.5h6"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  home: '<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
  play: '<path d="M7 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 7 5.5z"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/><path d="M12 7.5V12l3 2"/>',
  restart: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1l2.6 2.6"/><path d="M20.5 3.5v5h-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  pencil: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  lock: '<rect x="4.5" y="11" width="15" height="9.5" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
  activity: '<path d="M21 12h-4l-3 8-4-16-3 8H3"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  alert: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8.5 21h7M12 17v4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.01"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="m10 16-4-4 4-4M6 12h10"/>',
};
const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const isAndroid = /Android/i.test(navigator.userAgent);
// Remote Control sessions open in the Claude app, or at claude.ai/code in a browser.
const CLAUDE_WEB = 'https://claude.ai/code';
const CLAUDE_CHANGELOG = 'https://code.claude.com/docs/en/changelog';
const CLAUDE_APP_INTENT = `intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=com.anthropic.claude;S.browser_fallback_url=${encodeURIComponent(CLAUDE_WEB)};end`;

function tilde(p) {
  const home = state.me && state.me.home;
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  if (s < 7 * 86400) return `${Math.round(s / 86400)} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
const size = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(b >= 1e7 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

class ApiError extends Error {
  constructor(status, data) {
    super((data && data.error) || `Request failed (${status})`);
    this.status = status;
    this.data = data || {};
  }
}
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: 'Cannot reach the server. Check your connection (and VPN, if you use one).' });
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && data.login) {
    renderLogin();
    throw new ApiError(401, data);
  }
  if (res.status === 403 && data.mustSetPin) {
    renderSetPin();
    throw new ApiError(403, data);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

let toastTimer;
function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = kind), 3800);
}

// ---------- state ----------
const state = {
  me: null,
  tab: 'folders',
  folder: null,
  recent: null,
  active: null,
  activeSig: '',
  showHidden: store.get('sd.hidden') === '1',
};
const app = document.getElementById('app');
const sheetRoot = document.getElementById('sheet-root');

// ---------- boot / login ----------
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    const me = await api('GET', 'api/me');
    if (me.pinIsDefault) return renderSetPin();
    state.me = me;
  } catch (e) {
    if (e.status === 401) return;
    return renderFatal(e.message);
  }
  renderShell();
  await openFolder(state.me.defaultDir, { history: 'replace' });
  refreshActive();
}

function renderLogin() {
  closeSheet(true);
  state.me = null; // also stops the background refresh, which would clear what you're typing
  app.className = '';
  app.innerHTML = `
    <div class="center-screen">
      <div class="app-mark">${icon('terminal')}</div>
      <h1>Session Dock</h1>
      <p class="muted">Enter your PIN to continue</p>
      <form class="login-form" data-form="login" autocomplete="off">
        <input class="pin-input" id="pin" type="password" inputmode="numeric" pattern="[0-9]*"
               maxlength="12" autocomplete="current-password" aria-label="PIN" required>
        <button class="btn primary block" type="submit">Unlock</button>
        <p class="form-error" id="login-error"></p>
      </form>
    </div>`;
  setTimeout(() => document.getElementById('pin')?.focus(), 50);
}

async function submitLogin(form) {
  const pin = form.querySelector('#pin').value.trim();
  const err = form.querySelector('#login-error');
  const btn = form.querySelector('button');
  btn.disabled = true;
  err.textContent = '';
  try {
    await api('POST', 'api/login', { pin });
    await boot();
    // Still on the login page after the right PIN: the browser refused the sign-in cookie.
    const refused = document.getElementById('login-error');
    if (refused) refused.textContent = 'That PIN is right, but this browser refused the sign-in. Open this page over HTTPS.';
  } catch (e) {
    const left = e.data && e.data.attemptsLeft;
    err.textContent = left ? `${e.message} ${left} ${left === 1 ? 'try' : 'tries'} left before a short lockout.` : e.message;
    form.querySelector('#pin').value = '';
    btn.disabled = false;
  }
}

/** Signed in with a temporary PIN: nothing else works until you choose your own. */
function renderSetPin() {
  closeSheet(true);
  state.me = null;
  app.className = '';
  const input = (name, label) => `
    <div class="field"><label for="${name}">${label}</label>
      <input class="pin-input" id="${name}" name="${name}" type="password" inputmode="numeric" pattern="[0-9]*"
             minlength="6" maxlength="12" autocomplete="new-password" required></div>`;
  app.innerHTML = `
    <div class="center-screen">
      <div class="app-mark">${icon('lock')}</div>
      <h1>Set your own PIN</h1>
      <p class="muted">The PIN you just used was temporary. Choose one only you know, 6 to 12 digits.</p>
      <form class="login-form" data-form="set-pin" autocomplete="off">
        ${input('newPin', 'New PIN')}
        ${input('newPin2', 'New PIN again')}
        <button class="btn primary block" type="submit">Save PIN</button>
        <p class="form-error" data-error></p>
      </form>
    </div>`;
  setTimeout(() => document.getElementById('newPin')?.focus(), 50);
}

async function submitSetPin(form) {
  const err = form.querySelector('[data-error]');
  const btn = form.querySelector('button');
  err.textContent = '';
  if (form.newPin.value !== form.newPin2.value) {
    err.textContent = 'The two PINs do not match.';
    return;
  }
  btn.disabled = true;
  try {
    await api('POST', 'api/pin', { newPin: form.newPin.value });
    await boot();
  } catch (e) {
    err.textContent = e.message;
    btn.disabled = false;
  }
}

function renderFatal(msg) {
  app.className = '';
  app.innerHTML = `
    <div class="center-screen">
      <div class="result-icon bad">${icon('alert')}</div>
      <h1>Can't connect</h1>
      <p class="muted">${esc(msg)}</p>
      <button class="btn primary" data-act="reload">Try again</button>
    </div>`;
}

// ---------- shell ----------
function renderShell() {
  app.className = '';
  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><span class="brand-mark">${icon('terminal')}</span><span>Session Dock</span></div>
      <span class="desk" id="desk"></span>
    </header>
    <div id="banners"></div>
    <main class="view" id="view"></main>
    <nav class="tabs" aria-label="Sections">
      <button class="tab" data-act="tab" data-tab="folders">${icon('folder')}<span>Folders</span></button>
      <button class="tab" data-act="tab" data-tab="running">${icon('activity')}<span>Running</span><span class="tab-badge" id="run-badge" hidden></span></button>
      <button class="tab" data-act="tab" data-tab="settings">${icon('sliders')}<span>Settings</span></button>
    </nav>`;
  renderChrome();
}

function renderChrome() {
  const d = state.me.desktop;
  const desk = document.getElementById('desk');
  if (desk) {
    desk.className = `desk ${d.ok ? 'ok' : 'off'}`;
    desk.textContent = d.ok ? 'Desktop on' : 'Desktop off';
  }
  const banners = [];
  if (!d.ok) banners.push(`<div class="banner danger">${icon('monitor')}<span>${esc(d.reason)}</span></div>`);
  const b = document.getElementById('banners');
  if (b) b.innerHTML = banners.join('');
  for (const t of document.querySelectorAll('.tab')) {
    if (t.dataset.tab === state.tab) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  }
  const badge = document.getElementById('run-badge');
  if (badge && state.active) {
    const n = state.active.sessions.length;
    const old = state.active.sessions.filter((s) => s.outdated).length;
    badge.hidden = n === 0;
    badge.textContent = n;
    badge.className = `tab-badge${old ? ' warn' : ''}`;
  }
}

function setTab(tab) {
  state.tab = tab;
  renderChrome();
  window.scrollTo(0, 0);
  if (tab === 'folders') renderFolders();
  else if (tab === 'running') { renderRunning(); refreshActive(); }
  else renderSettings();
}

const view = () => document.getElementById('view');

// ---------- folders ----------
async function openFolder(path, { history: mode = 'push' } = {}) {
  const q = new URLSearchParams({ path });
  if (state.showHidden) q.set('hidden', '1');
  try {
    state.folder = await api('GET', `api/folders?${q}`);
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
    return;
  }
  if (mode === 'push') history.pushState({ path: state.folder.path }, '');
  else if (mode === 'replace') history.replaceState({ path: state.folder.path }, '');
  if (state.folder.path === state.me.defaultDir && !state.recent) loadRecent();
  if (state.tab !== 'folders') { state.tab = 'folders'; renderChrome(); }
  renderFolders();
  window.scrollTo(0, 0);
}

async function loadRecent() {
  try {
    state.recent = (await api('GET', 'api/recent')).items;
    if (state.tab === 'folders' && state.folder && state.folder.path === state.me.defaultDir) renderFolders();
  } catch { /* optional */ }
}

function renderFolders() {
  const v = view();
  const f = state.folder;
  if (!v || !f) return;
  const name = f.crumbs.length > 1 ? f.crumbs[f.crumbs.length - 1].name : 'Home';
  const crumbs = f.crumbs.map((c, i) => {
    const last = i === f.crumbs.length - 1;
    const label = i === 0 ? `${icon('home')}<span>Home</span>` : esc(c.name);
    return `${i ? '<span class="crumb-sep">/</span>' : ''}<button class="crumb${last ? ' current' : ''}" data-act="open" data-path="${esc(c.path)}">${label}</button>`;
  }).join('');

  const showRecent = f.path === state.me.defaultDir && state.recent && state.recent.length;
  const recent = showRecent ? `
    <h3 class="section-label">Recent</h3>
    <div class="chips">${state.recent.map((r) => `
      <button class="chip-btn" data-act="open" data-path="${esc(r.path)}" title="${esc(tilde(r.path))}">
        ${r.running ? '<i class="dot"></i>' : icon('history')}<span>${esc(r.name)}</span>
      </button>`).join('')}
    </div>` : '';

  const rows = f.folders.map((d) => {
    const meta = [];
    if (d.running) meta.push(`<span class="run">● ${d.running} running</span>`);
    if (d.saved) meta.push(`<span>${plural(d.saved, 'session')}</span>`);
    return `
      <li data-name="${esc(d.name.toLowerCase())}">
        <button class="row" data-act="open" data-path="${esc(d.path)}">
          ${icon('folder', 'folder-ico')}
          <span class="row-main"><span class="row-name">${esc(d.name)}</span>${meta.length ? `<span class="row-meta">${meta.join('')}</span>` : ''}</span>
          ${icon('chevron', 'chev')}
        </button>
        <button class="more" data-act="rename" data-path="${esc(d.path)}" data-name="${esc(d.name)}" aria-label="Rename ${esc(d.name)}">${icon('pencil')}</button>
      </li>`;
  }).join('');

  v.innerHTML = `
    <nav class="crumbs" aria-label="Folder path">${crumbs}</nav>
    <section class="here" aria-label="This folder">
      <div class="here-head">
        <div class="here-name">${icon('folder')}<h2>${esc(name)}</h2></div>
        ${f.here.running ? `<span class="pill ok"><i class="dot"></i>${f.here.running} running</span>` : ''}
      </div>
      <div class="here-actions">
        <button class="btn primary" data-act="new-claude" ${f.here.cannotTrust ? 'disabled' : ''}>${icon('play')}New Claude</button>
        <button class="btn" data-act="resume-list" ${f.here.saved && !f.here.cannotTrust ? '' : 'disabled'}>${icon('history')}Resume${f.here.saved ? ` · ${f.here.saved}` : ''}</button>
      </div>
      ${f.here.trusted ? '' : `<p class="note">${icon('lock')}<span>${f.here.cannotTrust
    ? 'Claude asks about your home folder every time and never saves the answer, so it can\'t start here from Session Dock. Open a folder inside it.'
    : 'Claude hasn\'t worked in this folder before. You\'ll be asked to trust it first.'}</span></p>`}
    </section>
    ${recent}
    <div class="list-tools">
      <label class="search">${icon('search')}<input type="search" data-filter placeholder="Filter ${plural(f.folders.length, 'folder')}" aria-label="Filter folders" enterkeyhint="search"></label>
      <button class="btn icon-btn" data-act="new-folder" aria-label="New folder">${icon('folderPlus')}</button>
    </div>
    ${f.folders.length ? `<ul class="folder-list">${rows}</ul>` : '<p class="empty">No folders here yet.</p>'}
    <p class="empty" id="no-match" hidden>No folders match.</p>`;
}

function applyFilter(input) {
  const q = input.value.trim().toLowerCase();
  let shown = 0;
  for (const li of document.querySelectorAll('.folder-list li')) {
    const hit = !q || li.dataset.name.includes(q);
    li.hidden = !hit;
    if (hit) shown++;
  }
  const nm = document.getElementById('no-match');
  if (nm) nm.hidden = shown > 0 || !q;
}

// ---------- sheets ----------
let sheetOpen = false;
let ignorePop = false;
function openSheet(html) {
  sheetRoot.innerHTML = `<div class="scrim" data-act="sheet-close"></div>
    <section class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</section>`;
  if (!sheetOpen) {
    sheetOpen = true;
    history.pushState({ sheet: true, path: state.folder && state.folder.path }, '');
  }
  const first = sheetRoot.querySelector('input[autofocus]');
  if (first) setTimeout(() => first.focus(), 60);
}
function setSheet(html) {
  const s = sheetRoot.querySelector('.sheet');
  if (s) s.innerHTML = `<div class="grab"></div>${html}`;
  else openSheet(html);
}
function closeSheet(fromPop = false) {
  if (!sheetOpen) return;
  sheetOpen = false;
  sheetRoot.innerHTML = '';
  if (!fromPop) {
    ignorePop = true;
    history.back();
  }
}
const busySheet = (title, text) => setSheet(`<div class="progress"><div class="spinner"></div><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`);
const resultSheet = ({ ok = true, warn = false, title, body = '', actions = '' }) => setSheet(`
  <div class="center">
    <div class="result-icon ${ok ? (warn ? 'warn' : 'ok') : 'bad'}">${icon(ok ? (warn ? 'alert' : 'check') : 'x')}</div>
    <h2>${esc(title)}</h2>${body}
  </div>
  <div class="sheet-actions">${actions}<button class="btn block" data-act="sheet-close">Done</button></div>`);
const errorSheet = (e) => resultSheet({ ok: false, title: 'That didn\'t work', body: `<p>${esc(e.message)}</p>` });
const claudeAppButton = () => (isAndroid
  ? `<a class="btn primary block" href="${CLAUDE_APP_INTENT}">${icon('phone')}Open the Claude app</a>`
  : `<a class="btn primary block" href="${CLAUDE_WEB}" target="_blank" rel="noopener">${icon('phone')}Open Claude</a>`);

function launchedBody(r, verb) {
  const rc = r.remoteControl
    ? `<p>${icon('phone')} <strong>Remote Control is on.</strong> Continue in the Claude app or at claude.ai/code.</p>`
    : r.started
      ? '<p>Remote Control has not connected yet. It may need a moment, or check the window on the desktop.</p>'
      : '';
  if (!r.started) return `<p>${esc(r.exitCode === undefined ? NOT_STARTED : stoppedText(r.exitCode))}</p>`;
  return `<p>${esc(verb)}${r.name ? ` as <strong>${esc(r.name)}</strong>` : ''}.</p>${rc}`;
}

const NOT_STARTED = 'The window opened, but Claude has not finished starting. It may be waiting for an answer in the window.';
const stoppedText = (code) => `Claude stopped (exit code ${code}). The window on the desktop shows why.`;
const retryButton = (sessionId, folder) => `<button class="btn primary block" data-act="retry-session" data-id="${esc(sessionId)}" data-path="${esc(folder || '')}">${icon('restart')}Retry</button>`;

/** The result of opening or restarting a session: only says it runs if it does. */
function startedSheet(r, title, verb, folder) {
  if (!r.started) return resultSheet({ ok: true, warn: true, title: r.exitCode === undefined ? 'Not started yet' : 'Claude stopped', body: launchedBody(r, verb), actions: retryButton(r.sessionId, folder) });
  resultSheet({ ok: true, warn: !r.remoteControl, title, body: launchedBody(r, verb), actions: claudeAppButton() });
}

/** Asks for the OK Claude needs before it can start in this folder. */
const trustSheet = (folder, act, attrs, label) => setSheet(`
  <h2>Trust this folder?</h2>
  <p>Claude needs your OK to work in <span class="mono">${esc(tilde(folder))}</span>. It will be able to read, edit and run files here. A folder that has become a git repository needs this once, even inside a folder you already trust.</p>
  <div class="sheet-actions"><button class="btn primary block" data-act="${act}" ${attrs}>${esc(label)}</button>
  <button class="btn block ghost" data-act="sheet-close">Cancel</button></div>`);

// New folder
function sheetNewFolder() {
  openSheet(`
    <h2>New folder</h2>
    <p>Inside <span class="mono">${esc(tilde(state.folder.path))}</span></p>
    <form data-form="new-folder">
      <div class="field"><input class="text-input" name="name" maxlength="120" placeholder="Folder name" autocomplete="off" autofocus required></div>
      <p class="form-error" data-error></p>
      <div class="sheet-actions"><button class="btn primary block" type="submit">Create and open</button>
      <button class="btn block ghost" type="button" data-act="sheet-close">Cancel</button></div>
    </form>`);
}
async function submitNewFolder(form) {
  const name = form.name.value;
  const err = form.querySelector('[data-error]');
  try {
    const r = await api('POST', 'api/folders/create', { parent: state.folder.path, name });
    closeSheet();
    toast(`Created "${name.trim()}"`);
    setTimeout(() => openFolder(r.path), 30);
  } catch (e) {
    err.textContent = e.message;
  }
}

// Rename
function sheetRename(path, name) {
  openSheet(`
    <h2>Rename folder</h2>
    <p class="mono">${esc(tilde(path))}</p>
    <form data-form="rename" data-path="${esc(path)}">
      <div class="field"><input class="text-input" name="name" maxlength="120" value="${esc(name)}" autocomplete="off" autofocus required></div>
      <p class="form-error" data-error></p>
      <div class="sheet-actions"><button class="btn primary block" type="submit">Rename</button>
      <button class="btn block ghost" type="button" data-act="sheet-close">Cancel</button></div>
    </form>`);
}
async function submitRename(form, confirm = false) {
  const path = form.dataset.path;
  const name = form.name.value;
  const err = form.querySelector('[data-error]');
  try {
    await api('POST', 'api/folders/rename', { path, name, confirm });
    closeSheet();
    toast(`Renamed to "${name.trim()}"`);
    setTimeout(() => openFolder(state.folder.path, { history: 'none' }), 30);
  } catch (e) {
    if (e.data.needsConfirm) {
      err.innerHTML = `${esc(e.message)}<br><button class="btn danger-ghost small" type="button" data-act="rename-confirm">Rename anyway</button>`;
    } else err.textContent = e.message;
  }
}

// New Claude
function sheetNewClaude() {
  const f = state.folder;
  const name = f.crumbs.length > 1 ? f.crumbs[f.crumbs.length - 1].name : 'home';
  openSheet(`
    <h2>New Claude session</h2>
    <p>Opens a terminal window on the desktop in <span class="mono">${esc(tilde(f.path))}</span> with Remote Control on.</p>
    <form data-form="new-claude">
      <div class="field"><label for="sname">Session name</label>
        <input class="text-input" id="sname" name="name" maxlength="60" value="${esc(name)}" autocomplete="off"></div>
      ${f.here.trusted ? '' : `<label class="check"><input type="checkbox" name="trust" required>
        <span><strong>I trust this folder.</strong> Claude will be able to read, edit and run files in it.</span></label>`}
      <div class="sheet-actions"><button class="btn primary block" type="submit">${icon('play')}Start on desktop</button>
      <button class="btn block ghost" type="button" data-act="sheet-close">Cancel</button></div>
    </form>`);
}
async function submitNewClaude(form) {
  const body = { path: state.folder.path, mode: 'new', name: form.name.value, trust: !!(form.trust && form.trust.checked) };
  busySheet('Starting Claude…', body.trust ? 'Trusting the folder, then opening a window on the desktop. This takes a few seconds.' : 'Opening a window on the desktop. This takes a few seconds.');
  try {
    const r = await api('POST', 'api/launch', body);
    startedSheet(r, 'Claude is running', 'Started in a desktop window', body.path);
    afterChange();
  } catch (e) {
    errorSheet(e);
  }
}

// Resume
async function sheetResumeList() {
  const f = state.folder;
  openSheet('<div class="progress"><div class="spinner"></div><p>Loading saved sessions…</p></div>');
  let data;
  try {
    data = await api('GET', `api/sessions?${new URLSearchParams({ path: f.path })}`);
  } catch (e) {
    return errorSheet(e);
  }
  state.sessions = data;
  const item = (s) => `
    <li><button class="session" data-act="resume-pick" data-id="${esc(s.id)}">
      <span class="session-title"><span>${esc(s.title)}</span>${s.running ? '<span class="pill ok"><i class="dot"></i>running</span>' : ''}</span>
      ${s.lastPrompt && s.lastPrompt !== s.title ? `<span class="session-prompt">“${esc(s.lastPrompt)}”</span>` : ''}
      <span class="session-when">${ago(s.mtime)} · ${size(s.size)}${s.automated ? ' · automated' : s.prompts !== null ? ` · ${plural(s.prompts, 'message')}` : ''}</span>
    </button></li>`;
  setSheet(`
    <h2>Resume in ${esc(f.crumbs[f.crumbs.length - 1].name)}</h2>
    <p>Pick a conversation. It reopens in a desktop window with Remote Control on.</p>
    ${data.main.length ? `<ul class="session-list">${data.main.map(item).join('')}</ul>` : '<p class="empty">No regular sessions. Check “Other sessions” below.</p>'}
    ${data.other.length ? `<details class="other"${data.main.length ? '' : ' open'}>
      <summary>${icon('chevron')}Other sessions (${data.other.length}): short or automated</summary>
      <ul class="session-list">${data.other.map(item).join('')}</ul></details>` : ''}
    <div class="sheet-actions"><button class="btn block ghost" data-act="sheet-close">Cancel</button></div>`);
}
function sheetResumeConfirm(id) {
  const s = [...state.sessions.main, ...state.sessions.other].find((x) => x.id === id);
  if (!s) return;
  if (s.running) {
    return setSheet(`
      <h2>Already running</h2>
      <p><strong>${esc(s.title)}</strong> is already open. Running it twice would mix up the conversation.</p>
      <div class="sheet-actions"><button class="btn primary block" data-act="goto-running">Show in Running</button>
      <button class="btn block ghost" data-act="resume-back">Back</button></div>`);
  }
  setSheet(`
    <h2>Resume this session?</h2>
    <p><strong>${esc(s.title)}</strong></p>
    ${s.lastPrompt ? `<p>Last message: “${esc(s.lastPrompt)}”</p>` : ''}
    <p>${ago(s.mtime)} · ${size(s.size)}</p>
    <div class="sheet-actions"><button class="btn primary block" data-act="resume-go" data-id="${esc(id)}">${icon('history')}Resume on desktop</button>
    <button class="btn block ghost" data-act="resume-back">Back</button></div>`);
}
async function resumeGo(id, trust = false) {
  busySheet('Resuming…', 'Opening a window on the desktop. This takes a few seconds.');
  try {
    const r = await api('POST', 'api/launch', { path: state.folder.path, mode: 'resume', sessionId: id, trust });
    startedSheet(r, 'Session resumed', 'Reopened in a desktop window', state.folder.path);
    afterChange();
  } catch (e) {
    if (e.data.needsTrust) return trustSheet(state.folder.path, 'resume-trust', `data-id="${esc(id)}"`, 'Trust and resume');
    errorSheet(e);
  }
}

// ---------- running ----------
async function refreshActive() {
  try {
    const a = await api('GET', 'api/active');
    const sig = JSON.stringify([a.sessions, a.pending, a.installedVersion, a.desktop]);
    state.active = a;
    if (JSON.stringify(state.me.desktop) !== JSON.stringify(a.desktop)) {
      state.me.desktop = a.desktop;
    }
    renderChrome();
    if (sig !== state.activeSig) {
      state.activeSig = sig;
      if (state.tab === 'running') renderRunning();
    }
  } catch { /* shown elsewhere */ }
}

const STATUS = {
  idle: ['ok', 'Idle'],
  busy: ['warn status-busy', 'Working'],
  waiting: ['info', 'Waiting for answer'],
  unknown: ['', 'Status unknown'],
};
const WINDOW = { desktop: 'Desktop window', terminal: 'Other terminal', none: 'No window' };

function renderRunning() {
  const v = view();
  if (!v) return;
  const a = state.active;
  if (!a) {
    v.innerHTML = '<div class="progress"><div class="spinner"></div></div>';
    return;
  }
  const outdated = a.sessions.filter((s) => s.outdated);
  const stuck = a.pending || [];
  const twice = (p) => stuck.filter((x) => x.sessionId === p.sessionId).length > 1;
  const stuckCards = stuck.map((p) => `
      <li class="card outdated">
        <div class="card-top">
          <div><div class="card-title">${esc(p.name)}</div><div class="card-path">${esc(tilde(p.cwd || '?'))}</div></div>
          <span class="pill warn"><i class="dot"></i>${p.exitCode === undefined ? 'Not started' : 'Stopped'}</span>
        </div>
        <p class="card-note">${p.duplicate ? 'This conversation is already running in another window. Close this one.'
    : p.exitCode !== undefined ? esc(stoppedText(p.exitCode))
    : p.needsTrust ? 'Claude is asking in this window whether to trust the folder.'
      : 'Claude has not finished starting. It may be waiting for an answer in this window.'}${!p.duplicate && twice(p) ? ' Another window is opening the same conversation: retry in the older one and close the other.' : ''}</p>
        <div class="card-tags"><span class="pill">Window opened ${esc(ago(p.windowOpenedAt))}</span></div>
        <div class="card-actions">
          ${p.duplicate ? '' : `<button class="btn" data-act="pending-retry" data-pid="${p.pid}">${icon('restart')}${p.needsTrust ? 'Trust &amp; retry' : 'Retry'}</button>`}
          <button class="btn danger-ghost" data-act="close" data-pid="${p.pid}">${icon('x')}Close</button>
        </div>
      </li>`).join('');
  const cards = a.sessions.map((s) => {
    const [cls, label] = STATUS[s.status] || STATUS.unknown;
    return `
      <li class="card${s.outdated ? ' outdated' : ''}">
        <div class="card-top">
          <div><div class="card-title">${esc(s.name)}</div><div class="card-path">${esc(tilde(s.cwd || '?'))}</div></div>
          <span class="pill ${cls}"><i class="dot"></i>${label}</span>
        </div>
        <div class="card-tags">
          <span class="pill ${s.outdated ? 'warn' : ''}">v${esc(s.version || '?')}${s.outdated ? ' · outdated' : ''}</span>
          <span class="pill ${s.remoteControl ? 'accent' : ''}">${s.remoteControl ? 'Remote Control on' : 'No Remote Control'}</span>
          <span class="pill">${WINDOW[s.window] || esc(s.window)}</span>
        </div>
        <div class="card-actions">
          <button class="btn" data-act="restart" data-pid="${s.pid}">${icon('restart')}Restart</button>
          <button class="btn danger-ghost" data-act="close" data-pid="${s.pid}">${icon('x')}Close</button>
        </div>
      </li>`;
  }).join('');
  v.innerHTML = `
    <div class="running-head">
      <span class="ver">Installed: <b>Claude ${esc(a.installedVersion || '?')}</b></span>
      <button class="btn small" data-act="changelog">${icon('info')}What's new</button>
      ${outdated.length ? `<button class="btn small" data-act="restart-outdated">${icon('restart')}Restart outdated (${outdated.length})</button>` : ''}
    </div>
    ${a.sessions.length || stuck.length ? `<ul class="card-list">${stuckCards}${cards}</ul>` : '<p class="empty">No Claude sessions are running.<br>Start one from the Folders tab.</p>'}`;
}

// ---------- what's new ----------
/** Changelog text is not ours: escape it all, then allow only code spans. Links keep their words but not their address. */
const changeText = (t) => esc(t).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`([^`]+)`/g, '<code>$1</code>');
const changeList = (items) => `<ul class="cl-list">${items.map((i) => `<li>${changeText(i.text)}</li>`).join('')}</ul>`;

function versionBlock(v) {
  const notable = v.items.filter((i) => i.notable);
  const shortlist = notable.length
    ? `<h4 class="cl-label">Worth a look</h4>${changeList(notable)}`
    : '<p class="cl-none">Nothing here matched the shortlist.</p>';
  const all = `<details class="other cl-all"><summary>${icon('chevron')}All ${plural(v.items.length, 'change')}</summary>${changeList(v.items)}</details>`;
  if (!v.missing) {
    return `<details class="other cl-old"><summary>${icon('chevron')}v${esc(v.version)} · your sessions have this</summary>${shortlist}${all}</details>`;
  }
  return `<section class="cl-version">
      <h3>v${esc(v.version)} <span class="pill warn">${v.missing === 1 ? "1 session doesn't" : `${v.missing} sessions don't`} have this</span></h3>
      ${shortlist}${all}
    </section>`;
}

async function sheetChangelog() {
  openSheet('<div class="progress"><div class="spinner"></div><p>Loading what\'s new…</p></div>');
  let data;
  try {
    data = await api('GET', 'api/changelog');
  } catch (e) {
    return errorSheet(e);
  }
  if (!sheetOpen) return;
  const old = state.active ? state.active.sessions.filter((s) => s.outdated).length : 0;
  const intro = old
    ? `${old === 1 ? '1 session runs' : `${old} sessions run`} an older Claude, and ${old === 1 ? 'gets' : 'get'} these changes on restart. If nothing here matters to you, it can wait.`
    : 'All your sessions are on the installed Claude.';
  setSheet(`
    <h2>What's new in Claude Code</h2>
    <p>${data.changes.length ? intro : "Claude's changelog couldn't be read, and it couldn't be fetched either."}</p>
    ${data.behind && data.installedVersion ? `<p class="cl-none">Notes for v${esc(data.installedVersion)} aren't available yet.</p>` : ''}
    ${data.changes.map(versionBlock).join('')}
    ${data.changes.length ? '<p class="cl-none cl-foot">“Worth a look” is picked by keywords such as crash, lost, resume and security, leaving out other platforms. It\'s a starting point, not a judgement.</p>' : ''}
    <div class="sheet-actions">
      ${old ? `<button class="btn primary block" data-act="restart-outdated">${icon('restart')}Restart outdated (${old})</button>` : ''}
      <a class="btn block" href="${CLAUDE_CHANGELOG}" target="_blank" rel="noopener">Full changelog</a>
      <button class="btn block ghost" data-act="sheet-close">Done</button>
    </div>`);
}

const findActive = (pid) => state.active && state.active.sessions.find((s) => s.pid === Number(pid));
const findPending = (pid) => state.active && (state.active.pending || []).find((p) => p.pid === Number(pid));

function sheetRestart(pid) {
  const s = findActive(pid);
  if (!s) return;
  if (s.status === 'busy' || s.status === 'waiting') {
    return openSheet(`
      <div class="center"><div class="result-icon warn">${icon('alert')}</div>
      <h2>Not idle right now</h2>
      <p>${s.status === 'busy'
        ? `<strong>${esc(s.name)}</strong> is working, or a command it started is still running, and restarting would stop it. Try again when it finishes.`
        : `<strong>${esc(s.name)}</strong> is waiting for an answer (for example a permission question). Answer it in the Claude app, or use Close.`}</p></div>
      <div class="sheet-actions"><button class="btn block" data-act="sheet-close">OK</button></div>`);
  }
  const where = s.window === 'desktop' ? 'It reopens in the same desktop window.' : 'It reopens in a new window on the desktop.';
  const unknown = s.status === 'unknown';
  openSheet(`
    <h2>Restart ${esc(s.name)}?</h2>
    ${unknown ? `<p class="check">${icon('alert')}<span>This Claude (v${esc(s.version)}) doesn't report whether it is busy. Only restart if you know it is idle.</span></p>` : ''}
    <p>Claude closes and resumes the <strong>same conversation</strong> on ${state.active.installedVersion ? `<strong>v${esc(state.active.installedVersion)}</strong>` : 'the installed Claude'}. ${where}</p>
    <div class="sheet-actions"><button class="btn primary block" data-act="restart-go" data-pid="${s.pid}" data-unknown="${unknown ? '1' : ''}">${icon('restart')}${unknown ? 'Restart anyway' : 'Restart'}</button>
    <button class="btn block ghost" data-act="sheet-close">Cancel</button></div>`);
}
async function restartGo(pid, confirmUnknown, trust = false) {
  const s = findActive(pid);
  busySheet('Restarting…', trust ? 'Trusting the folder, then resuming the same conversation.' : 'Stopping Claude and resuming the same conversation.');
  try {
    const r = await api('POST', 'api/restart', { pid: Number(pid), sessionId: s && s.sessionId, confirmUnknown, trust });
    startedSheet(r, 'Restarted', r.sameWindow ? 'Reopened in the same window' : 'Reopened in a new desktop window', s && s.cwd);
  } catch (e) {
    if (e.data.needsTrust && s) return trustSheet(s.cwd, 'restart-trust', `data-pid="${s.pid}" data-unknown="${confirmUnknown ? '1' : ''}"`, 'Trust and restart');
    errorSheet(e);
  }
  afterChange();
}

function sheetClose(pid) {
  const p = findPending(pid);
  if (p) {
    return openSheet(`
      <h2>Close this window?</h2>
      <p><strong>${esc(p.name)}</strong> · window opened ${esc(ago(p.windowOpenedAt))}</p>
      <p>The conversation stays saved. Any other programs started from this window stop too.</p>
      <div class="sheet-actions"><button class="btn danger block" data-act="close-go" data-pid="${p.pid}" data-force="1">${icon('x')}Close window</button>
      <button class="btn block ghost" data-act="sheet-close">Cancel</button></div>`);
  }
  const s = findActive(pid);
  if (!s) return;
  const idle = s.status === 'idle';
  const why = { busy: 'Claude is working right now. Closing stops it mid-task.',
    waiting: 'Claude is waiting for an answer. Closing cancels that question.',
    unknown: `This Claude (v${esc(s.version)}) doesn't report whether it is busy.` }[s.status];
  openSheet(`
    <h2>Close ${esc(s.name)}?</h2>
    ${idle ? '' : `<p class="check">${icon('alert')}<span>${why}</span></p>`}
    <p>The conversation stays saved. You can resume it later from its folder.${s.window === 'desktop' ? ' Any other programs started from its window stop too.' : ''}</p>
    <div class="sheet-actions"><button class="btn ${idle ? 'primary' : 'danger'} block" data-act="close-go" data-pid="${s.pid}" data-force="${idle ? '' : '1'}">${icon('x')}${idle ? 'Close session' : 'Close anyway'}</button>
    <button class="btn block ghost" data-act="sheet-close">Cancel</button></div>`);
}
async function closeGo(pid, force) {
  const s = findActive(pid) || findPending(pid);
  busySheet('Closing…', 'Stopping Claude.');
  try {
    await api('POST', 'api/close', { pid: Number(pid), sessionId: s && s.sessionId, force });
    closeSheet();
    toast(`Closed ${s ? s.name : 'session'}`);
  } catch (e) {
    errorSheet(e);
  }
  afterChange();
}

function sheetRestartOutdated() {
  const old = state.active.sessions.filter((s) => s.outdated);
  const go = old.filter((s) => s.status === 'idle');
  const skip = old.filter((s) => s.status !== 'idle');
  const reason = (s) => ({ busy: 'working', waiting: 'waiting for an answer', unknown: 'can\'t tell if busy, restart it on its own' })[s.status];
  openSheet(`
    <h2>Restart outdated sessions</h2>
    <p>Each idle session resumes the same conversation on <strong>v${esc(state.active.installedVersion)}</strong>.</p>
    <ul class="result-list">
      ${go.map((s) => `<li>${icon('restart', 'ok')}<span><strong>${esc(s.name)}</strong> · v${esc(s.version)}</span></li>`).join('')}
      ${skip.map((s) => `<li>${icon('alert', 'skip')}<span><strong>${esc(s.name)}</strong> · skipped (${reason(s)})</span></li>`).join('')}
    </ul>
    <div class="sheet-actions"><button class="btn primary block" data-act="restart-outdated-go" ${go.length ? '' : 'disabled'}>${icon('restart')}Restart ${plural(go.length, 'session')}</button>
    <button class="btn block ghost" data-act="sheet-close">Cancel</button></div>`);
}
async function restartOutdatedGo() {
  busySheet('Restarting…', 'One at a time. This can take a little while.');
  try {
    outdatedResults = (await api('POST', 'api/restart-outdated')).results;
    renderOutdatedResults();
  } catch (e) {
    errorSheet(e);
  }
  afterChange();
}

// What the last "Restart outdated" did, so one that failed can be retried from the list.
let outdatedResults = [];
function renderOutdatedResults() {
  const rows = outdatedResults.map((x, i) => {
    if (x.busy) return `<li><div class="spinner tiny"></div><span><strong>${esc(x.name)}</strong> · ${x.trust ? 'trusting the folder and retrying…' : 'retrying…'}</span></li>`;
    if (x.ok) return `<li>${icon('check', 'ok')}<span><strong>${esc(x.name)}</strong> · restarted</span></li>`;
    return `<li>${icon(x.skipped ? 'alert' : 'x', x.skipped ? 'skip' : 'bad')}
      <span><strong>${esc(x.name)}</strong> · ${esc(x.reason)}
      <button class="btn small retry-row" data-act="retry-result" data-i="${i}" data-trust="${x.needsTrust ? '1' : ''}">${icon('restart')}${x.needsTrust ? 'I trust this folder, retry' : 'Retry'}</button></span></li>`;
  }).join('');
  const okCount = outdatedResults.filter((x) => x.ok).length;
  resultSheet({ ok: true, warn: okCount !== outdatedResults.length, title: `Restarted ${okCount} of ${outdatedResults.length}`, body: `<ul class="result-list">${rows}</ul>`, actions: claudeAppButton() });
}
async function retryResult(i, trust) {
  const x = outdatedResults[i];
  if (!x || x.busy) return;
  Object.assign(x, { busy: true, trust });
  renderOutdatedResults();
  try {
    const r = await api('POST', 'api/retry', { sessionId: x.sessionId, path: x.cwd, trust });
    Object.assign(x, { busy: false, ok: r.started, skipped: false, needsTrust: false, reason: r.started ? null : NOT_STARTED });
  } catch (e) {
    Object.assign(x, { busy: false, ok: false, skipped: !!e.data.notIdle, needsTrust: !!e.data.needsTrust, reason: e.message });
  }
  if (sheetOpen) renderOutdatedResults();
  afterChange();
}

/** Retry from a "Not started yet" result or a card on the Running tab. */
async function retrySession({ sessionId, pid, folder, trust = false }) {
  busySheet('Retrying…', trust ? 'Trusting the folder, then starting Claude again.' : 'Starting Claude again.');
  try {
    const r = await api('POST', 'api/retry', { sessionId, pid, path: folder || undefined, trust });
    startedSheet(r, r.alreadyRunning ? 'Already running' : 'Claude is running', 'Running in a desktop window', folder);
  } catch (e) {
    if (e.data.needsTrust && folder) return trustSheet(folder, 'retry-trust', `data-id="${esc(sessionId)}" data-path="${esc(folder)}" data-pid="${pid || ''}"`, 'Trust and retry');
    errorSheet(e);
  }
  afterChange();
}
function pendingRetry(pid) {
  const p = findPending(pid);
  if (!p) return;
  if (p.needsTrust) return trustSheet(p.cwd, 'retry-trust', `data-id="${esc(p.sessionId)}" data-path="${esc(p.cwd)}" data-pid="${p.pid}"`, 'Trust and retry');
  retrySession({ sessionId: p.sessionId, pid: p.pid, folder: p.cwd });
}

function afterChange() {
  refreshActive();
  if (state.tab === 'folders' && state.folder) {
    api('GET', `api/folders?${new URLSearchParams({ path: state.folder.path, ...(state.showHidden ? { hidden: '1' } : {}) })}`)
      .then((f) => { state.folder = f; if (state.tab === 'folders' && !sheetOpen) renderFolders(); })
      .catch(() => {});
  }
}

// ---------- settings ----------
function renderSettings() {
  const v = view();
  const d = state.me.desktop;
  v.innerHTML = `
    <div class="settings">
      <section class="panel">
        <h3>Change PIN</h3>
        <form data-form="pin" autocomplete="off">
          <div class="field"><label for="old">Current PIN</label><input class="text-input" id="old" name="oldPin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="12" required></div>
          <div class="field"><label for="new">New PIN (6–12 digits)</label><input class="text-input" id="new" name="newPin" type="password" inputmode="numeric" pattern="[0-9]*" minlength="6" maxlength="12" required></div>
          <div class="field"><label for="new2">New PIN again</label><input class="text-input" id="new2" name="newPin2" type="password" inputmode="numeric" pattern="[0-9]*" minlength="6" maxlength="12" required></div>
          <p class="form-error" data-error></p>
          <button class="btn primary block" type="submit">Save new PIN</button>
        </form>
      </section>
      <section class="panel">
        <h3>Folders</h3>
        <label class="switch-row"><span>Show hidden folders (starting with “.”)</span>
          <input class="switch" type="checkbox" data-act="toggle-hidden" ${state.showHidden ? 'checked' : ''}></label>
      </section>
      <section class="panel">
        <h3>Status</h3>
        <dl class="kv">
          <dt>Desktop</dt><dd>${d.ok ? `${esc(d.desktop || 'running')}, display ${esc(d.display)}` : 'not running'}</dd>
          <dt>Terminal</dt><dd>${d.ok ? esc(d.terminal) : esc(d.terminal || '—')}</dd>
          <dt>Claude installed</dt><dd>v${esc((state.active && state.active.installedVersion) || state.me.installedVersion || '?')}</dd>
          <dt>Top folder</dt><dd class="mono">${esc(state.me.root)}</dd>
        </dl>
      </section>
      <button class="btn danger-ghost block" data-act="logout">${icon('logout')}Log out on this device</button>
    </div>`;
}
async function submitPin(form) {
  const err = form.querySelector('[data-error]');
  err.className = 'form-error';
  if (form.newPin.value !== form.newPin2.value) {
    err.textContent = 'The two new PINs do not match.';
    return;
  }
  try {
    await api('POST', 'api/pin', { oldPin: form.oldPin.value, newPin: form.newPin.value });
    form.reset();
    err.className = 'form-ok';
    err.textContent = 'PIN changed. Other devices have been logged out.';
  } catch (e) {
    err.textContent = e.message;
  }
}

// ---------- events ----------
async function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (el.tagName === 'INPUT') return; // switches use change
  switch (act) {
    case 'reload': location.reload(); break;
    case 'tab': setTab(el.dataset.tab); break;
    case 'open': if (!el.classList.contains('current')) openFolder(el.dataset.path); break;
    case 'new-folder': sheetNewFolder(); break;
    case 'rename': sheetRename(el.dataset.path, el.dataset.name); break;
    case 'rename-confirm': submitRename(el.closest('form'), true); break;
    case 'new-claude': sheetNewClaude(); break;
    case 'resume-list': sheetResumeList(); break;
    case 'resume-pick': sheetResumeConfirm(el.dataset.id); break;
    case 'resume-back': sheetResumeList(); break;
    case 'resume-go': resumeGo(el.dataset.id); break;
    case 'resume-trust': resumeGo(el.dataset.id, true); break;
    case 'goto-running': closeSheet(); setTab('running'); break;
    case 'restart': sheetRestart(el.dataset.pid); break;
    case 'restart-go': restartGo(el.dataset.pid, el.dataset.unknown === '1'); break;
    case 'close': sheetClose(el.dataset.pid); break;
    case 'close-go': closeGo(el.dataset.pid, el.dataset.force === '1'); break;
    case 'restart-trust': restartGo(el.dataset.pid, el.dataset.unknown === '1', true); break;
    case 'retry-result': retryResult(Number(el.dataset.i), el.dataset.trust === '1'); break;
    case 'retry-session': retrySession({ sessionId: el.dataset.id, folder: el.dataset.path }); break;
    case 'retry-trust': retrySession({ sessionId: el.dataset.id, folder: el.dataset.path, pid: Number(el.dataset.pid) || undefined, trust: true }); break;
    case 'pending-retry': pendingRetry(el.dataset.pid); break;
    case 'changelog': sheetChangelog(); break;
    case 'restart-outdated': sheetRestartOutdated(); break;
    case 'restart-outdated-go': restartOutdatedGo(); break;
    case 'sheet-close': closeSheet(); break;
    case 'logout':
      await api('POST', 'api/logout').catch(() => {});
      renderLogin();
      break;
    default: break;
  }
}
app.addEventListener('click', onClick);
sheetRoot.addEventListener('click', onClick);

for (const root of [app, sheetRoot]) {
  root.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    ({ login: submitLogin, 'set-pin': submitSetPin, 'new-folder': submitNewFolder, rename: submitRename, 'new-claude': submitNewClaude, pin: submitPin })[form.dataset.form]?.(form);
  });
}
app.addEventListener('input', (e) => {
  if (e.target.matches('[data-filter]')) applyFilter(e.target);
});
app.addEventListener('change', (e) => {
  if (e.target.dataset.act === 'toggle-hidden') {
    state.showHidden = e.target.checked;
    store.set('sd.hidden', state.showHidden ? '1' : '0');
    if (state.folder) openFolder(state.folder.path, { history: 'none' }).then(() => setTab('settings'));
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheetOpen) closeSheet();
});

// Android back: close an open sheet first, otherwise go back up the folder history.
window.addEventListener('popstate', (e) => {
  if (ignorePop) { ignorePop = false; return; }
  if (sheetOpen) { closeSheet(true); return; }
  const p = e.state && e.state.path;
  if (p && state.me) {
    if (state.tab !== 'folders') { state.tab = 'folders'; renderChrome(); }
    openFolder(p, { history: 'none' });
  }
});

// Keep the Running tab live; check less often when it is not on screen.
let tick = 0;
setInterval(() => {
  if (!state.me || document.visibilityState !== 'visible') return;
  tick++;
  if (state.tab === 'running' || tick % 5 === 0) refreshActive();
}, 4000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.me) refreshActive();
});

boot();
