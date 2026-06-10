# lib/_graveyard

Dead / orphaned code consolidated here on 2026-06-10 during the cleanup pass.

**Nothing in this folder is loaded by the running app.** It is kept on disk only
as a single, obvious quarantine so the active `lib/` tree stays clean. Everything
here is also preserved in git history — delete this whole folder at any time.

## What's here and why it's dead

| Item | Why it's dead |
|---|---|
| `peer-preview/` | Never loaded — not `<script>`-tagged in index.html nor required. The rich peer/video-preview UI was abandoned; no active file references it. |
| `integrated-list/` | Superseded by the `scroll-list` + `drive-item` components. Not loaded. |
| `home-blocks.js` | Orphan — not loaded anywhere. |
| `download-simulator.js` | Dev-only demo helper, referenced solely by the (also dead) drive-item standalone harness. |
| `drive-item-standalone.html`, `scroll-list-standalone.html` | Standalone dev harnesses for the components, not loaded by the app. |
| `hyperdrive-manager.js.backup` | Pre-refactor backup of the live manager. |
| `drive-manager.js.removed` | The old DriveManager, replaced by HyperdriveManager + drives-state.json. CLAUDE.md still references `drive-manager.js` as the "single source of truth" — that is stale; the live source of truth is `hyperdrive-manager.js` + `~/peardrop/drives-state.json`. |
| `_archive/2026-03-06-pre-refactor/` | Earlier archived snapshot of the component tree. |

## Live components (for reference — these are NOT here)

Node: `hyperdrive-manager`, `manifest-recovery`, `downloader`, `progress-tracker`,
`migration`, `file-utils`, `logger`.
Browser (index.html `<script>`): `scroll-list`, `drive-item`, `drive-info-panel`,
`drive-actions`, `qr-scanner`, plus `renderer.js`.
