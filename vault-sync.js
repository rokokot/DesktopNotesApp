/* ======================================================================
 * Bidirectional sync between the canvas store and an Obsidian vault folder.
 *
 * Each canvas note materialises as a .md file under the user-chosen vault
 * folder, organised into subdirectories named after the canvas folder.
 * YAML front-matter carries the canvas-only metadata (id, color, x/y/w/h,
 * pinned, z, folder-id) so a round-trip preserves spatial layout.
 *
 * Direction 1 — canvas → vault:
 *   syncStoreToVault(store) on every save. Diffs against the last-seen
 *   id→path map: writes changed notes, moves notes whose folder/title
 *   changed (delete-old + write-new), deletes notes that were removed.
 *
 * Direction 2 — vault → canvas:
 *   chokidar watches the vault folder. add/change/unlink events parse
 *   front-matter and dispatch to a registered listener (the main process
 *   forwards to the renderer via IPC).
 *
 * Echo guard:
 *   Every write we make stamps a `recentWrites` map. Watcher events for
 *   stamped paths within ECHO_WINDOW_MS are ignored — without this the
 *   chain "canvas save → write file → watcher fires → renderer sets state
 *   → canvas save" would loop forever.
 * ====================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const chokidar = require('chokidar');

const ECHO_WINDOW_MS = 2500;

let vaultPath = null;        // absolute path the user picked
let vaultRoot = null;        // walked-up Obsidian vault root (folder containing .obsidian/), or null
let watcher = null;
let onVaultChange = () => {}; // (event) => void, set by setOnVaultChange

const idToPath = new Map();   // noteId → absolute file path (current truth)
const pathToId = new Map();   // absolute file path → noteId (reverse lookup)
const recentWrites = new Map(); // absolute path → timestamp
// Per-path snapshot of the *semantic* content that's on disk (body + the
// front-matter fields the canvas tracks). Updated whenever we read or
// write a file. Used by syncStoreToVault to skip a write when the canvas
// note already matches the disk — without this, every keystroke in
// Obsidian triggers a return-trip write, which makes Obsidian reload the
// file and stutters the cursor.
const lastSeenTuple = new Map();

function setOnVaultChange(cb) { onVaultChange = typeof cb === 'function' ? cb : () => {}; }

function getVaultPath() { return vaultPath; }
function isEnabled() { return !!vaultPath; }

/* -------------------------------------------------------------------- */
/* Filename + path helpers                                              */
/* -------------------------------------------------------------------- */

// Replace characters that are illegal or hostile across the three big
// platforms (and inside Obsidian's link parser). Collapse whitespace,
// trim dots+spaces from the ends (Windows hates trailing dots).
function sanitizeForFilename(name) {
  if (!name) return '';
  return String(name)
    .replace(/[\\/:*?"<>|#^[\]]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 120);
}

function noteFilename(note) {
  const base = sanitizeForFilename(note.title) || note.id;
  return base + '.md';
}

function folderDirName(folder) {
  // 'root' is the canvas's "All notes" — files live at the vault root, no
  // subdirectory. Any other folder maps to a subdir named after its display
  // name (sanitized).
  if (!folder || folder.id === 'root') return null;
  return sanitizeForFilename(folder.name) || folder.id;
}

function desiredPathFor(note, folders) {
  if (!vaultPath) return null;
  const folder = folders[note.folder];
  const dir = folderDirName(folder);
  return dir ? path.join(vaultPath, dir, noteFilename(note))
             : path.join(vaultPath, noteFilename(note));
}

// Resolve duplicate filenames by appending the note id when the desired
// path is already claimed by a different note.
function dedupePath(p, noteId) {
  const claimedBy = pathToId.get(p);
  if (!claimedBy || claimedBy === noteId) return p;
  const ext = path.extname(p);
  const base = p.slice(0, -ext.length);
  return `${base} (${noteId})${ext}`;
}

/* -------------------------------------------------------------------- */
/* Front-matter (minimal flat YAML)                                      */
/* -------------------------------------------------------------------- */

const FRONT_MATTER_KEYS = ['id', 'folder', 'color', 'x', 'y', 'w', 'h', 'pinned', 'z'];

function serializeFrontMatter(note) {
  const lines = ['---'];
  for (const k of FRONT_MATTER_KEYS) {
    if (note[k] === undefined || note[k] === null) continue;
    const v = note[k];
    let line;
    if (typeof v === 'number')      line = `${k}: ${v}`;
    else if (typeof v === 'boolean') line = `${k}: ${v}`;
    else                             line = `${k}: ${String(v).replace(/\n/g, ' ')}`;
    lines.push(line);
  }
  lines.push('---');
  return lines.join('\n');
}

// Returns { meta, body } or null if no front-matter detected.
function parseFrontMatter(raw) {
  if (typeof raw !== 'string') return null;
  if (!raw.startsWith('---')) return { meta: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: raw };
  const fmBlock = raw.slice(3, end).replace(/^\r?\n/, '');
  const after = raw.slice(end + 4).replace(/^\r?\n/, '');
  const meta = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1]; let v = m[2].trim();
    if (v === '') continue;
    if (v === 'true')       meta[k] = true;
    else if (v === 'false') meta[k] = false;
    else if (/^-?\d+(\.\d+)?$/.test(v)) meta[k] = Number(v);
    else                                meta[k] = v;
  }
  return { meta, body: after };
}

