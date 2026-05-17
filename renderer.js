/**
 * MODULE: renderer.js (PearDrop v2)
 * PURPOSE: PearDrop UI - Integrated ScrollList + DriveItem with PearCore backend
 * VERSION: 0.19.1
 * 
 * ARCHITECTURE:
 *   - Uses ScrollList v2 slot-based system
 *   - DriveItem components mount into slots
 *   - DriveActions module handles menu action → API calls
 *   - Same PearCore backend (IPC unchanged)
 *   - Modular, standalone components
 * 
 * EXPORTS: None (DOM script)
 * 
 * LAYOUT:
 *   - Header: Profile icon (top-left)
 *   - Drop zone: Compact file drop area
 *   - List: ScrollList with DriveItem slots
 *   - Input: Paste peardrop:// links
 *   - Actions: Share + Download buttons
 * 
 * EXTERNAL MODULES:
 *   - ScrollList (lib/scroll-list/scroll-list.js)
 *   - DriveItem (lib/drive-item/drive-item.js)
 *   - DriveActions (lib/drive-actions.js)
 *   - QrScanner (lib/qr-scanner/qr-scanner.js) — window.openQrScanner
 * 
 * IPC CALLS (via window.electronAPI):
 *   - hyperdriveShare, hyperdriveOpen, hyperdriveDownload
 *   - drivesList, drivesPause, drivesResume, drivesRemove, driveGet
 *   - openDownloads, openFile, showFileInFolder, getFilesStats
 *   - getDebug, setDebug
 * 
 * IPC LISTENERS:
 *   - onPeerConnected, onPeerDisconnected
 *   - onUploadProgress, onFilesDownloaded, onDrivesUpdated
 * 
 * DEBUG:
 *   In DevTools console:
 *   - peardrop.debug()      — Check if debug logging is enabled
 *   - peardrop.setDebug(true/false) — Toggle debug logging
 */

// ============================================================================
// DOM ELEMENTS
// ============================================================================

const dropZone = document.getElementById('dropZone');
const dropContent = document.getElementById('dropContent');
const filePreview = document.getElementById('filePreview');
const fileIcon = document.getElementById('fileIcon');
const fileName = document.getElementById('fileName');
const fileSize = document.getElementById('fileSize');
const clearBtn = document.getElementById('clearBtn');
const shareBtn = document.getElementById('shareBtn');
const downloadBtn = document.getElementById('downloadBtn');
const linkInput = document.getElementById('linkInput');
const listContainer = document.getElementById('listContainer');
const shareModal = document.getElementById('shareModal');
const shareLinkDisplay = document.getElementById('shareLinkDisplay');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const closeShareBtn = document.getElementById('closeShareBtn');
const toast = document.getElementById('toast');
const profileIcon = document.getElementById('profileIcon');
const tabShares = document.getElementById('tabShares');
const listMenuBtn = document.getElementById('listMenuBtn');
const listMenuDropdown = document.getElementById('listMenuDropdown');
const sortByTrigger = document.getElementById('sortByTrigger');
const sortSubmenu = document.getElementById('sortSubmenu');
const confirmOverlay = document.getElementById('confirmOverlay');
const confirmTitle = document.getElementById('confirmTitle');
const confirmMessage = document.getElementById('confirmMessage');
const confirmButtons = document.getElementById('confirmButtons');
const qrUploadBtn = document.getElementById('qrUploadBtn');

// ============================================================================
// STATE
// ============================================================================

let initialized = false;        // Guard against double init
let activeFiles = [];           // Files selected for sharing
let currentShareLink = null;    // Active share link
let pendingShareAnimationId = null; // Drive added silently behind share modal — animate on close
let driveActions = null;        // DriveActions instance (set in init)
let currentDriveId = null;      // Active drive ID
let drives = [];                // All drives from HyperdriveManager
let driveItems = new Map();     // driveId -> DriveItem instance
let scrollList = null;          // ScrollList instance

// Sort state
let sortField = 'recent';       // recent | status | size | custom
let sortDirection = 'desc';     // desc (default) | asc
let isReorderMode = false;      // Manual reorder mode active

// View state
let isExpandedView = false;     // false = compact, true = expanded

// ============================================================================
// INITIALIZATION
// ============================================================================

function init() {
    if (initialized) return;
    initialized = true;

    // Initialize DriveActions with electronAPI
    driveActions = new DriveActions(window.electronAPI);

    // Initialize ScrollList with DriveItem factory
    scrollList = new ScrollList(listContainer, {
        emptyMessage: 'No transfers yet — drop files above or paste a link to start',
        gap: 8,
        padding: 12,
        keyField: 'id',
        itemFactory: (slot, data) => {
            const item = new DriveItem(slot, {
                data: data,
                show: getPresetForDrive(data),
                theme: 'dark'
            });
            
            // Handle DriveItem actions via DriveActions module
            item.on('action', async (event) => {
                // Handle more-info specially - show info panel
                if (event.action === 'more-info') {
                    const result = await driveActions.handle(event.action, event.data);
                    // Merge stored drive data with fetched info
                    const storedDrive = drives.find(d => d.id === event.data.id);
                    const fullData = { 
                        ...event.data, 
                        ...storedDrive,
                        ...(result.success ? result.drive : {})
                    };
                    showDriveInfo(fullData);
                    return;
                }
                
                console.log('[DEBUG] DriveActions - calling action:', event.action, 'for drive:', event.data.id);

                // Remove flow: start a 5s undo countdown. Backend isn't called
                // until the timer expires. Undo cancels the timer and restores
                // the drive UI — no rollback needed because nothing ran yet.
                if (event.action === 'remove') {
                    startDeletionCountdown(event.data.id, {
                        onExpire: async () => {
                            const result = await driveActions.handle('remove', event.data);
                            // Backend always emits the 'drives-updated' { action: 'removed' }
                            // IPC, which removes the slot via the exit animation. The
                            // success flag can be `false` for benign reasons (e.g.,
                            // orphan drives missing from the state manifest) — only
                            // surface a toast when there's an actual error message.
                            if (!result.success && result.error) {
                                cancelDeletionCountdown(event.data.id);
                                showToast('Delete failed: ' + result.error, 'error');
                            }
                        }
                        // onUndo intentionally omitted — backend was never called.
                    });
                    return;
                }

                const result = await driveActions.handle(event.action, event.data);

                console.log('[DEBUG] DriveActions - result:', {
                    action: event.action,
                    driveId: event.data.id,
                    success: result.success,
                    error: result.error
                });

                // Update UI based on action result
                if (result.success) {
                    if (event.action === 'pause') {
                        updateDriveInList({ id: event.data.id, status: 'paused' });
                    } else if (event.action === 'resume') {
                        const status = event.data.type === 'share' ? 'sharing' : 'downloading';
                        updateDriveInList({ id: event.data.id, status });
                    }
                }
            });
            item.on('click', (data) => log('Drive clicked:', data.id));
            
            driveItems.set(data.id, item);
            return item;
        }
    });

    // Bind UI events
    bindDropZone();
    bindButtons();
    bindInput();
    bindQrUpload();
    bindModals();
    bindIPC();
    bindScrollListEvents();

    // One-time "share history was reset" notice — see HTML modal + IPC handler.
    // Safe to remove this call (and the function) once the notice is retired.
    showResetNoticeIfNeeded();

    // Initialize sort UI
    updateSortUI();

    // Load existing drives
    loadDrives();
}

