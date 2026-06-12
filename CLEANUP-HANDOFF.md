# PearDrop Cleanup/Hardening Pass — Handoff

**Date:** 2026-06-12
**Branch:** `cleanup-hardening-pass` (branched from `fix-seeking-drive-resume`)
**Status at handoff:** working tree CLEAN — all work committed, nothing uncommitted to lose.

> Delete this file once the pass is fully merged. It exists only to resume safely
> across a machine restart.

---

## 0. How to resume (TL;DR)

```bash
cd /Users/guy/Anjou/Peardrop-Desktop
git checkout cleanup-hardening-pass        # already here; confirm
git status                                  # should be clean
git log --oneline ef56d4e..HEAD             # see the 7 commits below
```

Then continue at **§4 Remaining work**, starting with the peer-tracking
unification (analysis was in progress when we paused — notes in §4.1).

**Before merging this branch:** run the Sacred Smoke Test (§5). It is the one
thing that could not be verified headlessly and is the real gate.

---

## 1. The mission (user's words)

MVP P2P file-sharing app on the Pear/Hyperdrive stack, cross-platform Electron.
Goals: simple peer data in the GUI, progress tracking, simple QR to connect &
retrieve, persistent shares, attractive file view. The app already works; the
user kept finding **code bloat and lost/duplicated paths** from things rebuilt
multiple times. Task: make it **more reliable, secure, robust, and simpler** —
without breaking the "sacred" basic share→download flow.

User's explicit decisions this session:
1. **Priority order:** security + reliability FIRST, then dead-code cleanup,
   then features.
2. **Dead code:** move to a single `lib/_graveyard/` dir (not delete — git keeps
   it anyway, but they want it off-disk-visible yet recoverable).
3. **Features:** revive peer visibility + finish QR retrieve.
4. **Reversibility:** everything on a branch so the current working state is
   never lost.
5. Then: "continue with the low and medium items and we will wait until we have
   concrete approval for the SACRED fixes."

---

## 2. Branch / safety model

- `main` and `fix-seeking-drive-resume` are UNTOUCHED.
- `ef56d4e` = **checkpoint commit** preserving the user's in-progress WIP
  (seeking-drive resume + manifest-recovery edits) that were uncommitted when we
  started. Everything is recoverable from here.
- All new work is commits on top of `ef56d4e`.

---

## 3. What's DONE (7 commits, all verified with `node --check` + unit tests)

