# PearDrop Changelog

## v0.25.1 (2026-07-16) - Downloads That Wait For Their Sender ⏳

**Fixed the offline-provider dead end**: pasting a link while the sender was offline created a drive that was never saved (gone after reboot) and never reacted when the sender finally came online. Found live in Mac↔mobile testing with a sender that had been closed for an hour.

### Fixed
- **Seeking drives persist immediately**: `openDrive` writes the manifest entry up-front with `manifestLoaded: false` — the explicit marker for "blank because no provider has connected yet", never confused with "share is empty". The entry survives reboots and keeps announcing until the user removes it
- **Late-arriving senders now trigger the download**: new single hydration path (`_hydrateReceivingDrive`) runs from every swarm connection — whether the sender appears five seconds or five days after the link was added, on a fresh add or after any number of reboots: manifest read → entry persisted → `drive-ready-to-download` → auto-download. Previously the manifest read only happened inline during the open/resume call, so a peer connecting after that moment was silently ignored (both in `openDrive` and in the boot-resume path)
- **A peer with no drive data doesn't fake a hydration**: another downloader connecting on the same topic leaves the entry un-hydrated so the real provider still triggers the download later
- **Dup-check knows about seeking**: pasting a link that's already waiting highlights the existing row ("Already in your list — waiting for the sender") instead of offering a bogus re-download; the pre-5A false "Already downloaded" stub bug stays fixed because seeking entries are now first-class, not accidents
- **Renderer waiting row uses the real driveId** so the late `drive-ready-to-download` event converts it into a live download (replaces the old `TODO: retry/listen mechanism` dead end)
- **MaxListenersExceededWarning gone**: ProgressTracker is a shared singleton with one listener pair per resumed drive; cap lifted (listener lifecycle already managed by stopDrive)

### Added
- **P2P integration harness** (`test/integration/offline-provider.harness.js`, `npm run test:p2p`): real-DHT tests for online transfer, offline-provider add, and reboot-survival — the scenarios that can't be verified with two clients that are always online at the same time

## v0.24.1 (2026-07-03) - Shares That Actually Survive 🔁

**Fixed the full chain of bugs that silently stopped shares from announcing after restarts.** Verified with a real Mac→Linux transfer.

### Fixed
- **Quit no longer pauses your shares**: shutdown disconnects from the network without touching persisted drive state, so every share resumes and re-announces on the next boot (previously each graceful quit permanently demoted all shares to paused)
- **Resume actually works**: rejoins the swarm and re-announces (the handler was a state-flip stub with a `TODO: rejoin swarm`)
- **Pause/Resume IPC was a silent no-op**: argument-shape mismatch sent `{id: undefined}`; the bridge now normalizes shapes and handlers return real errors instead of fake success
- **UI shows drive state**: paused (yellow, dimmed) and errored (red ⚠) rows are visible; Resume appears in the menu for both; "Resume all" reports failures honestly
- **Transient boot failures are no longer permanent**: a failed resume (e.g. locked corestore) retries next boot instead of persisting `errored`
- **Single-instance lock**: a second launch focuses the running app instead of fighting over corestore file locks
- **Share double-write eliminated**: `createDrive` is now the single writer of share entries (the share handler used to overwrite it with a different schema, discarding `discoveryKey` and per-file drive paths); download completion updates the existing entry instead of re-adding it; `addDriveEntry` warns and merges instead of silently replacing

### Removed
- **TTL/expiration system**: never reachable from any UI or CLI, and its only possible behavior was auto-deleting a share on a timer. Shares now end only by explicit user pause or remove.

### Changed
- Log noise cut ~30×: upload progress logs once per 10% step; boot prints a one-line state summary; DHT announce lines include the `peardrop://` link-key prefix for at-a-glance link debugging
- Docs consolidated: ROADMAP/PROPOSALs/ARCHITECTURE/CLEANUP-HANDOFF folded into README.md + CLAUDE.md

## v0.24.0 (2026-07-02) - Cleanup & Hardening Pass 🧹

**Security fixes, removal of the migration/recovery systems, and major dead-code cleanup** (consolidates the `cleanup-hardening-pass` branch, 2026-06-12 → 2026-07-02)

