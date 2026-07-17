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

## Current State (v0.25.1 - 2026-07-16)

**v0.25.1 — offline-provider receives fixed.** Adding a link while the sender
is offline now: persists immediately (state `seeking`, `manifestLoaded: false`),
survives reboots, keeps announcing, and auto-downloads whenever the sender
finally appears (`_hydrateReceivingDrive`, triggered from every swarm
connection). Verified by the real-DHT harness: `npm run test:p2p` (online /
offline-provider / reboot-survival). See Rules below and CHANGELOG v0.25.1.

> ✅ **ENGINE PARITY (resolved 2026-07-16):** the mobile backend now carries
> the same fix (`hydrateReceivingDrive` + `attachReceiverSwarm` +
> `manifestLoaded` in `apps/mobile/backend/hyperdrive-engine.mjs`; boot keeps
> legitimate SEEKING receives; RN auto-grabs on `drive-ready-to-download`).
> **Cross-engine gate:** `cd apps/mobile && npm run test:parity` runs the REAL
> mobile engine under the Bare runtime against the REAL desktop engine under
> node, over the real DHT — both online directions plus offline-provider and
> reboot-survival. Run it after ANY change to either engine's receive/share
> path. The wire contract (peardrop:// links, DHT topics, /.peardrop.json)
> must never change on one side alone.

---

## Previous State (v0.24.1 - 2026-07-03)

**PearDrop is WORKING — verified with a real Mac→Linux transfer.** Core P2P:
- ✅ Share files → get `peardrop://` link
- ✅ Download from link → files saved to `~/peardrop/downloads/`
- ✅ Shares survive restarts: resume + re-announce on boot (fixed 2026-07-03)
- ✅ Pause/Resume actually stop/rejoin the swarm (fixed 2026-07-03)
- ✅ Upload/download progress; peer count on idle shares
- ✅ Manifest system (`.peardrop.json` in every share)
- ✅ CLI tool (`peardrop share/download/list/stop/status`)
- ✅ QR retrieve (scan → auto-download); glassmorphism UI
- ✅ Path-traversal-safe downloads (`safeJoin`), atomic manifest writes,
  single-instance lock

### Recent Changes
**v0.24.1 (2026-07-03) — the "shares don't announce" hunt:**
- Quit no longer persists PAUSED (shutdown leaves drive state untouched)
- Resume failures no longer persist ERRORED (in-memory `resumeErrors`, retry next boot)
- `resumeDrive()` actually rejoins the swarm (was a state-flip stub with a TODO)
- Fixed IPC arg-shape mismatch that made Pause/Resume silent no-ops (see Lessons)
- Frontend now maps backend `state` → display status (paused/error rows visible)
- Log throttling: progress at 10% steps; boot prints a state-breakdown summary;
  announce lines include the link-key prefix

**v0.24.0 (2026-06-12 → 07-02) — cleanup/hardening pass:**
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

## 📚 Lessons Learned (v0.24.x - The "Shares Don't Announce" Hunt)

Five bugs, one theme: **every failure lived at a seam between layers, and every
layer swallowed errors and reported success.** The hyperdrive stack itself never
failed once.

### What Happened (2026-07-03)
1. **Quit demoted every share.** `stopAll()` on quit persisted `state=PAUSED`
   for all drives; boot only resumes `active`/`seeking`. Every graceful quit
   permanently silenced every share. (Ctrl-C'd sessions survived — backwards.)
2. **Resume was a stub.** The `drives-resume` handler had a literal
   `TODO: rejoin swarm` and just flipped the manifest field.
3. **The UI was blind.** Backend sends `state`; renderer read `status`;
   paused/errored drives rendered as healthy "Sharing".
4. **IPC argument shapes didn't match.** main destructures `{id}`; all four
   pause/resume callers passed bare id strings → `{id: undefined}` → no-op.
   `drives-pause` returned `success:true` even with a null result.
5. **Transient boot failures were persisted as permanent.** A corestore fd-lock
   (second running instance) marked drives ERRORED forever.

### Rules Added
> **IPC CONTRACT:** Drive operations take `{id, ...}` objects. `preload.js`
> normalizes bare-string ids at the bridge. Handlers MUST return
> `success:false` for no-ops — never report success for work not done.

> **WIRING AUDIT:** After changing any IPC surface, run the audit: extract
> every `ipcRenderer.invoke` channel from preload, every `ipcMain.handle` from
> main, every `webContents.send` and `ipcRenderer.on`, and diff the sets.
> Zero orphans in both directions, and spot-check argument shapes end-to-end
> (caller → preload → handler destructure).

> **STATE PERSISTENCE:** App lifecycle events (quit, boot, crash) must NEVER
> change a drive's persisted state. Only explicit user actions (pause, resume,
> remove) write state. Transient failures stay in-memory.

> **RECEIVE PERSISTENCE (v0.25.1):** A receiving drive is persisted the moment
> the user adds it (state `seeking`, `manifestLoaded: false`) and is removed
> ONLY by explicit user action — never by timeouts, reboots, or cleanup passes.
> `manifestLoaded` is the truth flag: false = "blank only because no provider
> has connected yet"; it must never be conflated with "share is empty" or
> "files missing". `_hydrateReceivingDrive` is the ONLY code that reads a
> remote share's manifest — idempotent, and hooked into EVERY swarm connection
> (open, resume, and late arrivals), never only inline at open time. Dup-check
> reports such entries as localStatus 'seeking' (block + highlight), not
> 'missing' (re-download offer).

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

---

## 🧱 Component Architecture (absorbed from ARCHITECTURE.md, 2026-07-03)

**Philosophy: blocks inside blocks.** Every component owns its block of space.
Parents provide empty slots; children control everything inside their slot; no
component reaches outside its block or manipulates another's internals.

```
App Window
└── ScrollList         — creates/manages empty slots, scrolling, reordering.
    │                    Does NOT know slot contents. NO z-index (traps menus).
    └── DriveItem      — renders one transfer row, owns its context menu,
        │                emits 'action' events. Adds .menu-open (z:1000) to
        │                elevate itself above sibling rows while menu is open.
        └── DriveActions — maps action names → electronAPI calls. No DOM
                           knowledge; receives the API as a parameter.
```

**Event flow (one direction, one path):**
DriveItem emits `action` → renderer → `DriveActions.handleAction(api, action,
data)` → preload → main IPC → HyperdriveManager → result back up → renderer
updates the item. Never bypass this chain with a side channel.

**Menu test checklist (after ANY UI change):**
- [ ] 3-dot menu opens; items clickable; pointer cursor on hover
- [ ] Menu closes on outside click / Escape
- [ ] Menu renders ABOVE sibling rows (the .menu-open elevation)
- [ ] Confirm dialogs appear above everything

---

## What's Next (Future Work)

**PRIORITY UX DEBT (Guy, 2026-07-03 — do this before/with the next feature pass):**
Share creation of a large file looks frozen and cannot be cancelled.
1. **Creation progress**: `createDrive` streams files into the drive with zero
   feedback — for multi-GB files the UI shows nothing for minutes. Emit
   per-file/byte progress events during ingest (count bytes through the
   `createWriteStream` pipe), surface as a `creating` row with a progress bar
   (DriveItem already renders progress; may need a `creating` status entry).
2. **In-app cancel**: no way to abort a share mid-creation. Add a cancel action
   that stops the stream and reuses the existing CREATING-state cleanup
   (delete partial storage + manifest entry — same logic as
   `_cleanupOrphanedDrives`, which already self-heals aborted creations at boot).
3. **Principle**: no long operation may run without visible progress AND a way
   to cancel it in-app. A user should never need to kill the process.

From Guy's roadmap (absorbed from ROADMAP.md, 2026-07-03):
1. **iOS/Android clients** - Before download history UI
2. **Receive links** - QR code for others to send TO you
3. **Device cloud** (pearcore) - Link your own devices via key attestation so
   they assist each other's transfers. Key decision (2026-03-28): account
   space is created LAZILY — only when the user first clicks "Add Device",
   never at first launch (avoids orphan spaces + DHT pollution).
4. **Download history** - Track past transfers

**FIXED (2026-07-03): share double-write.** `createDrive` is now the ONLY
writer of share entries (superset schema: P2P truth + UI fields). The
`hyperdrive-share` handler is pure glue. The download path uses
`updateDriveEntry` on the existing recv_ entry instead of re-adding.
`addDriveEntry` has a tripwire: it warns + merges (never silently replaces)
if asked to write an existing id. The never-used TTL/expiration system was
deleted with it — **shares end ONLY by explicit user pause/remove, never
automatically.** Do not reintroduce auto-expiry.

**Scope guard (settled in the v1 proposal — do NOT re-add):** no friend lists,
no identity systems, no whitelist trust, no push notifications, no Nostr. Those
belong to PearDrive proper. PearDrop = link sharing + (later) own-device cloud.

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