/**
 * Get visibility preset based on drive state and view mode
 */
function getPresetForDrive(drive) {
    // Determine base preset type
    if (drive.progress != null && drive.progress < 1) {
        // Active download
        return isExpandedView ? 'download' : 'downloadCompact';
    } else if (drive.type === 'upload' || drive.type === 'share' || drive.status === 'sharing') {
        // Share/upload
        return isExpandedView ? 'share' : 'shareCompact';
    } else {
        // Complete/inactive
        return isExpandedView ? 'all' : 'compact';
    }
}

// ============================================================================
// DROP ZONE
// ============================================================================

function bindDropZone() {
    dropZone.addEventListener('click', selectFiles);
    dropZone.addEventListener('dragover', handleDragOver);
    dropZone.addEventListener('dragleave', handleDragLeave);
    dropZone.addEventListener('drop', handleDrop);
    clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearFiles();
    });
}

function selectFiles() {
    if (filePreview.classList.contains('active')) return;
    
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFiles(Array.from(e.target.files));
        }
    });
    input.click();
}

function handleDragOver(e) {
    e.preventDefault();
    dropZone.classList.add('drag-over');
}

function handleDragLeave(e) {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
}

function handleDrop(e) {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
        handleFiles(files);
    }
}

async function handleFiles(files) {
    if (!files || files.length === 0) return;
    
    const paths = files.map(f => f.path).filter(Boolean);
    if (paths.length === 0) return;
    
    try {
        // Use backend to get proper stats
        const stats = await window.electronAPI.getFilesStats(paths);
        
        activeFiles = stats.map(s => ({
            name: s.name,
            size: s.size,
            path: s.path,
            type: s.type,
            fileCount: s.fileCount,
            contents: s.contents
        }));
        
        updateDropZone();
    } catch (err) {
        console.error('Error getting file stats:', err);
        showToast('Error reading files', 'error');
    }
}

function updateDropZone() {
    if (activeFiles.length === 0) {
        dropContent.classList.remove('hidden');
        filePreview.classList.remove('active');
        dropZone.classList.remove('has-files');
        shareBtn.disabled = true;
        shareBtn.classList.remove('is-ready');
    } else {
        dropContent.classList.add('hidden');
        filePreview.classList.add('active');
        dropZone.classList.add('has-files');
        shareBtn.disabled = false;
        shareBtn.classList.add('is-ready');
        
        const file = activeFiles[0];
        fileIcon.textContent = getFileIcon(file.name);
        fileName.textContent = activeFiles.length > 1 
            ? `${activeFiles.length} items` 
            : file.name;
        
        const totalSize = activeFiles.reduce((sum, f) => sum + (f.size || 0), 0);
        fileSize.textContent = formatFileSize(totalSize);
    }
}

function clearFiles() {
    activeFiles = [];
    currentShareLink = null;
    currentDriveId = null;
    updateDropZone();
}

// ============================================================================
// BUTTONS & INPUT
// ============================================================================

function bindButtons() {
    shareBtn.addEventListener('click', startShare);
    downloadBtn.addEventListener('click', startDownload);
    
}

function bindInput() {
    linkInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            startDownload();
        }
    });
    
    // Auto-detect pasted links
    linkInput.addEventListener('paste', () => {
        setTimeout(() => {
            const val = linkInput.value.trim();
            if (val.startsWith('peardrop://')) {
                // Visual feedback
                linkInput.style.borderColor = 'rgba(168, 206, 56, 0.5)';
                setTimeout(() => {
                    linkInput.style.borderColor = '';
                }, 500);
            }
        }, 50);
    });
}

function bindQrUpload() {
    qrUploadBtn.addEventListener('click', () => {
        window.openQrScanner({ onResult: handleScannedLink });
    });
}

function handleScannedLink(text) {
    if (!text.startsWith('peardrop://')) {
        showToast('QR doesn\'t contain a PearDrop link', 'error');
        return;
    }
    linkInput.value = text;
    linkInput.classList.add('flash');
    setTimeout(() => linkInput.classList.remove('flash'), 500);
    showToast('Link captured', 'success');
    //startDownload(); // a plan for later on
}

async function startShare() {
    if (activeFiles.length === 0) return;

    shareBtn.disabled = true;
    shareBtn.classList.remove('is-ready');
    shareBtn.textContent = 'SHARING...';
    
    try {
        // Must pass { files: [...], options: {} } - not just paths!
        const shareName = activeFiles.length === 1 
            ? activeFiles[0].name 
            : `${activeFiles.length} files`;
        
        const result = await window.electronAPI.hyperdriveShare({
            files: activeFiles,
            options: { name: shareName }
        });
        
        if (result.success) {
            currentShareLink = result.shareLink;
            currentDriveId = result.driveId;
            showShareModal(result.shareLink);
            
            // Add to list but park it invisibly — the share-link modal is on
            // top, so the user shouldn't see the new item peeking through the
            // modal's backdrop blur. deferAnimation pre-collapses the slot;
            // closeShareModal() will play the entrance once the modal is gone.
            pendingShareAnimationId = result.driveId;
            addDriveToList({
                id: result.driveId,
                title: shareName,
                size: activeFiles.reduce((sum, f) => sum + (f.size || 0), 0),
                fileCount: activeFiles.length,
                files: activeFiles.map(f => ({ name: f.name, size: f.size })),
                status: 'sharing',
                peers: 0,
                type: 'share',
                shareLink: result.shareLink
            }, { deferAnimation: true });
            
            // Clear drop zone after successful share
            clearFiles();
        } else {
            showToast(result.error || 'Share failed', 'error');
        }
    } catch (err) {
        console.error('Share error:', err);
        showToast('Share failed: ' + err.message, 'error');
    } finally {
        shareBtn.textContent = 'SHARE';
        // Re-enable only if files remain. After a successful share,
        // clearFiles() drains activeFiles → button stays disabled until the
        // user picks more files. After a failed share, files are still here
        // so the user can retry.
        const hasFiles = activeFiles.length > 0;
        shareBtn.disabled = !hasFiles;
        shareBtn.classList.toggle('is-ready', hasFiles);
    }
}

