const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { load: loadNotes, save: saveNotes } = require('./storage.js');
const vaultSync = require('./vault-sync.js');

// Force a deterministic Wayland app_id / X11 WM_CLASS so GNOME can match
// the running window to its .desktop launcher and show the correct icon
// in the dash-to-dock / Activities. Must be set before app.whenReady().
// Value matches the StartupWMClass in flatpak/*.desktop and the local
// launcher we install for development.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('class', 'desktop-notes-app');
}

// Synchronous IPC for the preload script to fetch the running app's version
// at load time, so the renderer can compare it to whatever the GitHub
// Releases API reports as the latest tag.
ipcMain.on('app:version-sync', (e) => { e.returnValue = app.getVersion(); });

// Open external URLs (e.g. the release download link) in the user's default
// browser instead of inside the Electron BrowserWindow.
ipcMain.handle('shell:open-external', async (_e, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false };
  try { await shell.openExternal(url); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

const userDataDir = () => app.getPath('userData');
const notesPath   = () => path.join(userDataDir(), 'notes.json');
const windowPath  = () => path.join(userDataDir(), 'window.json');

// One-time migration: this fork was renamed to "desktop-notes-app" which
// moved userData to ~/.config/desktop-notes-app/. Earlier package names
// were "sticky-notes" and "sticky-notes-canvas". On first launch, if
// there's no notes.json in the new path but one exists under any of the
// older names, copy notes.json + window.json over so users don't lose
// their data on upgrade. Snap/flatpak installs are sandboxed and won't
// see the old paths either way.
function migrateLegacyUserData() {
  try {
    const newDir = userDataDir();
    const newNotes = path.join(newDir, 'notes.json');
    if (fs.existsSync(newNotes)) return;
    const parent = path.dirname(newDir);
    const legacyNames = ['sticky-notes-canvas', 'sticky-notes'];
    for (const name of legacyNames) {
      const legacyDir = path.join(parent, name);
      const legacyNotes = path.join(legacyDir, 'notes.json');
      if (!fs.existsSync(legacyNotes)) continue;
      fs.mkdirSync(newDir, { recursive: true });
      fs.copyFileSync(legacyNotes, newNotes);
      const legacyWin = path.join(legacyDir, 'window.json');
      if (fs.existsSync(legacyWin)) {
        fs.copyFileSync(legacyWin, path.join(newDir, 'window.json'));
      }
      console.log(`[main] migrated userData from ${legacyDir} → ${newDir}`);
      return;
    }
  } catch (err) {
    console.warn('[main] userData migration failed:', err.message);
  }
}

let mainWindow = null;
let pendingSave = null;
let isQuitting  = false;
// Set true when the main window starts closing OR the app is quitting, so
// the popouts' `closed` handlers don't strip them from the persisted open
// list — popouts that were open at quit time should reopen on next launch.
let isShuttingDown = false;

// Last-known notes store, kept in sync via `notes:save` and `popout:edit`.
// Lets popout windows fetch their note data without round-tripping to the
// renderer (and works even before the canvas window has finished loading).
let currentNotesStore = null;
const popoutWindows = new Map();

function loadCurrentStore() {
  if (currentNotesStore) return currentNotesStore;
  currentNotesStore = loadNotes(notesPath());
  return currentNotesStore;
}

function popoutsStatePath() { return path.join(userDataDir(), 'popouts.json'); }

function loadPopoutsState() {
  try {
    if (fs.existsSync(popoutsStatePath())) {
      const raw = JSON.parse(fs.readFileSync(popoutsStatePath(), 'utf8'));
      return { open: Array.isArray(raw.open) ? raw.open : [], bounds: raw.bounds || {} };
    }
  } catch (err) {
    console.warn('[main] failed to read popouts state:', err.message);
  }
  return { open: [], bounds: {} };
}

function savePopoutsState(state) {
  try {
    fs.mkdirSync(path.dirname(popoutsStatePath()), { recursive: true });
    fs.writeFileSync(popoutsStatePath(), JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn('[main] failed to save popouts state:', err.message);
  }
}

function getNoteById(noteId) {
  const store = loadCurrentStore();
  return (store.notes || []).find(n => n.id === noteId) || null;
}

function applyNotePatchToCache(noteId, patch) {
  const store = loadCurrentStore();
  if (!Array.isArray(store.notes)) return;
  store.notes = store.notes.map(n => n.id === noteId ? { ...n, ...patch } : n);
}

function createPopoutWindow(noteId) {
  if (typeof noteId !== 'string' || !noteId) return null;
  const existing = popoutWindows.get(noteId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return existing;
  }
  popoutWindows.delete(noteId);

  const note = getNoteById(noteId);
  if (!note) return null;

  const popState = loadPopoutsState();
  const saved = popState.bounds?.[noteId] || {};

  const win = new BrowserWindow({
    width:  saved.width  || Math.max(240, Math.round(note.w || 280)),
    height: saved.height || Math.max(180, Math.round(note.h || 220)),
    x: saved.x,
    y: saved.y,
    minWidth: 200,
    minHeight: 150,
    frame: false,
    transparent: true,
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    title: note.title || 'Sticky note',
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 'screen-saver' is the highest level Electron exposes — keeps the popout
  // above maximised/fullscreen apps. setVisibleOnAllWorkspaces makes the
  // window follow the user across virtual desktops on Linux/macOS.
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch {}
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}

  win.loadFile('index.html', { query: { popout: noteId } });

  popoutWindows.set(noteId, win);

  // Mark as open immediately. The renderer-side restore loop relies on
  // popouts.json `open` being authoritative across launches.
  const initState = loadPopoutsState();
  if (!initState.open.includes(noteId)) {
    initState.open = [...initState.open, noteId];
    savePopoutsState(initState);
  }

  let persistTimer = null;
  const persistBounds = () => {
    if (win.isDestroyed()) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const b = win.getBounds();
      const state = loadPopoutsState();
      state.bounds = { ...(state.bounds || {}), [noteId]: b };
      savePopoutsState(state);
    }, 250);
  };
  win.on('move', persistBounds);
  win.on('resize', persistBounds);

  win.on('closed', () => {
    popoutWindows.delete(noteId);
    if (isShuttingDown) return;
    const state = loadPopoutsState();
    state.open = (state.open || []).filter(id => id !== noteId);
    savePopoutsState(state);
  });

  return win;
}

function closeAllPopouts() {
  for (const win of popoutWindows.values()) {
    if (!win.isDestroyed()) win.close();
  }
}

function loadBounds() {
  try {
    if (fs.existsSync(windowPath())) {
      return JSON.parse(fs.readFileSync(windowPath(), 'utf8'));
    }
  } catch {}
  return { width: 1920, height: 1080 };
}

function saveBounds(b) {
  try {
    fs.mkdirSync(path.dirname(windowPath()), { recursive: true });
    fs.writeFileSync(windowPath(), JSON.stringify(b));
  } catch (err) {
    console.warn('[main] failed to save window bounds:', err.message);
  }
}

function createWindow() {
  const bounds = loadBounds();
  mainWindow = new BrowserWindow({
    width:  bounds.width  ?? 1920,
    height: bounds.height ?? 1080,
    x: bounds.x,
    y: bounds.y,
    minWidth:  800,
    minHeight: 600,
    backgroundColor: '#14181d',
    title: 'Sticky Notes',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile('index.html');

  mainWindow.webContents.once('did-finish-load', () => {
    // Reopen any popouts that were open last session. Each spawned window
    // pulls its note data via `popout:request-note` once it loads.
    const state = loadPopoutsState();
    for (const id of (state.open || [])) {
      // Skip silently if the note no longer exists — it'll be cleaned up
      // from the open list on the next user-initiated change.
      if (getNoteById(id)) createPopoutWindow(id);
    }
  });

  mainWindow.on('close', () => {
    isShuttingDown = true;
    closeAllPopouts();
    if (mainWindow) saveBounds(mainWindow.getBounds());
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const prefsItem = {
    label: 'Preferences…',
    accelerator: 'CmdOrCtrl+,',
    click: () => mainWindow?.webContents.send('menu:preferences'),
  };
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        prefsItem,
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        ...(isMac ? [] : [prefsItem, { type: 'separator' }]),
        {
          label: 'Import notes from image using your AI…',
          click: () => mainWindow?.webContents.send('menu:importHelp'),
        },
        { type: 'separator' },
        {
          label: 'Save backup…',
          click: () => mainWindow?.webContents.send('menu:export'),
        },
        {
          label: 'Restore backup…',
          click: () => mainWindow?.webContents.send('menu:import'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut'  }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ]},
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ]},
    { role: 'help', submenu: [
      // "Check for Updates…" is hidden under snap/flatpak — those channels
      // get updates via their store (snapd, flatpak software center) and
      // shouldn't surface a redundant in-app update button.
      ...(process.env.SNAP_NAME || process.env.FLATPAK_ID ? [] : [
        {
          label: 'Check for Updates…',
          click: () => mainWindow?.webContents.send('menu:checkUpdates'),
        },
        { type: 'separator' },
      ]),
      {
        label: 'About',
        click: () => mainWindow?.webContents.send('menu:about'),
      },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('notes:load', async () => {
  return loadCurrentStore();
});

ipcMain.handle('notes:save', async (_e, data, opts) => {
  pendingSave = { data };
  try {
    saveNotes(notesPath(), data);
    currentNotesStore = data;
    pendingSave = null;
    // Skip vault export only when the renderer explicitly asks (used for
    // the very first save after `notes:load`, which can fire before
    // the vault-files import has been applied to renderer state — without
    // skipping here, that race could clobber an Obsidian-side edit made
    // while the app was closed).
    if (vaultSync.isEnabled() && !opts?.skipVaultSync) {
      try { vaultSync.syncStoreToVault(data); }
      catch (err) { console.warn('[vault-sync] export failed:', err.message); }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---- Obsidian vault sync ----

// User picks a folder via native dialog. We don't write anything yet —
// `obsidian:set-vault` does that once the renderer confirms.
ipcMain.handle('obsidian:pick-vault', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder inside your Obsidian vault',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, path: res.filePaths[0] };
});

// Connect/disconnect the vault. Returns the list of .md files already
// present so the renderer can reconcile them BEFORE its first save fires
// — without that, a launch-after-Obsidian-edit clobbers the vault edit
// with stale notes.json content. The renderer's first save then writes
// only canvas-only notes (the tuple-equality skip in syncStoreToVault
// no-ops every file we just imported).
ipcMain.handle('obsidian:set-vault', (_e, absPath) => {
  const result = vaultSync.setVault(absPath || null);
  if (!result.ok) return result;
  return { ok: true, vaultRoot: result.vaultRoot, files: result.files || [] };
});

// Build an obsidian:// URI for the note and hand it to the OS, falling
// back to opening the .md file directly if we couldn't locate the vault
// root (no .obsidian/ found).
ipcMain.handle('obsidian:open-note', async (_e, noteId) => {
  if (typeof noteId !== 'string' || !noteId) return { ok: false };
  const uri = vaultSync.openInObsidianURIFor(noteId);
  if (uri) {
    try { await shell.openExternal(uri); return { ok: true, uri }; }
    catch (err) { return { ok: false, error: err.message }; }
  }
  const filePath = vaultSync.getNoteFilePath(noteId);
  if (!filePath) return { ok: false, error: 'Note has not been synced yet.' };
  try { await shell.openPath(filePath); return { ok: true, filePath }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// Forward vault-side changes to the renderer. Wired once at startup.
vaultSync.setOnVaultChange((event) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vault:change', event);
  }
});

// Renderer (canvas) asks main to spawn a popout for a note id.
ipcMain.handle('popout:open', (_e, noteId) => {
  const win = createPopoutWindow(noteId);
  return { ok: !!win };
});

// Popout asks main to close itself (e.g. user clicked × in the popout).
ipcMain.handle('popout:close', (_e, noteId) => {
  const win = popoutWindows.get(noteId);
  if (win && !win.isDestroyed()) win.close();
  return { ok: true };
});

// Popout fetches its note data on first load.
ipcMain.handle('popout:request-note', (_e, noteId) => {
  return getNoteById(noteId);
});

// Popout has been edited by the user; forward the patch to the canvas
// renderer, which is the authority for the store. Also patch the cache so
// a freshly-spawned popout reading the same note sees the latest value.
ipcMain.handle('popout:edit', (_e, noteId, patch) => {
  if (typeof noteId !== 'string' || !noteId || !patch || typeof patch !== 'object') {
    return { ok: false };
  }
  applyNotePatchToCache(noteId, patch);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('popout:edit-received', { noteId, patch });
  }
  return { ok: true };
});

// Canvas tells main "this note changed, push to its popout if open."
// Main is dumb routing here; the canvas decides what's worth syncing.
ipcMain.handle('popout:notify-update', (_e, noteId, note) => {
  if (typeof noteId !== 'string' || !noteId || !note) return { ok: false };
  applyNotePatchToCache(noteId, note);
  const win = popoutWindows.get(noteId);
  if (win && !win.isDestroyed()) {
    win.webContents.send('popout:note-updated', note);
  }
  return { ok: true };
});

// Canvas tells main "this note was deleted" — close the popout if any.
ipcMain.handle('popout:notify-delete', (_e, noteId) => {
  const win = popoutWindows.get(noteId);
  if (win && !win.isDestroyed()) win.close();
  return { ok: true };
});

// Toggle the "locked" state of a popout window. When locked, the window
// stops being always-on-top and its content (header drag) is no longer
// movable. The user clicks the lock icon in the popout header to flip
// this on a per-popout basis.
ipcMain.handle('popout:set-locked', (_e, noteId, locked) => {
  if (typeof noteId !== 'string' || !noteId) return { ok: false };
  const win = popoutWindows.get(noteId);
  if (!win || win.isDestroyed()) return { ok: false };
  const wantLocked = !!locked;
  try {
    win.setAlwaysOnTop(!wantLocked, wantLocked ? 'normal' : 'screen-saver');
  } catch {}
  try { win.setMovable(!wantLocked); } catch {}
  return { ok: true, locked: wantLocked };
});

ipcMain.handle('notes:export', async (_e, data) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save backup',
    defaultPath: 'notes-backup.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('notes:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Restore backup',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths?.length) return { ok: false, canceled: true };
  try {
    const raw = fs.readFileSync(filePaths[0], 'utf8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.whenReady().then(() => {
  // Run any one-time migrations before anything reads notes.json.
  migrateLegacyUserData();

  // On macOS in dev mode (`npm start`), Electron shows its default icon in the
  // dock because there's no .app bundle with an Info.plist. Packaged .dmg builds
  // get the correct icon automatically from electron-builder. This closes the
  // gap during development.
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, 'build', 'icon.png')); } catch {}
  }
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (isQuitting) return;
  isQuitting = true;
  isShuttingDown = true;
  try { vaultSync.clearVault(); } catch {}
  if (pendingSave) {
    try {
      saveNotes(notesPath(), pendingSave.data);
    } catch (err) {
      console.warn('[main] final save failed:', err.message);
    }
  }
});
