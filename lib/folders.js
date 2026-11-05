// Folder browsing, creating and renaming, always kept inside ROOT (your home
// folder unless SD_ROOT says otherwise). Paths are checked after resolving
// symlinks, so a link that points outside ROOT cannot be used to escape it.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './util.js';

export function isInside(root, p) {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Resolves a user-supplied path to a real, existing directory inside root. */
export async function resolveDir(root, p) {
  if (typeof p !== 'string' || !p.trim()) throw new HttpError(400, 'Folder path is required.');
  const abs = path.resolve(root, p);
  if (!isInside(root, abs)) throw new HttpError(403, 'That folder is outside the folders this app can use.');
  let real;
  try {
    real = await fsp.realpath(abs);
  } catch {
    throw new HttpError(404, 'Folder not found.');
  }
  if (!isInside(root, real)) throw new HttpError(403, 'That folder links outside the folders this app can use.');
  const st = await fsp.stat(real);
  if (!st.isDirectory()) throw new HttpError(400, 'That is not a folder.');
  return real;
}

/**
 * If p is itself a symlink to a folder inside root, its path with the parent
 * folder resolved. Null if it isn't a link. Renaming a link has to rename the
 * link, not move the folder it points to. Links to anything else are refused,
 * as they are everywhere else in the app.
 */
export async function linkPath(root, p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const abs = path.resolve(root, p);
  try {
    if (!(await fsp.lstat(abs)).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  await resolveDir(root, abs);
  return path.join(await resolveDir(root, path.dirname(abs)), path.basename(abs));
}

/** Returns a cleaned folder name or throws a readable error. */
export function validateName(name) {
  if (typeof name !== 'string') throw new HttpError(400, 'Folder name is required.');
  const n = name.trim();
  if (!n) throw new HttpError(400, 'Folder name is required.');
  if (n === '.' || n === '..') throw new HttpError(400, 'That name is not allowed.');
  if (n.includes('/')) throw new HttpError(400, 'Folder names cannot contain "/".');
  if (/[\x00-\x1f\x7f]/.test(n)) throw new HttpError(400, 'Folder names cannot contain control characters.');
  if (Buffer.byteLength(n) > 255) throw new HttpError(400, 'Folder name is too long.');
  return n;
}

export async function listSubfolders(dir, { showHidden = false } = {}) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    throw new HttpError(e.code === 'EACCES' ? 403 : 500, `Cannot open folder (${e.code}).`);
  }
  const out = [];
  for (const d of entries) {
    if (!showHidden && d.name.startsWith('.')) continue;
    const full = path.join(dir, d.name);
    let isDir = d.isDirectory();
    const isLink = d.isSymbolicLink();
    if (isLink || (!isDir && !d.isFile())) {
      // Symlinks and filesystems that don't report the type (FUSE) need a stat.
      try {
        isDir = (await fsp.stat(full)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) out.push({ name: d.name, path: full, hidden: d.name.startsWith('.'), link: isLink });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  return out;
}

export async function createFolder(parent, name) {
  const n = validateName(name);
  const target = path.join(parent, n);
  try {
    await fsp.mkdir(target, { mode: 0o755 });
  } catch (e) {
    if (e.code === 'EEXIST') throw new HttpError(409, `"${n}" already exists here.`);
    throw new HttpError(500, `Could not create folder (${e.code}).`);
  }
  return target;
}

/**
 * Renames src to newName in the same parent. `protectedPaths` are folders that
 * must never move (home, ~/apps, this app's own folder and anything above it).
 */
export async function renameFolder(src, newName, { protectedPaths = [] } = {}) {
  const n = validateName(newName);
  for (const p of protectedPaths) {
    if (src === p || isInside(src, p)) {
      throw new HttpError(403, 'This folder cannot be renamed from the app (other things depend on it).');
    }
  }
  const dest = path.join(path.dirname(src), n);
  if (dest === src) return dest;
  if (fs.existsSync(dest)) throw new HttpError(409, `"${n}" already exists here.`);
  try {
    await fsp.rename(src, dest);
  } catch (e) {
    throw new HttpError(500, `Could not rename (${e.code}).`);
  }
  return dest;
}

export function breadcrumbs(root, dir, rootLabel = 'Home') {
  const crumbs = [{ name: rootLabel, path: root }];
  if (dir === root) return crumbs;
  let acc = root;
  for (const part of path.relative(root, dir).split(path.sep)) {
    acc = path.join(acc, part);
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}