| Commit | Summary |
|---|---|
| `f2f4574` | **harden: security + reliability** |
| `47d4c02` | **cleanup: ~11k dead lines → lib/_graveyard/** |
| `6658e10` | **feat: QR retrieve + peer data on idle shares** |
| `31de8f4` | **docs: corrected stale CLAUDE.md** |
| `14bc11b` | **cleanup: removed 4 dead IPC channels** |
| `0957240` | **cleanup: removed dead trackDownload()** |
| `fc8f65d` | **refactor: consolidated UI helpers → lib/ui-utils.js** |

### 3.1 Security + reliability (`f2f4574`)
- **Path-traversal write fix (real vuln):** added `safeJoin(root, rel)` to
  `lib/file-utils.js`; `lib/downloader.js` now routes every write through it, so
  a malicious sharer's `../../` keys can't escape the downloads folder. Unit-
  tested (traversal/absolute/leading-slash all contained).
- **Atomic manifest save:** `_saveManifest` in `lib/hyperdrive-manager.js` now
  writes `drives-state.json` via temp-file + `rename`, serialized through a save
  chain — crash mid-write can't truncate the source of truth.
- **Download stall watchdog:** `lib/downloader.js` `STALL_TIMEOUT_MS = 60000`;
  a peer dropping mid-file fails that file instead of hanging the IPC forever.
- **Tracker listener leak:** named handlers stored on the session
  (`trackerHandlers`) and removed in `stopDrive` (both createDrive AND
  `_resumeDrive` paths unified to the same shape).
- **Clean quit:** `before-quit` in `main.js` now `preventDefault()` → await
  `stopAll` → re-quit (Electron ignores async quit handlers otherwise).
- **Key validation:** `_parseShareLink` requires 64-hex for the `peardrop://`
  form too. Resume-path manifest read now size-capped (OOM guard).

### 3.2 Dead code → `lib/_graveyard/` (`47d4c02`)
Moved (with `git mv`, history preserved): `peer-preview/`, `integrated-list/`,
`home-blocks.js`, `download-simulator.js`, component `standalone.html` harnesses,
`hyperdrive-manager.js.backup`, `drive-manager.js.removed`, `_archive/`.
Active `lib/` is now only live modules. See `lib/_graveyard/README.md`.

### 3.3 QR + peer visibility (`6658e10`)
- `renderer.js`: assigned `window.showToast = showToast` (QR scanner's error
  toasts were silently dead). Scanning a QR now **auto-starts download** (was
  just filling the field; `//startDownload()` was commented out).
- `lib/drive-item/drive-item.js`: `_buildContentHTML` now renders peer status on
  **idle/seeding shares** ("N peers" / "Waiting for peers"), not only during an
  active upload. Data already flowed via `onPeerConnected/Disconnected` →
  `item.update({peers})`. Reused existing `.drive-item-peers[.offline]` CSS.

### 3.4 CLAUDE.md corrections (`31de8f4`)
Fixed the actively-misleading docs that caused the "rebuilt without realizing"
problem: the "single source of truth" was described as the DEAD
`drive-manager.js`/`drives.json` (real one = `HyperdriveManager` +
`drives-state.json`); the "Unified Progress UI" section documented removed
`transfer-ui.js`/`updateTransferUI` and forbidden markup (real renderer =
`DriveItem._buildContentHTML` with `drive-item-progress-*`).

### 3.5 Dead IPC removal (`14bc11b`)
Removed handlers + preload exposures for `hyperdrive-stop`, `hyperdrive-abort`,
`hyperdrive-status`, `drives-check-files`, and the dead `onDownloadProgress`
listener (main never sends `download-progress`).
**IMPORTANT LESSON:** the initial audit also flagged `drive-get` as dead, but
`lib/drive-actions.js` calls `api.driveGet()` for the kebab "Open file" /
"Show in folder" actions. We caught it by re-grepping the **loaded browser
components**, not just `renderer.js`, and KEPT it. → Always verify "dead" code
against drive-item / drive-info-panel / drive-actions / scroll-list / qr-scanner,
which are browser globals, not Node requires.

### 3.6 Dead method removal (`0957240`)
Removed `trackDownload()` from `lib/progress-tracker.js` (a never-called third
download-progress impl; real one is in `lib/downloader.js`).
**Deliberately LEFT `lib/manifest-recovery.js` untouched** — its non-live
methods are QUARANTINED WIP (`main.js checkForOrphanedDrives` is `/* */`-disabled
with "will revisit later"), not accidental dead code, and it's exactly what the
user's checkpoint was mid-edit on. The one live path
(`loadWithRecovery → validateOnly → saveManifest`) is self-contained and never
reaches the broken `recoverPartial`/`recoverSingleDrive` methods (which call
nonexistent `validateAndSync`/`rebuildFromDrives`). So the latent crash is
unreachable today; fixing/removing it belongs with the recovery re-enable work.

### 3.7 UI helper consolidation (`fc8f65d`)
New `lib/ui-utils.js` (`window.PearUtils`, loaded FIRST in `index.html`) is the
single source for `formatBytes`, `formatSpeed`, `getFileIcon`, `escapeHtml`,
`truncateMiddle`. These were copy-pasted 3-4× across renderer/drive-item/
drive-info-panel/qr-scanner (and `escapeHtml` had already diverged: DOM-based vs
regex). Each component's local helper is now a one-line forwarder to PearUtils
(call sites untouched → minimal-diff/low-risk). Canonical `escapeHtml` uses the
regex form that also escapes quotes (safe in attribute contexts). Pure-JS module,
23 Node unit assertions pass. **Browser script-load path NOT exercised headlessly
— this is the main thing the smoke test must confirm.**

---

## 4. Remaining work

### 4.1 IN PROGRESS — unify dual peer-tracking (medium, renderer-only, SAFE)
We were mid-analysis when we paused. The problem (renderer.js):
- `drive.peers` (a plain counter) is incremented in `onPeerConnected`
  (~line 1119) and decremented in `onPeerDisconnected` (~1132).
- `uploadTracking` Map (declared ~line 90) ALSO tracks peers as a
  `Set<peerId>` in `updateUploadAggregation` (~line 1073), and updates the SAME
  `item.update({peers})` from `tracking.peers.size`.
- **Two sources of truth for the same number** → they can drift (e.g. a peer
  counted in one but not the other; `onPeerConnected` has no peerId dedup, it
  just `+1` every event).

Relevant code already read: `renderer.js` lines ~84-90 (state decls), ~1063-1157
(`updateUploadAggregation`, `onPeerConnected`, `onPeerDisconnected`).

**Proposed fix (safe, not yet applied):** make `uploadTracking`'s
`peers: Set<peerId>` the single authority for peer COUNT.
- `onPeerConnected`: add `data.peerId` to the drive's tracking Set (create the
  entry if missing), then `item.update({ peers: tracking.peers.size })`. Stop
  using the separate `drive.peers` counter (or derive it from the Set).
- `onPeerDisconnected`: already deletes from the Set — keep that, drop the
  parallel `drive.peers--`.
- Verify `data.peerId` is actually present on the `peer-connected` IPC payload
  (check what `main.js` / `hyperdrive-manager.js` emit for `peer-connected`). If
  `onPeerConnected` does NOT carry a peerId, the Set can't dedup on connect — in
  that case either (a) add peerId to the emit, or (b) keep a counter but make it
  the ONLY one. **Confirm the payload shape before coding** — this is the open
  question that stopped us.
- Note: the idle-share peer display added in `6658e10` reads `data.peers` on the
  DriveItem, so whichever number we settle on must keep feeding
  `item.update({peers})`. Don't regress that.

### 4.2 Other low/medium candidates (from the audit, NOT yet done)
- `main.js`: dead recovery dialogs `showRecoveryCompletedDialog`,
  `promptForCleanup`, `performCleanup` are only called from the quarantined
  `checkForOrphanedDrives` block — could be removed WITH the recovery decision,
  but leave for now (tied to manifest-recovery WIP, see §3.6).
- `lib/hyperdrive-manager.js` dead methods flagged by audit but **SACRED file —
  do NOT touch without approval**: `cleanupManifest()` (`if(false)` no-op),
  `getActiveDriveEntries()`, the openDrive-returned `downloadAll`/`downloadFile`/
  `close` closures (a second, dead download impl), and the "File Operations for
  UI" block. These are dead but live in the sacred file → defer to §4.3.
- Debug-toggle is near-useless: `set-debug`/`get-debug` only gate the few
  `log()` calls in main.js; hyperdrive-manager/downloader/tracker use raw
  `console.log`. Optional polish: route them through the logger.
- `renderer.js` leftover debug `console.log` spam in `removeDriveFromList`,
  `onDrivesUpdated`, etc. (low value; cosmetic).

### 4.3 DEFERRED — need explicit user approval (SACRED core)
Do NOT start these without the user saying go. Per `CLAUDE.md`, the sacred core
is `createDrive`/`openDrive`/swarm join-replicate + the share/download IPC.
1. **Share double-write bug:** `createDrive` writes a manifest entry, then
   `main.js` (`hyperdrive-share` handler, ~line 417) immediately calls
   `addDriveEntry` which OVERWRITES it with a different shape, discarding
   `discoveryKey`/`expiresAt`/per-file `addedAt`. Last-write-wins on two schemas.
2. **Lossy recovery / re-enable corestore rebuild:** `validateOnly` DELETES
   manifest entries whose drive folder is missing; combined with the quarantined
   rebuild, a corrupted `drives-state.json` loses the drive list even though the
   corestores survive. Re-enabling a SAFE rebuild is the real fix — and overlaps
   the user's own manifest-recovery WIP.
- Removing the dead methods inside the sacred `hyperdrive-manager.js` (§4.2)
  also needs the nod since it's the sacred file.

---

## 5. Sacred Smoke Test (MANDATORY before merge — could not run headlessly)

Per CLAUDE.md. Run `npm start`, open DevTools console, confirm no errors, then:
- [ ] Dropzone clickable → file picker opens
- [ ] Drag-drop → files appear in preview
- [ ] Share → `peardrop://` link generated, QR shows
- [ ] Download from a link → file lands in `~/peardrop/downloads/`
- [ ] **QR:** scan/upload a QR image → link captured + auto-download starts;
      a bad image shows an error toast (was previously silent)