async function startDownload() {
    const link = linkInput.value.trim();
    
    // No link? Flash the input
    if (!link) {
        linkInput.classList.add('flash');
        linkInput.focus();
        setTimeout(() => linkInput.classList.remove('flash'), 500);
        return;
    }
    
    // Invalid format? Flash
    if (!link.startsWith('peardrop://')) {
        linkInput.classList.add('flash');
        setTimeout(() => linkInput.classList.remove('flash'), 500);
        return;
    }
    
    linkInput.value = '';
    
    // 1. Check for duplicate (fast local check)
    const dupCheck = await window.electronAPI.hyperdriveCheckDuplicate({ shareLink: link });
    
    if (dupCheck.isDuplicate) {
        highlightExistingDrive(dupCheck.driveId);
        showAlreadyDownloadedMessage('Already downloaded');
        return;
    }
    
    // 2. Not a duplicate - add to list immediately (animate — fresh download)
    const tempId = `dl_${Date.now()}`;
    console.log('[PearDrop] Adding to list:', tempId);
    addDriveToList({
        id: tempId,
        title: 'Connecting...',
        status: 'connecting',
        progress: 0,
        peers: 0,
        type: 'download',
        shareLink: link
    }, { animate: true });
    console.log('[PearDrop] Added to list, driveItems size:', driveItems.size);
    
    // 3. Open drive (skip duplicate check since we already did it)
    const openResult = await window.electronAPI.hyperdriveOpen({ shareLink: link, forceOpen: true });
    
    if (!openResult.success) {
        updateDriveInList({ id: tempId, status: 'error' });
        setTimeout(() => removeDriveFromList(tempId, { animate: true }), 5000);
        return;
    }
    
    const driveId = openResult.driveId;
    const hasPeer = openResult.peerConnected === true;
    const hasData = openResult.shareName && openResult.files?.length > 0;
    
    // No peer and no data - stay in connecting state
    if (!hasPeer && !hasData) {
        console.log('[PearDrop] No peer connected, staying in connecting state');
        // Just update the tempId to use real driveId, keep status as connecting
        updateDriveInList({ 
            id: tempId, 
            title: 'Waiting for peer...',
            status: 'connecting'
        });
        // TODO: Could set up a retry/listen mechanism here
        return;
    }
    
    // Have peer or data - proceed with download
    removeDriveFromList(tempId);
    
    addDriveToList({
        id: driveId,
        title: openResult.shareName || 'Download',
        size: openResult.totalBytes || 0,
        fileCount: openResult.files?.length || 1,
        files: (openResult.files || []).map(f => ({ name: f.name, size: f.size })),
        status: 'downloading',
        progress: 0,
        peers: hasPeer ? 1 : 0,
        type: 'download',
        shareLink: link
    });
    
    handleDownload(driveId, link);
}

// Highlight an existing drive in the list and scroll to it
function highlightExistingDrive(driveId) {
    // scroll-list uses data-id attribute
    const driveEl = document.querySelector(`[data-id="${driveId}"]`);
    console.log('[PearDrop] Highlighting drive:', driveId, 'found:', !!driveEl);
    if (driveEl) {
        // Scroll into view
        driveEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        // Add highlight class
        driveEl.classList.add('highlight-pulse');
        setTimeout(() => driveEl.classList.remove('highlight-pulse'), 2000);
    }
}

// Show "already downloaded" message above the download bar
function showAlreadyDownloadedMessage(message) {
    console.log('[PearDrop] Showing message:', message);
    
    // Remove any existing message
    const existing = document.querySelector('.already-downloaded-msg');
    if (existing) existing.remove();
    
    // Create message element
    const msgEl = document.createElement('div');
    msgEl.className = 'already-downloaded-msg';
    msgEl.textContent = message;
    
    // Insert above the link input container
    const inputContainer = document.querySelector('.link-input-container');
    if (inputContainer) {
        inputContainer.parentElement.insertBefore(msgEl, inputContainer);
    } else {
        // Fallback: insert at top of main content
        const mainContent = document.querySelector('.main-content');
        if (mainContent) mainContent.prepend(msgEl);
    }
    
    // Fade out and remove after 3 seconds
    setTimeout(() => {
        msgEl.classList.add('fade-out');
        setTimeout(() => msgEl.remove(), 500);
    }, 3000);
    
    // Also remove on input focus
    linkInput.addEventListener('focus', () => msgEl.remove(), { once: true });
}

// Background download handler
async function handleDownload(driveId, link) {
    try {
        const downloadResult = await window.electronAPI.hyperdriveDownload({ driveId });
        
        if (downloadResult.success) {
            updateDriveInList({ id: driveId, status: 'complete', progress: 1 });
        } else {
            updateDriveInList({ id: driveId, status: 'error' });
        }
    } catch (err) {
        console.error('Download error:', err);
        updateDriveInList({ id: driveId, status: 'error' });
    }
}

// ============================================================================
// MODALS
// ============================================================================

function bindModals() {
    copyLinkBtn.addEventListener('click', copyShareLink);
    closeShareBtn.addEventListener('click', closeShareModal);

    // Close on backdrop click
    shareModal.addEventListener('click', (e) => {
        if (e.target === shareModal) closeShareModal();
    });
}

// One-time "share history was reset" notice.
//
// Gating logic:
//   1. If user already dismissed (SEEN_FLAG) → skip.
//   2. If lastSeenVersion is tracked → show only when the user has crossed
//      the fix boundary (lastSeen < FIX_VERSION ≤ current).
//   3. If lastSeenVersion is missing (first launch on this build) → use
//      legacy-data presence as a tiebreaker: fresh install → no notice;
//      old data on disk → notice.
//
// FIX_VERSION = the first build that contained the persistence fix.
// Bump it forward only if a future fix produces a new one-time notice.
//
// Safe to retire by removing this function, its call site, the modal
// HTML/CSS, the preload bridges, and the matching IPC handlers.
async function showResetNoticeIfNeeded() {
    const SEEN_FLAG = 'peardrop:resetNoticeSeen';
    const VERSION_KEY = 'peardrop:lastSeenVersion';
    const FIX_VERSION = '0.19.1';

    if (localStorage.getItem(SEEN_FLAG) === '1') return;

    let currentVersion = null;
    try {
        currentVersion = await window.electronAPI.getAppVersion();
    } catch {
        return; // can't reach main — bail silently
    }
    if (!currentVersion) return;

    const lastSeen = localStorage.getItem(VERSION_KEY);
    let shouldShow = false;

    if (lastSeen) {
        // We know which version they ran last. Show only on first launch
        // of a build that includes the fix, when the previous build didn't.
        shouldShow = semverLt(lastSeen, FIX_VERSION) && !semverLt(currentVersion, FIX_VERSION);
    } else {
        // No tracked version yet — could be either a true fresh install or
        // a first launch after upgrading from a pre-tracking build. Use the
        // legacy state files as a tiebreaker.
        try {
            const { present } = await window.electronAPI.checkLegacyDataPresent();
            shouldShow = present && !semverLt(currentVersion, FIX_VERSION);
        } catch {
            shouldShow = false;
        }
    }

    // Always record the current version so we never re-check this case again
    localStorage.setItem(VERSION_KEY, currentVersion);

    if (!shouldShow) {
        localStorage.setItem(SEEN_FLAG, '1');
        return;
    }

    const modal = document.getElementById('resetNoticeModal');
    const okBtn = document.getElementById('resetNoticeOkBtn');
    if (!modal || !okBtn) return;

    const dismiss = () => {
        modal.classList.remove('active');
        localStorage.setItem(SEEN_FLAG, '1');
    };
    okBtn.addEventListener('click', dismiss, { once: true });
    modal.addEventListener('click', (e) => {
        if (e.target === modal) dismiss();
    }, { once: true });

    modal.classList.add('active');
}