### Security & Reliability
- **Path-traversal write fix**: all download writes routed through `safeJoin()` — a malicious sharer's `../../` keys can no longer escape the downloads folder
- **Atomic manifest saves**: `drives-state.json` written via temp-file + rename; a crash mid-write can't truncate the drive list
- **Download stall watchdog** (60s): a peer dropping mid-file fails that file instead of hanging forever
- **Clean quit**: `before-quit` now awaits `stopAll` properly
- **Share-link validation**: `peardrop://` links require a valid 64-hex key
- **Tracker listener leak fixed** on drive stop/resume paths

### REMOVED: Migration & Manifest-Recovery Systems
- Deleted `lib/migration.js` (disabled since 2026-05-13) and `lib/manifest-recovery.js`, plus all main.js hooks (~900 lines)
- **Why**: the recovery system's validation could delete every drive entry if the drives folder was momentarily unreadable — the root cause of cascading loss of good shares
- Replaced with a simple, non-destructive loader in `HyperdriveManager._loadManifest()`: parse, or back up the corrupt file and start empty; never prunes entries, never touches drive folders

### Fixes & Features
- **Unified peer counting**: single source of truth (`Set<peerId>`); peer counts no longer drift on reconnects
- **QR retrieve finished**: scanning a QR auto-starts the download; bad images show an error toast
- **Peer visibility on idle shares**: rows show "Waiting for peers" / "N peers" outside active transfers

### Cleanup
- Removed `lib/_graveyard/` (~11k dead lines, recoverable from git history)
- Untracked editor backups, zip archives, debug logs, `.DS_Store`; tightened `.gitignore`
- Removed 4 dead IPC channels and dead `trackDownload()`
- Consolidated duplicated UI helpers (`formatBytes`, `getFileIcon`, `escapeHtml`…) into `lib/ui-utils.js` (`window.PearUtils`)
- Corrected stale CLAUDE.md architecture docs

> Note: versions 0.20–0.23 shipped without changelog entries; their changes are folded into this entry.

## v0.19.1 (2026-05-15) - Bulletproof Manifest Recovery & Deduplication Fixes 🔧

> ⚠️ The recovery system introduced here was removed in v0.24.0 after it proved destructive in practice.

**Robust manifest recovery system and improved drive deduplication**

### Major Features
- **🛡️ Bulletproof Manifest Recovery System**
  - New isolated `ManifestRecovery` module for robust drives-state.json handling
  - Automatically rebuilds manifest from existing Corestore drive folders
  - Handles complete manifest corruption with partial recovery attempts
  - Syncs manifest ↔ drive folders consistency automatically
  - Backs up corrupted manifests before attempting recovery

- **🔄 Enhanced Deduplication Logic**
  - Fixed deduplication to block ALL duplicates, not just available ones
  - Prevents duplicate downloads regardless of file availability status
  - Improved user feedback for duplicate detection

### Technical Improvements
- **New ManifestRecovery Class** (`lib/manifest-recovery.js`)
  - `loadWithRecovery()` - Main entry point with full recovery capability
  - `rebuildFromDrives()` - Scans Corestore folders to rebuild complete manifest
  - `validateAndSync()` - Ensures manifest and drive folders stay in sync
  - `recoverPartial()` - Attempts to recover from corrupted JSON data
  - `cleanupOrphans()` - Removes orphaned drives/manifest entries
  - `scanDriveFolder()` - Extracts metadata from individual drive folders

- **Recovery Integration**
  - HyperdriveManager now uses ManifestRecovery for all manifest operations
  - Graceful fallback from corruption → partial recovery → complete rebuild
  - Proper state restoration for both upload and download drives
  - Uploads resume as 'active', downloads restored as 'paused'

### Bug Fixes
- **🚫 Fixed duplicate bypass vulnerability** - Removed availability condition from deduplication check
- **🔧 Enhanced manifest validation** - Empty manifests with existing drives now trigger rebuild instead of deletion
- **📁 Improved drive scanning** - Validates Corestore directories before attempting drive operations
- **📦 Removed 2GB file size limitation** - Replaced `fs.readFile()` and `fs.writeFile()` with streaming for both upload and download of large files