function fileContentForNote(note) {
  const fm = serializeFrontMatter(note);
  const body = note.body || '';
  return `${fm}\n\n${body}`;
}

/* -------------------------------------------------------------------- */
/* Semantic tuple — the subset of a note that ends up in the .md file.  */
/* If the canvas tuple matches the on-disk tuple, the file is already   */
/* in the desired state and we skip the write entirely.                  */
/* -------------------------------------------------------------------- */

function tupleFromNote(note) {
  return {
    body:   note.body || '',
    folder: note.folder ?? null,
    color:  note.color ?? null,
    x: typeof note.x === 'number' ? note.x : null,
    y: typeof note.y === 'number' ? note.y : null,
    w: typeof note.w === 'number' ? note.w : null,
    h: typeof note.h === 'number' ? note.h : null,
    pinned: !!note.pinned,
    z: typeof note.z === 'number' ? note.z : null,
  };
}

function tupleFromFileData({ meta, body }) {
  return {
    body:   body || '',
    folder: meta?.folder ?? null,
    color:  meta?.color  ?? null,
    x: typeof meta?.x === 'number' ? meta.x : null,
    y: typeof meta?.y === 'number' ? meta.y : null,
    w: typeof meta?.w === 'number' ? meta.w : null,
    h: typeof meta?.h === 'number' ? meta.h : null,
    pinned: !!meta?.pinned,
    z: typeof meta?.z === 'number' ? meta.z : null,
  };
}

function tuplesEqual(a, b) {
  if (!a || !b) return false;
  return a.body === b.body
      && a.folder === b.folder
      && a.color === b.color
      && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
      && a.pinned === b.pinned
      && a.z === b.z;
}

/* -------------------------------------------------------------------- */
/* Echo guard                                                           */
/* -------------------------------------------------------------------- */

function stampWrite(p) {
  recentWrites.set(p, Date.now());
}

function isEcho(p) {
  const t = recentWrites.get(p);
  if (!t) return false;
  if (Date.now() - t < ECHO_WINDOW_MS) return true;
  recentWrites.delete(p);
  return false;
}

function pruneOldWrites() {
  const now = Date.now();
  for (const [p, t] of recentWrites) {
    if (now - t > ECHO_WINDOW_MS) recentWrites.delete(p);
  }
}

/* -------------------------------------------------------------------- */
/* Canvas → Vault                                                       */
/* -------------------------------------------------------------------- */

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeNoteFile(p, note) {
  ensureDirFor(p);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, fileContentForNote(note), 'utf8');
  fs.renameSync(tmp, p);
  stampWrite(p);
  lastSeenTuple.set(p, tupleFromNote(note));
}

function deleteNoteFile(p) {
  try {
    if (fs.existsSync(p)) {
      stampWrite(p); // unlink event will fire and we want to ignore it
      fs.unlinkSync(p);
    }
  } catch (err) {
    console.warn('[vault-sync] delete failed:', p, err.message);
  }
  lastSeenTuple.delete(p);
  // Best-effort: remove parent directory if it's now empty AND not the
  // vault root itself.
  try {
    const parent = path.dirname(p);
    if (parent !== vaultPath && fs.existsSync(parent)
        && fs.readdirSync(parent).length === 0) {
      fs.rmdirSync(parent);
    }
  } catch {}
}