// Tiny semver "less-than" comparison for MAJOR.MINOR.PATCH strings.
// Only used by showResetNoticeIfNeeded — remove when the notice is retired.
function semverLt(a, b) {
    const aa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const bb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        const av = aa[i] || 0;
        const bv = bb[i] || 0;
        if (av < bv) return true;
        if (av > bv) return false;
    }
    return false;
}

async function showShareModal(link) {
    shareLinkDisplay.textContent = link;
    shareModal.classList.add('active');

    // Generate QR code
    const qrCanvas = document.getElementById('shareQrCode');
    try {
        const dataUrl = await window.electronAPI.generateQr(link);
        const img = new Image();
        img.onload = () => {
            const ctx = qrCanvas.getContext('2d');
            ctx.clearRect(0, 0, qrCanvas.width, qrCanvas.height);
            ctx.drawImage(img, 0, 0, qrCanvas.width, qrCanvas.height);
            qrCanvas.style.display = 'block';
        };
        img.src = dataUrl;
    } catch (err) {
        qrCanvas.style.display = 'none';
    }
}

function closeShareModal() {
    shareModal.classList.remove('active');
    document.getElementById('shareQrCode').style.display = 'none';

    // The new share was added silently behind this modal so updates could
    // route to it during the modal's lifetime. Animate it in now that the
    // user can actually see the list.
    if (pendingShareAnimationId) {
        const id = pendingShareAnimationId;
        pendingShareAnimationId = null;
        scrollList.animateSlotEntrance(id);
    }
}

async function copyShareLink() {
    const link = shareLinkDisplay.textContent;
    try {
        await navigator.clipboard.writeText(link);
        copyLinkBtn.textContent = 'Copied!';
        setTimeout(() => {
            copyLinkBtn.textContent = 'Copy';
        }, 1500);
    } catch (err) {
        showToast('Failed to copy', 'error');
    }
}

// ============================================================================
// DRIVE LIST MANAGEMENT
// ============================================================================

function addDriveToList(drive, options = {}) {
    console.log('[addDriveToList] called with:', drive.id, drive.title, drive.status);

    // Check if already exists
    if (driveItems.has(drive.id)) {
        console.log('[addDriveToList] already exists, updating');
        updateDriveInList(drive);
        return;
    }

    // Add timestamp for sorting
    drive.addedAt = Date.now();

    // Always add to top of list first (newest at top)
    drives.unshift(drive);
    const result = scrollList.addItem(drive, {
        prepend: true,
        animate: options.animate === true,
        deferAnimation: options.deferAnimation === true
    });
    console.log('[addDriveToList] scrollList.addItem result:', result?.id, 'component:', !!result?.component);

    // If we have a non-recent sort active, re-apply sorting
    // (but new items still briefly appear at top, then sort into place)
    if (sortField !== 'recent' && sortField !== 'custom') {
        setTimeout(() => applySorting(), 100);
    }
}

function updateDriveInList(drive) {
    const item = driveItems.get(drive.id);
    const idx = drives.findIndex(d => d.id === drive.id);
    const oldStatus = idx >= 0 ? drives[idx].status : null;
    
    // Merge update into stored drive data FIRST
    if (idx >= 0) {
        drives[idx] = { ...drives[idx], ...drive };
    }
    
    if (item) {
        item.update(drive);
        
        // Update preset based on FULL drive data (not just the update)
        const fullDrive = idx >= 0 ? drives[idx] : drive;
        const newPreset = getPresetForDrive(fullDrive);
        item.setVisibility(newPreset);
    }
    
    // Re-sort if relevant field changed
    if (sortField === 'status' && drive.status && drive.status !== oldStatus) {
        applySorting();
    } else if (sortField === 'peers' && drive.peers !== undefined) {
        applySorting();
    }
}

// Active per-drive deletion countdowns. Map<driveId, { intervalId, overlay, slot }>.
// Used by startDeletionCountdown / cancelDeletionCountdown so an app close or
// repeat-remove can clean up cleanly.
const deletionTimers = new Map();

// Begin a 5-second undo window before actually deleting a drive. Inserts a
// circular countdown button (replacing the right-side menu visually) and dims
// the slot's content. If the user clicks the button → onUndo runs and the
// drive is restored (no backend call ever fired). If the timer expires →
// onExpire runs (this is when the real backend delete should happen).
function startDeletionCountdown(driveId, { onExpire, onUndo } = {}) {
    const totalSeconds = 5;
    const slotData = scrollList && scrollList._slots && scrollList._slots.get(driveId);
    if (!slotData || !slotData.slot) {
        // No slot to attach to — just fire the expire path immediately
        if (typeof onExpire === 'function') onExpire();
        return;
    }

    // Cancel any prior countdown on this drive
    if (deletionTimers.has(driveId)) {
        cancelDeletionCountdown(driveId);
    }

    const slot = slotData.slot;
    slot.classList.add('is-pending-delete');

    const overlay = document.createElement('div');
    overlay.className = 'drive-delete-countdown';
    overlay.innerHTML =
        '<div class="drive-undo-timer" aria-label="Time until delete">' +
            '<svg class="drive-undo-ring" viewBox="0 0 36 36" aria-hidden="true">' +
                '<circle class="drive-undo-ring-bg" cx="18" cy="18" r="15.9155"/>' +
                '<circle class="drive-undo-ring-fg" cx="18" cy="18" r="15.9155"/>' +
            '</svg>' +
            '<span class="drive-undo-label">' + totalSeconds + '</span>' +
        '</div>' +
        '<button class="drive-undo-btn" type="button" title="Cancel delete">Undo</button>';
    slot.appendChild(overlay);

    const undoBtn = overlay.querySelector('.drive-undo-btn');
    const ringFg = overlay.querySelector('.drive-undo-ring-fg');
    const label = overlay.querySelector('.drive-undo-label');

    // Kick off the ring drain across totalSeconds. Double-rAF so the browser
    // commits the initial (full ring) state before transitioning to empty.
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            ringFg.style.transition = 'stroke-dashoffset ' + totalSeconds + 's linear';
            ringFg.style.strokeDashoffset = '100';
        });
    });

    let secondsLeft = totalSeconds;
    const intervalId = setInterval(() => {
        secondsLeft -= 1;
        if (secondsLeft > 0) {
            label.textContent = secondsLeft;
        } else {
            clearInterval(intervalId);
            // Number disappears (drained ring tells the visual story);
            // the button takes over communicating the state.
            label.textContent = '';
            undoBtn.disabled = true;
            undoBtn.textContent = 'Deleting…';
            const entry = deletionTimers.get(driveId);
            if (entry) entry.expired = true;
            if (typeof onExpire === 'function') onExpire();
        }
    }, 1000);

    undoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cancelDeletionCountdown(driveId);
        if (typeof onUndo === 'function') onUndo();
    });

    deletionTimers.set(driveId, { intervalId, overlay, slot, expired: false });
}