### Architecture
- **Modular Recovery System** - Isolated manifest recovery logic following "new features = isolated modules" principle
- **Consistent State Management** - Single source of truth maintained across corruption scenarios
- **Defensive Error Handling** - Multiple fallback strategies prevent total data loss

### For Developers
- Recovery system designed as isolated module to avoid contaminating core hyperdrive-manager
- Comprehensive error handling with backup creation before any destructive operations
- Full compatibility with existing drive storage format and IPC event system

## v0.19.0 (2026-05-10) - P2P Connectivity Overhaul 🔧

**Major P2P reliability improvements and status system cleanup**

### What Changed
- **🔄 Persistent Peer Discovery**
  - Downloads now seek peers indefinitely (like BitTorrent) instead of timing out
  - Removed premature `done()` calls that were stopping peer discovery
  - Downloads survive app restarts and continue seeking automatically

- **💾 Immediate Download Persistence** 
  - Downloads immediately saved to drives-state.json in 'seeking' state
  - No more lost downloads when app crashes before completion
  - Full download state preserved across restarts

- **🚫 Duplicate Prevention**
  - Fixed deduplication logic to recognize existing downloads by key
  - Downloads properly updated with real data after successful peer connection
  - Prevents multiple downloads of the same content

- **♻️ Auto-Resume on Restart**
  - Added 'seeking' to DriveState constants
  - Downloads in seeking state automatically resume peer discovery on app launch
  - Upload shares also resume normally after restart

- **🧹 Status System Cleanup**
  - **REMOVED:** Misleading "inactive" status that appeared after arbitrary timer
  - **REMOVED:** Timer-based status switching that didn't reflect real P2P state  
  - Default status now "sharing" (ready to share) instead of "inactive"
  - Status changes only based on real peer events, not timers

### Technical Details
- Fixed `openDrive()` to never stop peer discovery with persistent swarm joining
- Added immediate `addDriveEntry()` call before any network activity
- Enhanced `_resumeDrive()` to handle seeking downloads via `openDrive()` restart
- Updated STATUS_CONFIG and removed all inactive status references
- Modified drive resumption to include both active and seeking drives

### Bug Fixes
- **🔧 Fixed drive resumption after restart** - Resumed drives now open with correct stored key instead of generating new keys
- **🎯 Fixed drive deletion UI sync** - Drive removal now properly updates GUI immediately via event-driven architecture  
- **🚫 Removed misleading "inactive" status** - Eliminated timer-based status that didn't reflect real P2P connection state

### For Developers
- Enhanced `_resumeDrive()` to open drives with stored key: `new Hyperdrive(store, Buffer.from(metadata.key, 'hex'))`
- Fixed IPC event flow: backend always sends `drives-updated` event regardless of manifest state
- Pure event-driven deletion: removed immediate UI updates, relies only on backend confirmation events
- Comprehensive debugging added throughout deletion flow (can be removed in production)
- Inactive status completely removed from DriveItem and renderer components

## v0.18.0 (2026-03-10) - V2 UI Migration 🎉

**Major UI overhaul: Integrated ScrollList + DriveItem architecture**

### What Changed
- **New modular UI architecture**
  - ScrollList v2: Slot-based container (child components own their blocks)
  - DriveItem v1.0: Self-contained drive display with built-in context menu
  - DriveActions: Bridge between UI actions and system APIs
  - All components work standalone (see `lib/*/standalone.html`)
  
- **New features**
  - Tab header with 3-dots menu (Pause All, Resume All, Clear Completed)
  - Sort By submenu: Manual Edit, Recent, Status, Size, Name, Peers, File Type
  - Ascending/descending toggle (click same sort to flip)
  - Manual reorder mode with FLIP animations
  - New downloads appear at top of list

- **Debug system**
  - Centralized logging via `lib/logger.js`
  - Runtime toggle: `peardrop.setDebug(true/false)` in DevTools
  - Config persisted to `~/peardrop/config.json`
  - Stays ON during development, easy to disable for users

- **Cross-platform support**
  - macOS: Full glassmorphism, hidden title bar, vibrancy
  - Windows/Linux: Standard title bar, solid background
  - All lib/ components portable to Pear runtime

