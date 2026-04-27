const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stickyAPI', {
  load:       () => ipcRenderer.invoke('notes:load'),
  save:       (data, opts) => ipcRenderer.invoke('notes:save', data, opts),
  exportFile: (data) => ipcRenderer.invoke('notes:export', data),
  importFile: () => ipcRenderer.invoke('notes:import'),

  // Version of the running Electron build, captured at preload time so the
  // renderer can synchronously compare to the latest GitHub release tag.
  appVersion: ipcRenderer.sendSync('app:version-sync'),
  // Whether the running app is the snap build. snapd sets SNAP_NAME inside
  // the sandbox; nothing else does. Used to: skip the daily update check
  // (snap auto-refresh handles it), and surface a snap-friendly upgrade
  // hint when the user explicitly checks for updates.
  isSnap: !!process.env.SNAP_NAME,
  // Whether the running app is the flatpak build. flatpak-portal/bwrap sets
  // FLATPAK_ID to the app-id inside the sandbox. Used to: skip the daily
  // update check (flatpak handles updates via the software center), and
  // surface a flatpak-friendly upgrade hint on explicit force-check.
  isFlatpak: !!process.env.FLATPAK_ID,
  // Open https URLs in the user's default browser. Used by the update banner.
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  onMenuCheckUpdates: (cb) => {
    const wrapped = () => cb();
    ipcRenderer.on('menu:checkUpdates', wrapped);
    return () => ipcRenderer.removeListener('menu:checkUpdates', wrapped);
  },
  onMenuAbout: (cb) => {
    const wrapped = () => cb();
    ipcRenderer.on('menu:about', wrapped);
    return () => ipcRenderer.removeListener('menu:about', wrapped);
  },
  onMenuExport: (cb) => {
    const wrapped = (_event, ...args) => cb(...args);
    ipcRenderer.on('menu:export', wrapped);
    return () => ipcRenderer.removeListener('menu:export', wrapped);
  },
  onMenuImport: (cb) => {
    const wrapped = (_event, ...args) => cb(...args);
    ipcRenderer.on('menu:import', wrapped);
    return () => ipcRenderer.removeListener('menu:import', wrapped);
  },
  onMenuPreferences: (cb) => {
    const wrapped = (_event, ...args) => cb(...args);
    ipcRenderer.on('menu:preferences', wrapped);
    return () => ipcRenderer.removeListener('menu:preferences', wrapped);
  },
  onMenuImportHelp: (cb) => {
    const wrapped = () => cb();
    ipcRenderer.on('menu:importHelp', wrapped);
    return () => ipcRenderer.removeListener('menu:importHelp', wrapped);
  },

  // ---- Popout windows ----
  // Used by the canvas window:
  popoutOpen:          (noteId)        => ipcRenderer.invoke('popout:open', noteId),
  popoutNotifyUpdate:  (noteId, note)  => ipcRenderer.invoke('popout:notify-update', noteId, note),
  popoutNotifyDelete:  (noteId)        => ipcRenderer.invoke('popout:notify-delete', noteId),
  onPopoutEdit: (cb) => {
    const wrapped = (_e, payload) => cb(payload);
    ipcRenderer.on('popout:edit-received', wrapped);
    return () => ipcRenderer.removeListener('popout:edit-received', wrapped);
  },

  // Used by popout windows themselves:
  popoutClose:         (noteId)         => ipcRenderer.invoke('popout:close', noteId),
  popoutEdit:          (noteId, patch)  => ipcRenderer.invoke('popout:edit', noteId, patch),
  popoutRequestNote:   (noteId)         => ipcRenderer.invoke('popout:request-note', noteId),
  popoutListNotes:     ()               => ipcRenderer.invoke('popout:list-notes'),
  popoutSetLocked:     (noteId, locked) => ipcRenderer.invoke('popout:set-locked', noteId, locked),
  onPopoutNoteUpdated: (cb) => {
    const wrapped = (_e, note) => cb(note);
    ipcRenderer.on('popout:note-updated', wrapped);
    return () => ipcRenderer.removeListener('popout:note-updated', wrapped);
  },

  // ---- Obsidian vault sync ----
  obsidianPickVault: ()       => ipcRenderer.invoke('obsidian:pick-vault'),
  obsidianSetVault:  (p)      => ipcRenderer.invoke('obsidian:set-vault', p),
  obsidianOpenNote:  (noteId) => ipcRenderer.invoke('obsidian:open-note', noteId),
  onVaultChange: (cb) => {
    const wrapped = (_e, event) => cb(event);
    ipcRenderer.on('vault:change', wrapped);
    return () => ipcRenderer.removeListener('vault:change', wrapped);
  },
});