function cancelDeletionCountdown(driveId) {
    const entry = deletionTimers.get(driveId);
    if (!entry) return;
    clearInterval(entry.intervalId);
    if (entry.overlay && entry.overlay.parentNode) entry.overlay.remove();
    if (entry.slot) entry.slot.classList.remove('is-pending-delete');
    deletionTimers.delete(driveId);
}

// Show / hide a "Deleting…" overlay on a drive slot while the backend works.
// Backend removal can take a moment (close swarm, close drive, rm storage),
// so the user needs visible feedback that something is happening. The slot
// is dimmed underneath; the overlay sits above with a spinner + label.
function setDriveDeleting(driveId, isDeleting) {
    const slotData = scrollList && scrollList._slots && scrollList._slots.get(driveId);
    if (!slotData || !slotData.slot) return;
    const slot = slotData.slot;

    if (isDeleting) {
        slot.classList.add('is-deleting');
        if (!slot.querySelector('.drive-deleting-overlay')) {
            const overlay = document.createElement('div');
            overlay.className = 'drive-deleting-overlay';
            overlay.innerHTML =
                '<span class="drive-deleting-spinner" aria-hidden="true"></span>' +
                '<span>Deleting…</span>';
            slot.appendChild(overlay);
        }
    } else {
        slot.classList.remove('is-deleting');
        const overlay = slot.querySelector('.drive-deleting-overlay');
        if (overlay) overlay.remove();
    }
}

function removeDriveFromList(driveId, options = {}) {
    console.log('[DEBUG] removeDriveFromList called:', {
        driveId,
        animate: options.animate === true,
        driveItemExists: driveItems.has(driveId),
        scrollListHasSlot: scrollList._slots?.has(driveId) || 'unknown',
        drivesArrayLength: drives.length,
        driveInArray: drives.some(d => d.id === driveId)
    });

    // Step 1: Remove from driveItems Map
    const hadDriveItem = driveItems.has(driveId);
    driveItems.delete(driveId);
    console.log('[DEBUG] After driveItems.delete():', {
        hadDriveItem,
        nowHas: driveItems.has(driveId)
    });

    // Step 2: Remove from ScrollList (animated if requested — the slot stays
    // in the DOM during the transition but is detached from internal tracking)
    const hadScrollListSlot = scrollList._slots?.has(driveId);
    console.log('[DEBUG] Before scrollList.removeItem():', {
        hadScrollListSlot,
        scrollListSlotCount: scrollList._slots?.size || 'unknown'
    });

    const scrollListResult = scrollList.removeItem(driveId, {
        animate: options.animate === true
    });
    console.log('[DEBUG] After scrollList.removeItem():', {
        result: scrollListResult,
        nowHasSlot: scrollList._slots?.has(driveId) || 'unknown',
        scrollListSlotCount: scrollList._slots?.size || 'unknown'
    });

    // Step 3: Remove from drives array
    const originalLength = drives.length;
    drives = drives.filter(d => d.id !== driveId);
    console.log('[DEBUG] After drives array filter:', {
        originalLength,
        newLength: drives.length,
        removed: originalLength - drives.length
    });
}

async function loadDrives() {
    try {
        const result = await window.electronAPI.drivesList();
        if (result.success && Array.isArray(result.drives)) {
            for (const drive of result.drives) {
                addDriveToList(normalizeDrive(drive));
            }
        }
    } catch (err) {
        console.error('Error loading drives:', err);
    }
}

function normalizeDrive(drive) {
    return {
        id: drive.id || drive.driveId,
        title: drive.name || drive.fileName || drive.title || 'Unknown',
        size: drive.totalBytes || drive.size || 0,
        fileCount: drive.fileCount || drive.files?.length || 1,
        files: drive.files || [],
        status: drive.status || 'sharing',
        progress: drive.progress,
        speed: drive.speed,
        peers: drive.peers || 0,
        type: drive.type || 'share',
        shareLink: drive.shareLink
    };
}

// ============================================================================
// IPC EVENT HANDLERS
// ============================================================================

function bindIPC() {
    // Peer connections
    window.electronAPI.onPeerConnected?.((event, data) => {
        const driveId = data.driveId;
        const item = driveItems.get(driveId);
        if (item) {
            const drive = drives.find(d => d.id === driveId);
            if (drive) {
                drive.peers = (drive.peers || 0) + 1;
                item.update({ peers: drive.peers });
            }
        }
    });
    
    window.electronAPI.onPeerDisconnected?.((event, data) => {
        const driveId = data.driveId;
        const item = driveItems.get(driveId);
        if (item) {
            const drive = drives.find(d => d.id === driveId);
            if (drive && drive.peers > 0) {
                drive.peers--;
                item.update({ peers: drive.peers });
            }
        }
    });
    
    // Progress updates (covers both upload and download via 'upload-progress' event)
    // Data format from downloader: { driveId, peerId, percent, bytesFormatted, totalFormatted, speedFormatted }
    window.electronAPI.onUploadProgress?.((event, data) => {
        log('Progress event:', data);
        const { driveId, peerId, percent, speedFormatted } = data;
        const item = driveItems.get(driveId);
        if (!item) {
            log('Progress: No item found for driveId:', driveId);
            return;
        }
        
        // If this is a download (peerId === 'self'), update progress
        if (peerId === 'self') {
            // Convert percent (0-100) to progress (0-1)
            const progress = typeof percent === 'number' ? percent / 100 : 0;
            // Parse speed from formatted string (e.g., "1.5 MB/s" -> bytes)
            const speed = parseSpeed(speedFormatted);
            
            log('Progress: Updating download:', { driveId, progress, speed });
            item.update({
                status: 'downloading',
                progress: progress,
                speed: speed
            });
        } else {
            // This is an upload (someone downloading from us)
            const speed = parseSpeed(speedFormatted);
            item.update({ 
                status: 'sharing',
                speed: speed
            });
        }
    });
    
    // Download complete
    window.electronAPI.onFilesDownloaded?.((event, data) => {
        const { driveId, files } = data;
        const item = driveItems.get(driveId);
        if (item) {
            item.update({
                status: 'complete',
                progress: 1,
                fileCount: files?.length || 1
            });
            showToast('Download complete!', 'success');
        }
    });
    
    // Drives updated (from HyperdriveManager)
    window.electronAPI.onDrivesUpdated?.((event, data) => {
        if (data.action === 'loaded') {
            // Complete drives list loaded (e.g., after migration or startup)
            console.log('[PearDrop] Drives loaded, refreshing list:', data.drives?.length || 0);
            if (data.drives) {
                for (const drive of data.drives) {
                    const normalized = normalizeDrive(drive);
                    if (driveItems.has(normalized.id)) {
                        updateDriveInList(normalized);
                    } else {
                        addDriveToList(normalized);
                    }
                }
            }
        } else if (data.action === 'removed' && data.id) {
            // Drive was deleted from backend
            console.log('[DEBUG] onDrivesUpdated - removal event received:', {
                action: data.action,
                id: data.id,
                driveItemsSize: driveItems.size,
                scrollListSize: scrollList._slots?.size || 'unknown',
                driveItemExists: driveItems.has(data.id),
                scrollListHasSlot: scrollList._slots?.has(data.id) || 'unknown'
            });
            
            removeDriveFromList(data.id, { animate: true });

            console.log('[DEBUG] onDrivesUpdated - after removal:', {
                driveItemsSize: driveItems.size,
                scrollListSize: scrollList._slots?.size || 'unknown',
                driveItemExists: driveItems.has(data.id),
                scrollListHasSlot: scrollList._slots?.has(data.id) || 'unknown'
            });
        } else if (data.drives) {
            // Legacy format or individual drive updates — animate the new ones
            for (const drive of data.drives) {
                const normalized = normalizeDrive(drive);
                if (driveItems.has(normalized.id)) {
                    updateDriveInList(normalized);
                } else {
                    addDriveToList(normalized, { animate: true });
                }
            }
        }
    });
}