- **Architecture documentation**
  - `lib/ARCHITECTURE.md`: Slot-based composition, action handling layers
  - `ARCHITECTURE.md`: UI stacking context rules (critical for menus!)
  - All modules have complete header manifests

### Migration Notes
- v1 files backed up: `main-v1.js`, `renderer-v1.js`, `index-v1.html`
- Run with: `npm start` or `npm run dev`
- Config at: `~/peardrop/config.json`

---

## v0.17.2 (2026-02-25) - Cleanup & Audit
- 🐛 **Fixed `historyEntry is not defined`** - Renamed to `driveEntry` after refactor
- 🐛 **Fixed missing closing brace** on `cancelAndDeleteDownload()` that broke all JS
- 🧹 **Moved deprecated files** to `lib/_deprecated/`:
  - `download-history.js` (replaced by drive-manager.js)
  - `drive-dedup.js` (dedup now built into main.js)
- 📋 **Updated main.js manifest** with current IPC structure
- ✅ **Full 20-point audit** - No remaining errors found
- 📚 **Added ENGINEERING-PRINCIPLES.md Rule #9** - Verification before commit
- 📚 **Added POST-EDIT VERIFICATION section** to CLAUDE.md

## v0.17.1 (2026-02-25)
- 🎨 **Downloads show in BOTH Home + Shares simultaneously**
  - Progress visible in both tabs during download
  - Shares tab shows "⬇️ Downloading..." with progress bar
- ➖ **Minimize button (−)** on downloads
  - Hides from Home but continues in Shares
  - Good for decluttering while download runs
- ✕ **Cancel button now confirms and fully deletes**
  - Shows "Cancel and delete permanently?" confirmation
  - Actually removes drive, storage, and files
- 🔄 State synced between Home and Shares in real-time

## v0.17.0 (2026-02-25) - DriveManager Unification 🎯
**Major refactor: Single source of truth for all drives**

### What Changed
- **New `DriveManager` module** (`lib/drive-manager.js`)
  - Replaces both `download-history.js` AND the manifest tracking in `hyperdrive-manager.js`
  - One JSON file: `~/peardrop/drives.json`
  - Clean API: `add()`, `remove()`, `pause()`, `resume()`, `get()`, `getAll()`, `getByKey()`
  
- **New IPC API**:
  - `drives-list` → Get all drives
  - `drives-pause` → Stop seeding (keep data)
  - `drives-resume` → Resume seeding
  - `drives-remove` → Delete completely (drive + optional files)
  - `drives-check-files` → Verify local files exist

### Why
- Previous system had TWO parallel trackers (manifest + download-history) that diverged
- Now: **If it's in the Shares list, it exists. If you remove it, it's gone.**
- Universal module for future tools (mobile, CLI, etc.)

### Breaking Changes
- `download-history.json` is deprecated (new data in `drives.json`)
- Old history entries won't auto-migrate - start fresh

---

## v0.16.3 (2026-02-25)
- 📜 **Clear logging when removing shares**
  - Now logs: "Removing share from history", "Stopping active share" / "Cleaned up inactive drive storage", "Share removed completely"
  - User can verify in logs that drive is fully cleaned up
- 🧹 **Storage cleanup for inactive drives**
  - Previously only stopped drives if in activeDrives (fails after app restart)
  - Now always cleans up drive storage directory when removing from Shares

## v0.16.2 (2026-02-25)
- 🐛 **Fixed "Clear" button destroying active shares**
  - Root cause: `clearFiles()` was calling `hyperdriveStop(purge: true)` 
  - Fix: Clear button now only resets dropzone UI, drive keeps seeding
  - Shares remain active and visible in Shares tab
- 🔄 **Shares tab now refreshes when upload completes**
  - `showMovedToShares()` now calls `loadDownloadHistory()` to update list

## v0.16.1 (2026-02-25)
- 📊 **Minimal share status bar**: Pending shares now show as a compact bar
  - Shows filename + peer count + Copy/View/Stop buttons
  - Much cleaner than full block, doesn't overwhelm Home
  - Full progress only shows when someone is actively downloading