// Diff the new store against the last-known id→path map and apply writes.
// `store` shape: { notes, folders }.
function syncStoreToVault(store) {
  if (!vaultPath || !store) return { written: 0, deleted: 0 };
  const notes = Array.isArray(store.notes) ? store.notes : [];
  const folders = store.folders || {};

  pruneOldWrites();

  const seenIds = new Set();
  let written = 0, deleted = 0;

  // First pass: figure out where each note SHOULD live, tracking taken paths.
  const desiredFor = new Map();   // id → desired path
  const pendingClaims = new Map(); // path → id (so dedupe sees in-flight claims)
  for (const note of notes) {
    if (!note || !note.id) continue;
    let want = desiredPathFor(note, folders);
    if (!want) continue;
    // Resolve collisions against already-claimed paths from this same pass.
    while (pendingClaims.has(want) && pendingClaims.get(want) !== note.id) {
      want = (() => {
        const ext = path.extname(want);
        const base = want.slice(0, -ext.length);
        return `${base} (${note.id})${ext}`;
      })();
    }
    pendingClaims.set(want, note.id);
    desiredFor.set(note.id, want);
  }

  // Second pass: write changed/moved files.
  for (const note of notes) {
    if (!note || !note.id) continue;
    seenIds.add(note.id);
    const want = desiredFor.get(note.id);
    if (!want) continue;
    const previous = idToPath.get(note.id);
    const content = fileContentForNote(note);
    let needsWrite = true;
    if (previous && previous !== want) {
      // Note moved (folder rename, title rename, or folder change). Write
      // to new location first, then delete the old file — safer order if
      // the process dies mid-step.
      writeNoteFile(want, note);
      written++;
      needsWrite = false;
      deleteNoteFile(previous);
      pathToId.delete(previous);
    }
    if (needsWrite) {
      // Semantic short-circuit: if the disk tuple already matches what
      // we'd write, skip. Pure-text comparison would still differ here
      // (Obsidian re-serialises front-matter, trailing newlines, etc.)
      // and that mismatch is what causes the cursor-jump loop while
      // typing in Obsidian.
      const desired = tupleFromNote(note);
      const onDisk  = lastSeenTuple.get(want);
      if (!tuplesEqual(desired, onDisk)) {
        writeNoteFile(want, note);
        written++;
      }
    }
    idToPath.set(note.id, want);
    pathToId.set(want, note.id);
  }

  // Third pass: delete files for notes that are gone.
  for (const [id, p] of [...idToPath]) {
    if (!seenIds.has(id)) {
      deleteNoteFile(p);
      idToPath.delete(id);
      pathToId.delete(p);
      deleted++;
    }
  }

  return { written, deleted };
}

/* -------------------------------------------------------------------- */
/* Vault → Canvas                                                       */
/* -------------------------------------------------------------------- */

function readNoteFromFile(absPath) {
  let raw;
  try { raw = fs.readFileSync(absPath, 'utf8'); }
  catch { return null; }
  const parsed = parseFrontMatter(raw);
  if (!parsed) return null;
  const titleFromName = path.basename(absPath, '.md');
  return {
    meta: parsed.meta || {},
    body: (parsed.body || '').replace(/^\s+|\s+$/g, ''),
    titleFromName,
  };
}

function dispatchAddOrChange(absPath, kind) {
  if (isEcho(absPath)) return;
  const data = readNoteFromFile(absPath);
  if (!data) return;
  // Refresh the on-disk tuple cache before any dispatch so the canvas
  // side's next save can short-circuit if its state already matches.
  lastSeenTuple.set(absPath, tupleFromFileData(data));
  const id = data.meta.id || pathToId.get(absPath);
  if (id) {
    pathToId.set(absPath, id);
    idToPath.set(id, absPath);
    onVaultChange({
      type: 'note-changed',
      noteId: id,
      patch: {
        title: data.titleFromName,
        body:  data.body,
        ...pickValid(data.meta, ['folder', 'color', 'x', 'y', 'w', 'h', 'pinned', 'z']),
      },
      path: absPath,
    });
  } else if (kind === 'add') {
    // New file the user created in Obsidian — birth a fresh canvas note.
    onVaultChange({
      type: 'note-added',
      note: {
        title: data.titleFromName,
        body:  data.body,
        meta:  pickValid(data.meta, ['folder', 'color', 'x', 'y', 'w', 'h', 'pinned', 'z']),
      },
      path: absPath,
    });
  }
}

function dispatchUnlink(absPath) {
  if (isEcho(absPath)) return;
  lastSeenTuple.delete(absPath);
  const id = pathToId.get(absPath);
  if (!id) return;
  pathToId.delete(absPath);
  idToPath.delete(id);
  onVaultChange({ type: 'note-deleted', noteId: id, path: absPath });
}