// ============================================================================
// UTILITIES
// ============================================================================

function formatFileSize(bytes) {
    if (bytes == null || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Parse speed string like "1.5 MB/s" back to bytes/sec
function parseSpeed(speedStr) {
    if (!speedStr || typeof speedStr !== 'string') return 0;
    const match = speedStr.match(/([\d.]+)\s*(B|KB|MB|GB)/i);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    const multipliers = { 'B': 1, 'KB': 1024, 'MB': 1024*1024, 'GB': 1024*1024*1024 };
    return value * (multipliers[unit] || 1);
}

function getFileIcon(filename) {
    if (!filename) return '📄';
    const ext = filename.split('.').pop()?.toLowerCase();
    const icons = {
        // Images
        jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️',
        // Video
        mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', webm: '🎬',
        // Audio
        mp3: '🎵', wav: '🎵', ogg: '🎵', flac: '🎵', m4a: '🎵',
        // Documents
        pdf: '📕', doc: '📘', docx: '📘', txt: '📄', md: '📝',
        // Archives
        zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
        // Code
        js: '⚙️', ts: '⚙️', py: '🐍', html: '🌐', css: '🎨', json: '📋'
    };
    return icons[ext] || '📄';
}

const TOAST_ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>'
};

function showToast(message, type = 'info') {
    toast.className = 'toast ' + type;
    toast.innerHTML = '';

    const iconSvg = TOAST_ICONS[type];
    if (iconSvg) {
        const icon = document.createElement('span');
        icon.className = 'toast-icon';
        icon.innerHTML = iconSvg;
        toast.appendChild(icon);
    }

    const msg = document.createElement('span');
    msg.className = 'toast-message';
    msg.textContent = message;
    toast.appendChild(msg);

    toast.classList.add('visible');

    setTimeout(() => {
        toast.classList.remove('visible');
    }, 3000);
}

// ============================================================================
// PROFILE & LIST MENU
// ============================================================================

profileIcon.addEventListener('click', () => {
    showToast('Profile settings coming soon', 'info');
});

// List menu (3 dots)
let listMenuOpen = false;
let sortSubmenuOpen = false;

const listMenuContainer = listMenuBtn.parentElement;

listMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    
    // If in reorder mode, clicking the button exits reorder mode
    if (isReorderMode) {
        disableReorderMode();
        // Switch to custom sort since user made manual changes
        sortField = 'custom';
        updateSortUI();
        showToast('Custom order saved', 'success');
        return;
    }
    
    listMenuOpen = !listMenuOpen;
    listMenuDropdown.classList.toggle('open', listMenuOpen);
    listMenuContainer.classList.toggle('menu-open', listMenuOpen);
    if (!listMenuOpen) {
        sortSubmenu.classList.remove('open');
        sortSubmenuOpen = false;
    }
});

// Sort By hover/click to open submenu
function positionSubmenu() {
    const dropdownRect = listMenuDropdown.getBoundingClientRect();
    const triggerRect = sortByTrigger.getBoundingClientRect();
    const submenuWidth = 160; // min-width from CSS
    
    // Position submenu to the side of the dropdown (attached to parent menu)
    // Try right side first
    let left = dropdownRect.right + 4;
    let flipLeft = false;
    
    // If would overflow right edge, flip to left side of dropdown
    if (left + submenuWidth > window.innerWidth - 10) {
        left = dropdownRect.left - submenuWidth - 4;
        flipLeft = true;
    }
    
    // Vertically align with the Sort By trigger item
    sortSubmenu.style.top = triggerRect.top + 'px';
    sortSubmenu.style.left = left + 'px';
    sortSubmenu.classList.toggle('flip-left', flipLeft);
}

sortByTrigger.addEventListener('mouseenter', () => {
    if (listMenuOpen) {
        positionSubmenu();
        sortSubmenu.classList.add('open');
        sortSubmenuOpen = true;
    }
});

sortByTrigger.addEventListener('mouseleave', (e) => {
    // Don't close if moving to submenu
    if (!sortSubmenu.contains(e.relatedTarget)) {
        setTimeout(() => {
            if (!sortSubmenu.matches(':hover')) {
                sortSubmenu.classList.remove('open');
                sortSubmenuOpen = false;
            }
        }, 100);
    }
});

sortSubmenu.addEventListener('mouseleave', () => {
    sortSubmenu.classList.remove('open');
    sortSubmenuOpen = false;
});

// Close menu on outside click
document.addEventListener('click', (e) => {
    if (listMenuOpen && !listMenuBtn.contains(e.target) && !listMenuDropdown.contains(e.target) && !sortSubmenu.contains(e.target)) {
        listMenuOpen = false;
        listMenuDropdown.classList.remove('open');
        listMenuContainer.classList.remove('menu-open');
        sortSubmenu.classList.remove('open');
        sortSubmenuOpen = false;
    }
});