## v0.16.0 (2026-02-25)
- 🔄 **Improved upload UX flow**:
  - Shares now added to Shares tab immediately when created
  - After peer finishes downloading: "Complete ✓" for 2 sec → fades out
  - Shows clickable "Moved to Shares →" notification
  - Home stays clean, all shares managed in Shares tab
- 📜 **Fixed Shares tab scrolling**: Added native rubber-band bounce scroll
- ✨ New animations for transfer completion and "moved" state

## v0.15.2 (2026-02-25)
- 🐛 **Fixed "Copy Link" returning "peardrop://unknown"**
  - Root cause: `openDrive()` wasn't saving `shareLink` to session object
  - Fix: Added `shareLink` and `metadata.key` to session in hyperdrive-manager.js

## v0.15.1 (2026-02-25)
- 🎨 **Cleaner Shares tab UI**:
  - Removed emojis from tab names ("Home", "Shares")
  - Consolidated action buttons into 3-dot dropdown menu
  - Renamed "Stop Seeding" → "Pause", "Open" → "Show File"
  - Added "Copy Link" option to share dropdown
- 📋 Status labels simplified: "Sharing", "Local", "File Missing"

## v0.15.0 (2026-02-25)
- 🔍 **Duplicate Detection**: Recognizes previously downloaded drives by key
  - Shows "Already have this file" if local file exists
  - Offers re-download if file was deleted
  - Uses drive key (content hash) - works even if file renamed
- 📤 **"Downloads" tab renamed to "Shares"**: Shows all active hyperdrives
- 📦 **lib/drive-dedup.js**: New module for deduplication + local file verification
- 🔧 Tab IDs updated: `downloadsTab` → `sharesTab`, etc.

## v0.14.1 (2026-02-25)
- 🎨 **UNIFIED PROGRESS UI**: Upload and download now use identical HTML structure
  - Fixed: Download progress bar was fully green (nested `.progress-fill` bug)
  - Fixed: Download text size inconsistency (`.transfer-stats` missing CSS)
  - All transfers now use: `.progress-bar` with width %, `.transfer-stats` with `.transfer-bytes` + `.transfer-percent`
- 📦 **lib/transfer-ui.js**: New module for reusable progress components (future mobile use)
- 📝 Documentation: Added "UNIFIED PROGRESS UI" section to CLAUDE.md

## v0.14.0 (2026-02-24)
- 🆕 **Download History Tab**: Swipe between Home and Downloads
- 🌱 **Seeding Support**: Downloaded files can be re-shared to others
- 📥 **Persistent Downloads**: Downloads stay active until you stop them
- 🔄 **P2P Relay**: If uploader goes offline, peers who downloaded can serve the file
- 📋 **lib/download-history.js**: New module for persistent history storage

## v0.13.0 (2026-02-24)
- 🏗️ **REFACTOR: Modular architecture**
  - `lib/downloader.js` - Download orchestration (✅ SAFE to modify)
  - `lib/file-utils.js` - Pure file utilities (✅ SAFE to modify)
  - `main.js` - Now thin IPC routing only
- 🔒 Sacred code clearly marked in imports
- 📦 Ready for mobile port (download logic is now portable)

## v0.12.0 (2026-02-24)
- ✅ Duplicate file handling: `file.txt` → `file (1).txt` like macOS
- ✅ "Sender went offline" detection and error message
- ✅ Unified download block UI (connecting → progress in same block)
- ✅ Folder structure preserved in downloads
- ✅ Cancel button works during download
- ✅ Error resilience (one file fails, others continue)

## v0.11.0 (2026-02-24)
- ✅ Folder sharing support
- ✅ Cancel download functionality
- ✅ 30s refresh loop for peer discovery
- ✅ Abort connection support

## v0.10.0 (2026-02-22)
- ✅ Core P2P sharing working
- ✅ Upload/download progress tracking
- ✅ Manifest system for file metadata
- ✅ CLI tool (peardrop share/download/list/stop)
- ✅ Glassmorphism UI

---

## Versioning Strategy

**Format:** `0.MAJOR.MINOR`
- Pre-1.0: Still in active development
- MAJOR: Significant feature additions
- MINOR: Bug fixes, small improvements

**Archives:** `~/Apps/peardrop-versions/v0.XX.X.zip`

Keep working versions archived so you can roll back if needed.
