# Desktop Notes

Sticky-notes canvas. Electron + React, plain JSX served via in-browser Babel

## Stack

- Electron 32, React 18 (vendored), Babel standalone
- Node 20+, electron-builder for packaging
- Storage: plain JSON in `app.getPath('userData')`

## Layout

```
main.js          Electron main: window, IPC, menu, popouts, vault sync
preload.js       contextBridge → window.stickyAPI
storage.js       JSON load/save
vault-sync.js    optional file-watch sync
index.html       loads jsx files via <script type="text/babel">
app.jsx          root component
components.jsx   canvas, notes, folders, modals
hooks.jsx        update-check, menu wiring, etc.
utils.jsx        pure helpers, theme tokens, constants
flatpak/         desktop + metainfo (id: io.github.rokokot.DesktopNotesApp)
```

## Run

```bash
npm install
npm start          # electron .
npm test           # node --test tests/*.test.mjs
```

## Build

```bash
npm run build:linux    # .deb / .AppImage → dist/
npm run build:mac      # .dmg / .zip → dist/
npm run build:icons    # regenerate build/icons/* from build/icon.svg
```

Output names: `desktop-notes-app_<ver>_amd64.deb`, `Desktop Notes-<ver>.AppImage`, `Desktop Notes-<ver>.dmg`.

## Data

| Platform | Path |
|---|---|
| Linux  | `~/.config/desktop-notes-app/notes.json` |
| macOS  | `~/Library/Application Support/desktop-notes-app/notes.json` |
| Browser | `localStorage["stickies.all"]` |

`main.js` auto-migrates from legacy `sticky-notes-canvas` / `sticky-notes` userData dirs on first launch.

## Release

`.github/workflows/release.yml` triggers on `v*` tags: matrix build on ubuntu + macos, attaches artifacts to the GitHub Release. `release-please.yml` watches `master` for conventional commits and maintains a release PR that bumps version + CHANGELOG.

## License

MIT — © 2026 Robin Kokot.
