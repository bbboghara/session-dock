// PIN login. The PIN is stored only as a scrypt hash. A successful login gives
// the phone a long-lived random token (kept in an HttpOnly cookie); only a
// SHA-256 of each token is stored, so the auth file never holds a usable secret.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };
const MAX_TOKENS = 20;
const FREE_ATTEMPTS = 5; // wrong PINs allowed before a lockout starts
const LOCK_BASE_MS = 30_000;
const LOCK_MAX_MS = 15 * 60_000;
const RUNS = ['0123456789'.repeat(3), '9876543210'.repeat(3)];

/** Why this can't be a new PIN, or null if it's fine. A PIN you already have keeps working. */
export function pinProblem(pin) {
  if (typeof pin !== 'string' || !/^\d{6,12}$/.test(pin)) return 'A PIN must be 6 to 12 digits.';
  if (/^(\d)\1+$/.test(pin) || RUNS.some((r) => r.includes(pin))) {
    return 'That PIN is too easy to guess. Avoid repeated digits and runs like 123456.';
  }
  return null;
}

export function hashPin(pin, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(pin), salt, 32, SCRYPT_OPTS);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPin(pin, stored) {
  const [kind, saltB64, hashB64] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(String(pin), Buffer.from(saltB64, 'base64'), expected.length, SCRYPT_OPTS);
  return crypto.timingSafeEqual(got, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function writeAuth(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Saves a PIN you chose (install.sh). It replaces everything else in the file,
 * so every device is signed out and any lockout ends.
 */
export function setPinFile(file, pin, firstPinFile = null) {
  const problem = pinProblem(pin);
  if (problem) throw new Error(problem);
  writeAuth(file, { pinHash: hashPin(pin), pinIsDefault: false, tokens: [] });
  if (firstPinFile) fs.rmSync(firstPinFile, { force: true });
}

export class AuthStore {
  /**
   * If there is no auth file yet, a temporary random PIN is made and written to
   * firstPinFile (readable only by you). pinIsDefault stays true, and the server
   * allows nothing else, until you replace it with your own.
   */
  constructor(file, { firstPinFile = null, now = () => Date.now() } = {}) {
    this.file = file;
    this.firstPinFile = firstPinFile;
    this.now = now;
    this.data = this.#load();
  }

  #load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d && d.pinHash) return { tokens: [], ...d };
    } catch (e) {
      if (e.code !== 'ENOENT') throw e; // never silently reset a damaged auth file
    }
    const pin = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    const d = { pinHash: hashPin(pin), pinIsDefault: true, tokens: [] };
    writeAuth(this.file, d);
    if (this.firstPinFile) fs.writeFileSync(this.firstPinFile, `${pin}\n`, { mode: 0o600 });
    return d;
  }

  #save() {
    writeAuth(this.file, this.data);
  }

  get pinIsDefault() {
    return !!this.data.pinIsDefault;
  }

  /**
   * Lockouts are saved, so restarting the server doesn't reset them. Signing in
   * and changing the PIN count separately, so wrong guesses at the public login
   * can't stop a signed-in device from changing the PIN.
   */
  #lock(kind) {
    this.data.locks ??= {};
    return (this.data.locks[kind] ??= { failures: 0, count: 0, until: 0 });
  }

  #checkPin(pin, kind) {
    const lock = this.#lock(kind);
    const wait = Math.min(lock.until - this.now(), LOCK_MAX_MS); // capped in case the clock moved back
    if (wait > 0) return { ok: false, lockedMs: wait };
    if (verifyPin(pin, this.data.pinHash)) {
      Object.assign(lock, { failures: 0, count: 0, until: 0 });
      return { ok: true };
    }
    lock.failures++;
    let result = { ok: false, attemptsLeft: FREE_ATTEMPTS - lock.failures };
    if (lock.failures >= FREE_ATTEMPTS) {
      const ms = Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** lock.count);
      Object.assign(lock, { failures: 0, count: lock.count + 1, until: this.now() + ms });
      result = { ok: false, lockedMs: ms };
    }
    this.#save();
    return result;
  }

  login(pin, userAgent = '') {
    const r = this.#checkPin(pin, 'login');
    if (!r.ok) return r;
    const token = crypto.randomBytes(32).toString('base64url');
    const t = this.now();
    this.data.tokens.push({ hash: sha256(token), created: t, lastUsed: t, ua: String(userAgent).slice(0, 160) });
    this.data.tokens = this.data.tokens.slice(-MAX_TOKENS);
    this.#save();
    return { ok: true, token };
  }

  validate(token) {
    if (!token || typeof token !== 'string') return false;
    const h = sha256(token);
    const entry = this.data.tokens.find((t) => t.hash === h);
    if (!entry) return false;
    const t = this.now();
    if (t - entry.lastUsed > 3600_000) {
      entry.lastUsed = t; // refreshed at most hourly to avoid constant writes
      this.#save();
    }
    return true;
  }

  logout(token) {
    if (!token) return;
    const h = sha256(token);
    this.data.tokens = this.data.tokens.filter((t) => t.hash !== h);
    this.#save();
  }

  /** Changes the PIN and signs out every other device. */
  changePin(currentToken, oldPin, newPin) {
    const problem = pinProblem(newPin);
    if (problem) return { ok: false, error: problem };
    // Replacing the temporary PIN: it was just entered to sign in, so it isn't asked for again.
    if (!this.pinIsDefault) {
      const r = this.#checkPin(oldPin, 'change');
      if (!r.ok) return { ok: false, error: r.lockedMs ? 'Too many wrong PINs. Try again later.' : 'Old PIN is wrong.', ...r };
    }
    if (verifyPin(newPin, this.data.pinHash)) return { ok: false, error: 'The new PIN must be different from the current one.' };
    const keep = sha256(currentToken || '');
    this.data.pinHash = hashPin(newPin);
    this.data.pinIsDefault = false;
    this.data.tokens = this.data.tokens.filter((t) => t.hash === keep);
    delete this.data.locks;
    this.#save();
    if (this.firstPinFile) fs.rmSync(this.firstPinFile, { force: true });
    return { ok: true };
  }
}
