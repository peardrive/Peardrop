# CLAUDE.md - PearDrop Agent Notes

---

## 🚨 SACRED CORE — DO NOT TOUCH 🚨

**The basic download MUST ALWAYS WORK.** This is non-negotiable.

### Protected Code (modify ONLY if absolutely necessary):

**In `lib/hyperdrive-manager.js`:**
- `createDrive()` - File writing to Hyperdrive
- `openDrive()` - File reading from Hyperdrive  
- Swarm `join()` / `replicate()` logic
- The basic share → connect → download flow

**In `main.js`:**
- `hyperdrive-share` IPC handler core
- `hyperdrive-download` IPC handler core

### Rules:
1. **New features = isolated modules.** Never contaminate the core.
2. **If touching core, get explicit approval first.**
3. **Test transfers BEFORE and AFTER any change.**
4. **When in doubt, DON'T.**

### Why:
> "No matter what happens, the user must never come to the app and have the basic download not work. If everything else fails, ok we can fix it, but the simple download needs to work."
> — Guy, 2026-02-24

---

## 🔍 POST-EDIT VERIFICATION (MANDATORY)

**After ANY code change, run these checks before declaring done:**

### 1. Syntax Check
```bash
node --check renderer.js
node --check preload.js  
node --check main.js
node --check lib/*.js
```

### 2. Launch Test
Start the app and check DevTools console for errors.

### 3. Sacred Smoke Test
These MUST work after every change:
- [ ] **Dropzone clickable** — file picker opens
- [ ] **Dropzone drag-drop** — files appear in preview
- [ ] **Share creates link** — `peardrop://` link generated
- [ ] **Download works** — file saves to ~/peardrop/downloads/

### Why This Exists
v0.17.1 incident: Missing `}` on one function broke entire renderer.js. Dropzone appeared dead but code was never touched — syntax error elsewhere killed everything. 30 seconds of `node --check` would have caught it.

See: `~/Projects/ENGINEERING-PRINCIPLES.md` Rule #9

---

## Current State (v0.24.0 - 2026-07-02)

**PearDrop is WORKING.** Core P2P file sharing is functional:
- ✅ Share files → get `peardrop://` link
- ✅ Download from link → files saved to `~/peardrop/downloads/`
- ✅ Upload progress (sharer sees peers downloading)
- ✅ Download progress (receiver sees real % with file name)
- ✅ Manifest system (`.peardrop.json` in every share)
- ✅ CLI tool (`peardrop share/download/list/stop/status`)
- ✅ Glassmorphism UI (macOS-style)
- ✅ QR retrieve (scan → auto-download) + peer count on idle shares
- ✅ Path-traversal-safe downloads (`safeJoin`), atomic manifest writes

### Recent Changes (v0.24.0 cleanup/hardening pass, 2026-06-12 → 2026-07-02)
- Security: path-traversal write fix, download stall watchdog, clean quit,
  share-link key validation, tracker listener leak fix
- **REMOVED: migration + manifest-recovery systems** (see Manifest Loading below)
- Removed `lib/_graveyard/` (recoverable from git history), tracked backups/zips
- Unified peer counting: `uploadTracking` Set<peerId> is the single source of
  truth; `drive.peers` is a derived mirror
- Consolidated UI helpers into `lib/ui-utils.js` (`window.PearUtils`)

---

## ⚠️ MANDATORY: File Header Manifests

**Every code file has a header manifest.** See top of each `.js` file.

**RULE:** When modifying ANY code file:
1. Check if the header manifest needs updating
2. Update it if functions/exports/events/key variables changed
3. Keep descriptions to 5-10 words max
4. Never let manifests drift from actual code

See `~/Projects/ENGINEERING-PRINCIPLES.md` for full philosophy.

---

## 🎨 UNIFIED PROGRESS UI

> ⚠️ UPDATED 2026-06-10 — this section previously documented `transfer-ui.js` /
> `updateTransferUI` / `updateDownloadUI` and a `.progress-bar` > (no fill)
> structure. **That code no longer exists.** All transfer rendering now lives in
> ONE component: `lib/drive-item/drive-item.js` (`DriveItem`). The "one structure
> for all transfers" principle is preserved — but by a single component, not
> shared HTML helpers. Use the real markup below.

**ONE component renders ALL transfers** — `DriveItem._buildContentHTML()` handles
uploads (shares) and downloads. There is no second renderer, so it cannot diverge
the way the v0.14.1 incident did (see Lessons Learned below).