// Handle sort submenu clicks
sortSubmenu.addEventListener('click', (e) => {
    const item = e.target.closest('.list-submenu-item');
    if (!item) return;
    
    e.stopPropagation();
    const sort = item.dataset.sort;
    
    if (sort === 'reorder') {
        // Enable reorder mode and switch to custom sort
        sortField = 'custom';
        updateSortUI();
        enableReorderMode();
    } else if (sort === 'custom') {
        // Just switch to custom ordering (preserve current order)
        sortField = 'custom';
        disableReorderMode();
        updateSortUI();
    } else {
        // If same sort clicked, toggle direction
        if (sort === sortField && sortField !== 'custom') {
            sortDirection = sortDirection === 'desc' ? 'asc' : 'desc';
        } else {
            sortField = sort;
            sortDirection = 'desc'; // Default to descending for new sort
        }
        disableReorderMode();
        applySorting();
        updateSortUI();
    }
    
    // Close menus
    listMenuOpen = false;
    listMenuDropdown.classList.remove('open');
    listMenuContainer.classList.remove('menu-open');
    sortSubmenu.classList.remove('open');
    sortSubmenuOpen = false;
});

// Handle menu item clicks (non-sort items)
listMenuDropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.list-menu-item:not(.has-submenu)');
    if (!item) return;
    
    const action = item.dataset.action;
    if (!action) return;
    
    listMenuOpen = false;
    listMenuDropdown.classList.remove('open');
    listMenuContainer.classList.remove('menu-open');
    sortSubmenu.classList.remove('open');
    
    switch (action) {
        case 'select-shares':
            showToast('Select shares coming soon', 'info');
            break;
        case 'toggle-view':
            toggleViewMode();
            break;
        case 'pause-all':
            pauseAllTransfers();
            break;
        case 'resume-all':
            resumeAllTransfers();
            break;
        case 'clear-completed':
            clearCompletedTransfers();
            break;
    }
});

// ============================================================================
// LIST ACTIONS
// ============================================================================

async function pauseAllTransfers() {
    const activeDrives = drives.filter(d => 
        d.status === 'downloading' || d.status === 'sharing' || d.status === 'connecting'
    );
    
    if (activeDrives.length === 0) {
        showToast('No active transfers to pause', 'info');
        return;
    }
    
    let paused = 0;
    for (const drive of activeDrives) {
        try {
            const result = await window.electronAPI.drivesPause?.(drive.id);
            if (result?.success) {
                updateDriveInList({ id: drive.id, status: 'paused' });
                paused++;
            }
        } catch (err) {
            console.error('Failed to pause:', drive.id, err);
        }
    }
    
    showToast(`Paused ${paused} transfer${paused !== 1 ? 's' : ''}`, 'success');
}

async function resumeAllTransfers() {
    const pausedDrives = drives.filter(d => d.status === 'paused');
    
    if (pausedDrives.length === 0) {
        showToast('No paused transfers to resume', 'info');
        return;
    }
    
    let resumed = 0;
    for (const drive of pausedDrives) {
        try {
            const result = await window.electronAPI.drivesResume?.(drive.id);
            if (result?.success) {
                const status = drive.type === 'share' ? 'sharing' : 'downloading';
                updateDriveInList({ id: drive.id, status });
                resumed++;
            }
        } catch (err) {
            console.error('Failed to resume:', drive.id, err);
        }
    }
    
    showToast(`Resumed ${resumed} transfer${resumed !== 1 ? 's' : ''}`, 'success');
}

async function clearCompletedTransfers() {
    // Find all clearable items:
    // - Downloads that are complete, inactive, or not actively downloading
    // - Shares that are complete, inactive, paused, or not actively connected
    const clearable = drives.filter(d => {
        // Active downloads in progress - keep
        if (d.type === 'download' && d.status === 'downloading' && d.progress < 1) {
            return false;
        }
        // Active shares with peers connected - these need explicit clearing
        if (d.type === 'share' && d.status === 'sharing' && d.peers > 0) {
            return true; // Include but will warn
        }
        // Everything else: complete, inactive, error, paused, disconnected
        return d.status === 'complete' || 
               d.status === 'sharing' || 
               d.status === 'error' ||
               d.status === 'paused' ||
               (d.type === 'download' && d.progress >= 1) ||
               (d.type === 'share' && (!d.peers || d.peers === 0));
    });
    
    if (clearable.length === 0) {
        showToast('Nothing to clear', 'info');
        return;
    }
    
    // Count shares vs downloads for the message
    const shareCount = clearable.filter(d => d.type === 'share').length;
    const downloadCount = clearable.filter(d => d.type === 'download').length;
    
    // Build message
    let itemList = [];
    if (downloadCount > 0) itemList.push(`${downloadCount} download${downloadCount !== 1 ? 's' : ''}`);
    if (shareCount > 0) itemList.push(`${shareCount} share${shareCount !== 1 ? 's' : ''}`);
    
    const warningMsg = shareCount > 0 
        ? '\n\n⚠️ Are you sure you want to stop sharing these items? Others may not be able to download them anymore.'
        : '';
    
    showConfirm({
        title: 'Clear Completed',
        message: `This will remove ${itemList.join(' and ')} from the list.${warningMsg}`,
        buttons: [
            { label: 'Cancel', class: 'secondary', action: () => {} },
            { 
                label: `Clear ${clearable.length} Item${clearable.length !== 1 ? 's' : ''}`, 
                class: shareCount > 0 ? 'danger' : 'primary', 
                action: () => doClearTransfers(clearable, [])
            }
        ]
    });
}

async function doClearTransfers(downloads, uploads) {
    const toClear = [...downloads, ...uploads];
    let cleared = 0;
    
    for (const drive of toClear) {
        try {
            const result = await window.electronAPI.drivesRemove?.({ id: drive.id, deleteFiles: false });
            if (result?.success !== false) {
                removeDriveFromList(drive.id, { animate: true });
                cleared++;
            }
        } catch (err) {
            console.error('Failed to remove:', drive.id, err);
        }
    }
    
    showToast(`Cleared ${cleared} item${cleared !== 1 ? 's' : ''}`, 'success');
}

// ============================================================================
// VIEW MODE (Expanded / Compact)
// ============================================================================

const toggleViewLabel = document.getElementById('toggleViewLabel');

/**
 * Toggle between expanded and compact view for all items
 */
function toggleViewMode() {
    isExpandedView = !isExpandedView;
    
    // Update button label
    if (toggleViewLabel) {
        toggleViewLabel.textContent = isExpandedView ? 'Compact View' : 'Expanded View';
    }
    
    // Update all items with new preset
    for (const [id, item] of driveItems) {
        const drive = drives.find(d => d.id === id);
        if (drive) {
            const newPreset = getPresetForDrive(drive);
            item.setVisibility(newPreset);
        }
    }
    
    showToast(isExpandedView ? 'Expanded view' : 'Compact view', 'info');
}