- [ ] **Peer data:** an idle share shows "Waiting for peers"; with a peer
      connected shows "N peers" — both on the row, not only mid-transfer
- [ ] **UI helpers:** file sizes, file-type icons, and the More-Info panel all
      still render correctly (this exercises the `lib/ui-utils.js` delegation)
- [ ] Kebab menu "Open file" / "Show in folder" work (exercises `driveGet`)

If anything breaks: `git log` the 7 commits; each is independent enough to
`git revert` in isolation. The util consolidation (`fc8f65d`) and the peer-
visibility change (`6658e10`) are the most likely to surface a render issue.

---

## 6. Key facts to re-load into context on resume

- **Live Node modules** (required by main.js): hyperdrive-manager,
  manifest-recovery, downloader, progress-tracker, migration, file-utils, logger.
- **Live browser scripts** (index.html `<script>`, in order): `lib/ui-utils.js`
  (NEW, first), scroll-list, drive-item, drive-info-panel, drive-actions,
  jsQR, qr-scanner, renderer.js.
- **Source of truth:** `HyperdriveManager` + `~/peardrop/drives-state.json`
  (atomic). In-drive `/.peardrop.json` = the P2P wire manifest (separate, fine).
- **`DriveState`:** creating | active | seeking | paused | errored.
- Progress: uploads via `progress-tracker.js` (`blobs.on('upload')`); downloads
  via `lib/downloader.js` (`blobs.core.on('download')`). Both surface to the
  renderer as the `upload-progress` event (downloads use `peerId:'self'`).
- The full audit lives in this session's history; the actionable residue is all
  in §4 above.