### Actual progress markup (emitted by DriveItem):
```html
<div class="drive-item-progress">
    <div class="drive-item-progress-bar">
        <div class="drive-item-progress-fill" style="width: 72%"></div>
    </div>
</div>
```

### Key CSS classes (all `drive-item-*`, defined in drive-item.js `_injectStyles`):
- `.drive-item-progress-bar` - track
- `.drive-item-progress-fill` - gets `width: X%`, gradient
- `.drive-item-meta` / `.drive-item-meta-item` - size • files • % • speed row
- `.drive-item-peers` / `.drive-item-peers-dot[.offline]` - peer indicator

### Rule (still in force):
There must remain exactly ONE place that renders a transfer row. If you need a
transfer rendered somewhere new, reuse `DriveItem` — do NOT hand-roll a second
progress bar. Shared pure helpers (formatBytes/getFileIcon/escapeHtml) are
currently duplicated across drive-item/drive-info-panel/renderer — consolidating
them is a known TODO; don't add a 5th copy.

---

## 📚 Lessons Learned (v0.14.1 - Progress Bar Incident)

### What Happened
- Upload progress: `<div class="progress-bar" style="width: X%">`
- Download progress: `<div class="progress-bar"><div class="progress-fill">` (DIFFERENT!)
- Result: Download bar always 100% green, text too large
- Two HTML generators (`createTransferItemHTML` vs `createPendingDownloadHTML`) diverged

### Root Cause
Copy-paste modification instead of single source of truth. Changed one, forgot the other.

### The Fix
1. Unified both to use identical HTML structure
2. Created `lib/transfer-ui.js` for reusable components
3. Documented the pattern in this file

### Rule Added
> **If the same element appears in multiple places, it MUST be a single module.**
> See `~/Projects/ENGINEERING-PRINCIPLES.md` Rule #8

---

## ✅ Manifest Update Confirmation Rule

**After modifying ANY code file, I will:**
1. Update the file's header manifest if functions/exports/events changed
2. Note in my response: "📋 Updated header manifest in [filename]"
3. If no manifest update needed, note: "📋 No manifest changes needed"

This confirms the process is being followed so you don't have to wonder.

---

## CLI Usage (for me, the agent)

### Sharing Files
**CRITICAL:** Share process must stay alive for peers to download.

❌ **WRONG** - gets killed by exec timeout:
```bash
peardrop share /path/to/file
```

✅ **RIGHT** - runs in background, survives:
```bash
nohup peardrop share /path/to/file > /tmp/peardrop-share.log 2>&1 &
echo "PID: $!"
sleep 2
cat /tmp/peardrop-share.log  # get the link
```

Monitor progress:
```bash
cat /tmp/peardrop-share.log
```

Stop sharing:
```bash
pkill -f "peardrop share"
```

### Downloading Files
Downloads are one-shot (no background needed):
```bash
peardrop download peardrop://abc123... ~/Downloads
```

### Other Commands
```bash
peardrop list    # active shares
peardrop status  # statistics
peardrop stop    # stop all shares
```

---

## Architecture

```
~/Apps/peardrop/
├── main.js                    # THIN: Electron lifecycle + IPC routing
├── renderer.js                # UI logic, transfer display
├── preload.js                 # Secure IPC bridge
├── index.html                 # Glassmorphism UI + CSS
├── bin/peardrop               # CLI tool
├── CHANGELOG.md               # Version history
└── lib/
    ├── hyperdrive-manager.js  # 🔒 SACRED: Drive lifecycle, swarm, P2P + state
    ├── downloader.js          # ✅ SAFE: Download orchestration (safeJoin-guarded)
    ├── progress-tracker.js    # Upload tracking, events
    ├── file-utils.js          # ✅ SAFE: Pure file utilities (incl. safeJoin)
    ├── drive-actions.js       # ✅ SAFE: menu action -> IPC adapter (renderer)
    ├── ui-utils.js            # ✅ SAFE: shared browser helpers (window.PearUtils)
    ├── scroll-list/           # ✅ SAFE: list container (browser global)
    ├── drive-item/            # ✅ SAFE: transfer-row + info-panel (browser global)
    ├── qr-scanner/            # ✅ SAFE: QR generate/scan (browser global)
    └── logger.js              # debug logging
```

> ☠️ REMOVED (2026-07-02, recoverable from git history): `lib/migration.js`,
> `lib/manifest-recovery.js`, `lib/_graveyard/`. Do NOT reintroduce recovery
> logic that deletes manifest entries or drive folders — see Manifest Loading.

### Single Source of Truth (corrected 2026-06-10)