function pickValid(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/* -------------------------------------------------------------------- */
/* Watcher lifecycle                                                    */
/* -------------------------------------------------------------------- */

function startWatcher() {
  if (watcher) return;
  watcher = chokidar.watch(vaultPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
    ignored: (p) => {
      const base = path.basename(p);
      // Ignore dotfiles/dirs (.obsidian/, .git/, .DS_Store) and our own
      // .tmp write-then-rename atoms.
      return base.startsWith('.') || base.endsWith('.tmp');
    },
    depth: 8,
  });
  watcher.on('add',    (p) => { if (p.endsWith('.md')) dispatchAddOrChange(p, 'add'); });
  watcher.on('change', (p) => { if (p.endsWith('.md')) dispatchAddOrChange(p, 'change'); });
  watcher.on('unlink', (p) => { if (p.endsWith('.md')) dispatchUnlink(p); });
  watcher.on('error',  (err) => console.warn('[vault-sync] watcher error:', err && err.message));
}

function stopWatcher() {
  if (!watcher) return;
  watcher.close().catch(() => {});
  watcher = null;
}

/* -------------------------------------------------------------------- */
/* Vault root + Obsidian URI                                            */
/* -------------------------------------------------------------------- */

// Walk up from the chosen folder until we find a sibling .obsidian/ dir
// (the convention for Obsidian vault roots). If found, returns
// { root, name }. Else returns null and we fall back to opening the file
// directly via the OS handler.
function findVaultRoot(start) {
  let cur = start;
  for (let i = 0; i < 12; i++) {
    try {
      if (fs.existsSync(path.join(cur, '.obsidian'))) {
        return { root: cur, name: path.basename(cur) };
      }
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

function openInObsidianURIFor(noteId) {
  const filePath = idToPath.get(noteId);
  if (!filePath || !vaultPath) return null;
  if (vaultRoot) {
    const rel = path.relative(vaultRoot.root, filePath).replace(/\\/g, '/');
    const noExt = rel.replace(/\.md$/i, '');
    const params = new URLSearchParams({ vault: vaultRoot.name, file: noExt });
    return `obsidian://open?${params.toString()}`;
  }
  return null; // caller falls back to shell.openPath(filePath)
}

function getNoteFilePath(noteId) { return idToPath.get(noteId) || null; }

/* -------------------------------------------------------------------- */
/* Initial connect / disconnect                                         */
/* -------------------------------------------------------------------- */

// Walk the vault, populate id↔path + tuple maps, and return every .md
// file the renderer should reconcile against on initial connect.
// Returning files (rather than dispatching push events) sidesteps a
// startup race where main fires `vault:change` before the renderer's
// listener is registered — the events would be silently dropped.
function scanVault() {
  idToPath.clear();
  pathToId.clear();
  lastSeenTuple.clear();
  const out = [];
  if (!vaultPath || !fs.existsSync(vaultPath)) return out;
  const stack = [vaultPath];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { stack.push(full); continue; }
      if (!ent.name.endsWith('.md')) continue;
      const data = readNoteFromFile(full);
      if (!data) continue;
      lastSeenTuple.set(full, tupleFromFileData(data));
      const id = data.meta.id;
      if (id) {
        idToPath.set(id, full);
        pathToId.set(full, id);
      }
      out.push({
        path: full,
        meta: data.meta,
        body: data.body,
        titleFromName: data.titleFromName,
      });
    }
  }
  return out;
}

function setVault(absPath) {
  stopWatcher();
  if (!absPath) {
    vaultPath = null;
    vaultRoot = null;
    idToPath.clear();
    pathToId.clear();
    recentWrites.clear();
    lastSeenTuple.clear();
    return { ok: true, vaultRoot: null, files: [] };
  }
  if (!fs.existsSync(absPath)) {
    return { ok: false, error: `Folder does not exist: ${absPath}` };
  }
  vaultPath = absPath;
  vaultRoot = findVaultRoot(absPath);
  recentWrites.clear();
  const files = scanVault();
  startWatcher();
  return { ok: true, vaultRoot, files };
}

function clearVault() { return setVault(null); }

module.exports = {
  setVault,
  clearVault,
  isEnabled,
  getVaultPath,
  syncStoreToVault,
  setOnVaultChange,
  openInObsidianURIFor,
  getNoteFilePath,
};