// ============================================================================
// SORTING
// ============================================================================

const STATUS_PRIORITY = {
    'downloading': 1,
    'connecting': 2,
    'sharing': 3,
    'complete': 4,
    'paused': 5,
    'error': 6
};

function getFileExtension(filename) {
    if (!filename) return '';
    const parts = filename.split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function applySorting() {
    if (sortField === 'custom' || drives.length === 0) return;
    
    // Sort the drives array
    const sorted = [...drives].sort((a, b) => {
        let comparison = 0;
        
        switch (sortField) {
            case 'recent':
                // Sort by addedAt timestamp (or id which contains timestamp)
                const timeA = a.addedAt || parseInt(a.id?.split('_')[1]) || 0;
                const timeB = b.addedAt || parseInt(b.id?.split('_')[1]) || 0;
                comparison = timeB - timeA; // Most recent first by default
                break;
                
            case 'status':
                const priorityA = STATUS_PRIORITY[a.status] || 99;
                const priorityB = STATUS_PRIORITY[b.status] || 99;
                comparison = priorityA - priorityB; // Lower priority number = higher in list
                break;
                
            case 'size':
                comparison = (b.size || 0) - (a.size || 0); // Largest first by default
                break;
                
            case 'name':
                const nameA = (a.title || a.name || '').toLowerCase();
                const nameB = (b.title || b.name || '').toLowerCase();
                comparison = nameA.localeCompare(nameB); // A-Z by default
                break;
                
            case 'peers':
                comparison = (b.peers || 0) - (a.peers || 0); // Most peers first by default
                break;
                
            case 'filetype':
                const extA = getFileExtension(a.title || a.name);
                const extB = getFileExtension(b.title || b.name);
                comparison = extA.localeCompare(extB); // A-Z by extension
                break;
        }
        
        // Apply direction
        return sortDirection === 'asc' ? -comparison : comparison;
    });
    
    // Reorder in ScrollList to match sorted order
    sorted.forEach((drive, index) => {
        const currentIndex = scrollList.getSlotIds().indexOf(drive.id);
        if (currentIndex !== index && currentIndex !== -1) {
            scrollList.reorderSlot(drive.id, index, false); // No animation for bulk reorder
        }
    });
    
    // Update drives array order
    drives = sorted;
}

function updateSortUI() {
    // Update active state and arrows in submenu
    sortSubmenu.querySelectorAll('.list-submenu-item').forEach(item => {
        const sort = item.dataset.sort;
        const isActive = sort === sortField;
        item.classList.toggle('active', isActive);
        
        const arrowEl = item.querySelector('.sort-arrow');
        if (arrowEl && sort !== 'reorder') {
            if (sort === sortField && sort !== 'custom') {
                arrowEl.textContent = sortDirection === 'desc' ? '↓' : '↑';
            } else {
                arrowEl.textContent = '';
            }
        }
    });
}

function enableReorderMode() {
    isReorderMode = true;
    scrollList.setReorderMode(true);
    listMenuBtn.classList.add('reorder-active');
    showToast('Drag to reorder • Click menu button to save', 'info');
}

function disableReorderMode() {
    if (!isReorderMode) return;
    isReorderMode = false;
    scrollList.setReorderMode(false);
    listMenuBtn.classList.remove('reorder-active');
}

// Listen for manual reorder events from ScrollList
function bindScrollListEvents() {
    scrollList.on('slot:reordered', ({ id, fromIndex, toIndex }) => {
        // User manually reordered - update drives array to match new order
        // (sortField will be set to 'custom' when user exits reorder mode)
        if (isReorderMode) {
            const slotIds = scrollList.getSlotIds();
            drives = slotIds.map(id => drives.find(d => d.id === id)).filter(Boolean);
        }
    });
}

// ============================================================================
// CONFIRM DIALOG
// ============================================================================

function showConfirm({ title, message, buttons }) {
    confirmTitle.textContent = title;
    confirmMessage.textContent = message;
    
    // Clear and add buttons
    confirmButtons.innerHTML = '';
    buttons.forEach(btn => {
        const button = document.createElement('button');
        button.className = `confirm-btn ${btn.class || 'secondary'}`;
        button.textContent = btn.label;
        button.addEventListener('click', () => {
            hideConfirm();
            if (btn.action) btn.action();
        });
        confirmButtons.appendChild(button);
    });
    
    confirmOverlay.classList.add('active');
}

function hideConfirm() {
    confirmOverlay.classList.remove('active');
}

// Close confirm on overlay click
confirmOverlay.addEventListener('click', (e) => {
    if (e.target === confirmOverlay) hideConfirm();
});

// Close confirm on Escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && confirmOverlay.classList.contains('active')) {
        hideConfirm();
    }
});

// Tab clicks (future: switch between Shares/Friends)
tabShares.addEventListener('click', () => {
    // Already active, but ready for tab switching logic
});

// ============================================================================
// DEBUG UTILITIES
// ============================================================================

// Debug state (loaded from main process on init)
let DEBUG = true;  // Default ON during development

/**
 * Conditional debug logging
 * Use: log('message', data) instead of console.log
 */
function log(...args) {
    if (DEBUG) console.log('[PearDrop]', ...args);
}

/**
 * Expose debug controls on window.peardrop for DevTools console access
 * 
 * Usage in DevTools:
 *   peardrop.debug()        — Check current state
 *   peardrop.setDebug(true) — Enable logging
 *   peardrop.setDebug(false) — Disable logging
 */
window.peardrop = {
    // Check debug state
    debug: () => {
        console.log(`Debug logging is ${DEBUG ? 'ENABLED' : 'DISABLED'}`);
        return DEBUG;
    },
    
    // Toggle debug (persists to config file)
    setDebug: async (enabled) => {
        const result = await window.electronAPI.setDebug(enabled);
        if (result.success) {
            DEBUG = result.enabled;
            console.log(`Debug logging ${DEBUG ? 'ENABLED' : 'DISABLED'}`);
            console.log('(Setting persisted to ~/peardrop/config.json)');
        }
        return DEBUG;
    },
    
    // Get version info
    version: '0.18.1',
    
    // Expose useful internals for debugging
    get drives() { return drives; },
    get driveItems() { return driveItems; },
    get scrollList() { return scrollList; }
};

/**
 * Load debug state from main process
 */
async function loadDebugState() {
    try {
        const result = await window.electronAPI.getDebug();
        DEBUG = result.enabled;
        if (DEBUG) {
            console.log('[PearDrop] Debug logging ENABLED');
            console.log('[PearDrop] Use peardrop.setDebug(false) to disable');
        }
    } catch (err) {
        // Default to enabled if can't load
        DEBUG = true;
    }
}

// ============================================================================
// INITIALIZE
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
    loadDebugState();
    init();
});

// Also init if DOM already loaded (for hot reload)
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    loadDebugState();
    init();
}