> ⚠️ The old `drive-manager.js` / `~/peardrop/drives.json` "DriveManager" no
> longer exists (deleted; recoverable from git history). Do not reintroduce it.
> The live source of truth is below.

**Owner:** `HyperdriveManager` (`lib/hyperdrive-manager.js`).
**File:** `~/peardrop/drives-state.json` — written atomically (temp + rename) by
`_saveManifest()`, loaded by the simple non-destructive loader in `_loadManifest()`.
**Wire manifest (separate, legitimate):** `/.peardrop.json` inside each drive —
the P2P metadata a receiver reads (file names/sizes). Distinct from local state.

**Drive states** (`DriveState` in hyperdrive-manager.js): `creating`, `active`,
`paused`, `seeking` (download in progress / awaiting peer), `errored`.

**Rule:** If it's in the Shares list → it exists. Remove from list → completely deleted.

### Module Responsibilities

**🔒 SACRED (don't touch without approval):**
- `hyperdrive-manager.js`: createDrive, openDrive, swarm join/replicate

**✅ SAFE (can modify freely):**
- `downloader.js`: File writing, naming, progress callbacks
- `file-utils.js`: getUniqueFilePath, ensureDir, formatBytes
- `ui-utils.js`: shared browser helpers (formatBytes, getFileIcon, escapeHtml…)
- `renderer.js`: UI only
- `index.html`: Styles only

### Storage Locations
- `~/peardrop/drives/` - Hyperdrive corestore data (per-drive directories)
- `~/peardrop/drives-state.json` - Persistent drive tracking (atomic writes)
- `~/peardrop/downloads/` - Downloaded files land here
- `/.peardrop.json` (inside drives) - Share metadata for receivers

**Deprecated (v0.17.0):**
- `~/peardrop/drives.json` - Old DriveManager state file
- `~/peardrop/drives-manifest.json` - Old hyperdrive tracking
- `~/peardrop/download-history.json` - Old download history

### Key Decisions Made
1. **Isolated Corestore per drive** - Clean namespace, easy cleanup
2. **In-drive manifest** (`.peardrop.json`) - Receiver knows file names/sizes instantly
3. **Manifest-first download** - Read manifest before downloading files
4. **Blobs core hook** - Track download progress via `blobs.core.on('download')`
5. **Background sharing** - Use `nohup` to keep shares alive
6. **Simple, non-destructive manifest loading** (2026-07-02) - see below

### Manifest Loading (2026-07-02 — REPLACED the recovery system)

The `ManifestRecovery` system and `lib/migration.js` were **deleted entirely**.
Its `validateOnly()` pruned every manifest entry whose drive folder it couldn't
see — so one transient failure to read `~/peardrop/drives/` wiped the whole
share list. This caused the cascading loss of good, working shares.

The loader is now inline in `HyperdriveManager._loadManifest()`:
1. Parse `drives-state.json`. Valid → use as-is. **Never prunes entries.**
2. Missing file → start with empty manifest (first run).
3. Corrupt file → back it up alongside (`.corrupted.<ts>`), start empty.
4. **NEVER touches drive folders on disk.**

**RULE:** Any future recovery/rebuild tool must be designed from scratch,
read-only-by-default, and must never delete manifest entries or drive folders
automatically. Deletion only with explicit per-item user confirmation.

---

## How Progress Tracking Works

### Upload (sharer side)
- `hyperdrive-manager.js` calls `tracker.trackUploads(driveId, drive, totalBytes)`
- Listens to `blobs.core.on('upload')` events
- Emits `upload-progress` with percent, speed, bytes

### Download (receiver side)
- `main.js` hooks `blobs.core.on('download')` in `hyperdrive-download` handler
- Uses `session.totalBytes` from manifest for percentage
- Emits `upload-progress` with `peerId: 'self'` (renderer shows as "Downloading")

---

## 🎯 UI STACKING CONTEXT RULES (Critical!)

**If you add UI elements with menus, dropdowns, or overlays — READ THIS.**

### The Problem
CSS z-index doesn't work the way you think. Elements with z-index create **stacking contexts** that trap all child z-indices.

Example of what goes wrong:
```css
.container { z-index: 50; }       /* Creates stacking context */
.menu-inside { z-index: 10000; }  /* TRAPPED inside container's level 50! */
.backdrop { z-index: 9999; }      /* At document.body - ABOVE the container! */
```

Result: Backdrop (9999 at root) beats menu (10000 inside a z-50 context). Menu is blocked.

### Rules to Follow

1. **NEVER add z-index to containers unless absolutely necessary**
   - Adding `z-index` to `.list-container`, `.scroll-list`, etc. traps all child menus
   - Use `position: relative` WITHOUT z-index when possible

2. **Menus/dropdowns: Use document click handler, NOT backdrop elements**
   - Backdrop at `document.body` + menu in container = stacking conflict
   - Document click handler avoids creating competing layers
   ```javascript
   // ✅ GOOD - works in any stacking context
   document.addEventListener('click', (e) => {
       if (!menuContainer.contains(e.target)) closeMenu();
   }, true);
   
   // ❌ BAD - backdrop at body blocks menus in containers
   const backdrop = document.createElement('div');
   backdrop.style.zIndex = '9999';
   document.body.appendChild(backdrop);
   ```

3. **If you MUST use a backdrop, keep it in the same stacking context**
   - Append backdrop as sibling of menu, not to body
   - Both will share parent's stacking context

4. **Explicit z-index ordering within components**
   ```css
   .menu-button { position: relative; z-index: 1; }
   .menu-dropdown { position: absolute; z-index: 10; }
   ```

5. **Test menus inside ScrollList/containers**
   - After ANY UI change, test that context menus open and are clickable
   - Check cursor changes to pointer on hover

### What Creates Stacking Contexts
- `z-index` (with position other than static)
- `opacity` less than 1
- `transform` (even `transform: none`)
- `filter`, `backdrop-filter`
- `isolation: isolate`
- `will-change` with certain values

### Current Implementation (v2)
- **DriveItem menus:** Use document click handler (no backdrop)
- **Menu button:** `z-index: 1`
- **Menu dropdown:** `z-index: 10000` (within component)
- **Container:** `position: relative` only — NO z-index
- **Active item elevation:** `.menu-open` class adds `z-index: 1000` to DriveItem when menu is open, lifting it above sibling DriveItems so their buttons don't cover the menu

See `ARCHITECTURE.md` for full component layer documentation.

---

## What's Next (Future Work)

From Guy's roadmap:
1. **iOS/Android clients** - Before download history UI
2. **Receive links** - QR code for others to send TO you
3. **Spaces integration** - Group sharing via pearcore
4. **Download history** - Track past transfers

See `PROPOSAL-metadata-layer.md` for pearcore signaling layer design.

---

## Gotchas & Lessons

1. **P2P requires sharer online** - No server, no relay. Share dies = download fails.
2. **Hyperdrive blob metadata** - Not available until blobs sync. Use manifest instead.
3. **Exec timeout kills shares** - Always use `nohup` for background sharing.
4. **Progress events are `upload-progress`** - Even for downloads (peerId='self').

---

## Testing Locally

Test share has content:
```javascript
const session = manager.activeDrives.get(driveId);
for await (const entry of session.drive.list('/')) {
    const data = await session.drive.get(entry.key);
    console.log(entry.key, data?.length, 'bytes');
}
```

Test manifest reads correctly:
```javascript
const manifest = await drive.get('/.peardrop.json');
console.log(JSON.parse(manifest.toString()));
```


---

## Hypercore Pruned Stack (2026-03-13)

PearDrop can use the `@peardrive/` pruned stack for storage-efficient hosting.

### Packages
```json
{
  "@peardrive/hypercore": "pruned",
  "@peardrive/hyperblobs": "pruned", 
  "@peardrive/hyperdrive": "pruned"
}
```

### What It Does
- `onBlockMissing` callback fires when peer requests cleared blocks
- Enables: write file → clear blobs → restore on-demand
- 99%+ storage savings for large file hosting

### Local Repos
- `~/Apps/hypercore-pruned` (has `onBlockMissing` hook)
- `~/Apps/hyperblobs-pruned` (pass-through)
- `~/Apps/hyperdrive-pruned` (has `pruned: true` mode)

### Usage in PearDrop
```javascript
const Hyperdrive = require('@peardrive/hyperdrive')

const drive = new Hyperdrive(store, {
  pruned: true,
  onBlockMissing: async (index, core, drive) => {
    // Restore from original file
  }
})
```

### Debugging: If Pruned Stack Has Bugs
Switch back to standard stack:
```json
{
  "hypercore": "^11.27.14",
  "hyperblobs": "^2.9.0",
  "hyperdrive": "^13.3.0"
}
```

### Integration Status
- [ ] Switch PearDrop to @peardrive/hyperdrive
- [ ] Test full transfer flow with pruned mode
- [ ] Implement sliding window restore
