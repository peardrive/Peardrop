/**
 * MODULE: main.js (PearDrop v2)
 * PURPOSE: Electron main process for PearDrop - P2P file sharing
 * VERSION: 0.19.1
 * 
 * EXPORTS: None (entry point)
 * 
 * FUNCTIONS:
 *   - createWindow() - Creates main BrowserWindow with platform-aware styling
 *   - initializeApp() - Ensures app directories exist, loads config
 *   - setupIPC() - Registers all IPC handlers for renderer
 * 
 * IPC HANDLERS (renderer can invoke):
 *   Hyperdrive:
 *     - 'hyperdrive-share' - Create share from files, returns link
 *     - 'hyperdrive-stop' - Stop sharing a drive
 *     - 'hyperdrive-open' - Connect to remote drive (includes dedup check)
 *     - 'hyperdrive-abort' - Abort pending connection(s)
 *     - 'hyperdrive-download' - Download files from opened drive
 *     - 'hyperdrive-status' - Get active/stopped drives stats
 *   HyperdriveManager (UI Interface):
 *     - 'drives-list' - Get all tracked drives
 *     - 'drives-pause' - Pause seeding (keep data)
 *     - 'drives-resume' - Resume seeding
 *     - 'drives-remove' - Delete drive completely
 *     - 'drives-check-files' - Verify local file availability
 *     - 'drive-get' - Get single drive by ID
 *   Utilities:
 *     - 'open-downloads' - Open downloads folder in Finder/Explorer
 *     - 'open-file' - Open file in default application
 *     - 'show-file-in-folder' - Reveal file in Finder/Explorer
 *     - 'get-files-stats' - Get file/folder stats with folder expansion
 *     - 'generate-qr' - Generate QR data URL for a string
 *     - 'get-app-version' - App version (reset-notice gating)
 *     - 'check-legacy-data-present' - Detect pre-unified state files
 *     - 'get-file-thumbnail' - Image src or OS-native icon for a file
 *     - 'get-debug' - Get current debug state
 *     - 'set-debug' - Set debug state (persists to config)
 * 
 * IPC EVENTS SENT (to renderer):
 *   - 'peer-connected' - Peer joined (upload) or download starting
 *   - 'peer-disconnected' - Peer left
 *   - 'upload-progress' - Transfer progress update
 *   - 'upload-complete' - Transfer finished
 *   - 'files-downloaded' - Download complete with file list
 *   - 'drives-updated' - Drive added/removed/changed
 *   - 'download-peer-disconnected' - Sender went offline during download
 * 
 * EXTERNAL CALLS:
 *   - lib/hyperdrive-manager.js (manager singleton) - Single source of truth for drives
 *   - lib/downloader.js (downloadFromDrive)
 *   - lib/file-utils.js (formatBytes, formatSpeed)
 *   - lib/logger.js (createLogger, loadConfig, setDebug)
 * 
 * KEY STATE:
 *   - mainWindow - BrowserWindow instance
 *   - APP_DATA_DIR - ~/peardrop
 *   - DOWNLOADS_DIR - ~/peardrop/downloads
 * 
 * PLATFORM SUPPORT:
 *   - macOS: Full glassmorphism, traffic lights, vibrancy
 *   - Windows: Standard title bar, solid background
 *   - Linux: Standard title bar, solid background
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { join } = path;
const fs = require('fs').promises;
const os = require('os');

// Hyperdrive manager for file sharing (🔒 SACRED core + UI interface)
const { manager: hyperdriveManager, DriveState } = require('./lib/hyperdrive-manager');
// QUARANTINED: ManifestRecovery tool removed from operation - will revisit later
// const ManifestRecovery = require('./lib/manifest-recovery');
// Download orchestration (✅ SAFE to modify)
const { downloadFromDrive } = require('./lib/downloader');
// Utilities
const { formatBytes, formatSpeed } = require('./lib/file-utils');
// Debug logging
const { createLogger, loadConfig: loadDebugConfig, setDebug, isDebugEnabled } = require('./lib/logger');
const log = createLogger('PearDrop');

// Migration tool (can be safely removed after migration completes)
let migrationTool = null;
try {
    migrationTool = require('./lib/migration');
} catch (error) {
    // Migration tool not found - this is fine, continue normally
    console.log('[PearDrop] Migration tool not available, continuing with normal startup');
}

// Platform detection
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';

let mainWindow;

// App configuration
const APP_DATA_DIR = join(os.homedir(), 'peardrop');
const DOWNLOADS_DIR = join(APP_DATA_DIR, 'downloads');

// ============================================================================
// Window Management
// ============================================================================

function createWindow() {
    // Platform-specific window options
    const windowOptions = {
        width: 415,
        height: 830,
        minWidth: 450,
        minHeight: 450,
        maxWidth: 480,
        maxHeight: 1000,
        resizable: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: join(__dirname, 'preload.js')
        },
        title: 'PearDrop',
        show: false
    };

    // macOS-specific: glassmorphism + hidden title bar
    if (isMac) {
        Object.assign(windowOptions, {
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: { x: 12, y: 12 },
            vibrancy: 'under-window',
            visualEffectState: 'active',
            transparent: true,
            backgroundColor: '#00000000'
        });
    } else {
        // Windows/Linux: standard title bar, solid background
        Object.assign(windowOptions, {
            backgroundColor: '#000000',
            // Frame is default true on Windows/Linux
            autoHideMenuBar: true  // Hide menu bar but allow Alt to show it
        });
    }

    mainWindow = new BrowserWindow(windowOptions);

    // Load main interface
    mainWindow.loadFile('index.html');

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        
        // Position on right side of screen
        const { screen } = require('electron');
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: screenWidth } = primaryDisplay.workAreaSize;
        const [winWidth] = mainWindow.getSize();
        mainWindow.setPosition(screenWidth - winWidth - 20, 80);
    });

    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
}

// ============================================================================
// App Initialization
// ============================================================================

async function initializeApp() {
    try {
        // Load debug config first
        const debugEnabled = loadDebugConfig();
        log('Debug logging:', debugEnabled ? 'ENABLED' : 'DISABLED');
        
        // Ensure app directories exist
        await fs.mkdir(APP_DATA_DIR, { recursive: true });
        await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
        log('App directories ready');
        return true;
    } catch (error) {
        console.error('[PearDrop] Failed to initialize:', error);
        throw error;
    }
}

// ============================================================================
// Recovery Functions
// ============================================================================

/**
 * CORESTORE-CANONICAL RECOVERY: Check corestores and sync drive-state map
 */
async function checkForOrphanedDrives() {
    // QUARANTINED: ManifestRecovery completely disabled - will revisit later
    // The recovery tool was causing more problems than it solved by incorrectly 
    // identifying valid downloads as "empty" and recommending deletion.
    // For now, we boot normally without any recovery checks.
    
    console.log('[PearDrop] ManifestRecovery DISABLED - booting normally');
    
    /* 
    try {
        const PEARDROP_DIR = path.join(os.homedir(), 'peardrop');
        const DRIVES_DIR = path.join(PEARDROP_DIR, 'drives');
        const DRIVES_STATE_FILE = path.join(PEARDROP_DIR, 'drives-state.json');
        
        const recovery = new ManifestRecovery(DRIVES_STATE_FILE, DRIVES_DIR);
        const syncResult = await recovery.scanAndSync();
        
        if (syncResult.inSync) {
            console.log('[PearDrop] Corestore and drive-state already in sync - booting normally');
            return;
        }
        
        console.log(`[PearDrop] Corestore sync results:`, {
            corestoresWithData: syncResult.corestoresWithData,
            corestoresEmpty: syncResult.corestoresEmpty,
            entriesRecovered: syncResult.entriesRecovered,
            entriesCreated: syncResult.entriesCreated,
            cleanupRecommended: syncResult.cleanupRecommended
        });
        
        // Handle recovery results
        if (syncResult.entriesRecovered > 0 || syncResult.entriesCreated > 0) {
            await showRecoveryCompletedDialog(syncResult);
        }
        
        // Handle cleanup recommendation
        if (syncResult.cleanupRecommended) {
            await promptForCleanup(syncResult, recovery);
        }
        
    } catch (error) {
        console.error('[PearDrop] Error during corestore sync:', error);
    }
    */
}

/**
 * Show user what was recovered from corestores
 */
async function showRecoveryCompletedDialog(syncResult) {
    const { dialog } = require('electron');
    
    let message = 'Drive recovery completed!';
    let details = [];
    
    if (syncResult.entriesCreated > 0) {
        details.push(`• Created ${syncResult.entriesCreated} new drive entries from corestores`);
    }
    if (syncResult.entriesRecovered > 0) {
        details.push(`• Recovered ${syncResult.entriesRecovered} corrupted drive entries`);
    }
    
    details.push('\nYour drive list now reflects what\'s actually stored in the corestores.');
    
    await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Drive Recovery Complete',
        message,
        detail: details.join('\n')
    });
    
    // Refresh frontend with recovered drives
    if (mainWindow && !mainWindow.isDestroyed()) {
        const drives = hyperdriveManager.getAllDriveEntries();
        mainWindow.webContents.send('drives-updated', {
            action: 'recovered',
            drives: drives
        });
    }
}

/**
 * STEPS 9-10: Prompt user to clean up empty/orphaned drives
 */
async function promptForCleanup(syncResult, recovery) {
    const { dialog } = require('electron');
    
    const emptyCount = syncResult.corestoresEmpty;
    const orphanedCount = syncResult.orphanedEntries;
    const totalToClean = emptyCount + orphanedCount;
    
    let message, detail;
    
    if (emptyCount > 0 && orphanedCount > 0) {
        message = `Found ${emptyCount} empty corestores and ${orphanedCount} orphaned drive entries.`;
        detail = 'Empty corestores have no files and serve no purpose.\nOrphaned entries point to non-existent corestores.\n\nRecommend cleaning up these useless entries.';
    } else if (emptyCount > 0) {
        message = `Found ${emptyCount} empty corestores with no files.`;
        detail = 'These corestores contain no data and serve no purpose.\n\nRecommend removing them to clean up your drive list.';
    } else {
        message = `Found ${orphanedCount} orphaned drive entries.`;
        detail = 'These drive entries point to non-existent corestores.\n\nRecommend removing them from your drive list.';
    }
    
    const response = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Clean Up', 'Keep Them'],
        defaultId: 0,
        title: 'Empty/Orphaned Drives Found',
        message,
        detail: detail + '\n\nClean up now?'
    });
    
    if (response.response === 0) { // Clean Up
        await performCleanup(syncResult, recovery);
    } else {
        console.log('[PearDrop] User chose to keep empty/orphaned drives');
    }
}

/**
 * STEP 10: Actually perform the cleanup
 */
async function performCleanup(syncResult, recovery) {
    console.log('[PearDrop] STEP 10: Performing cleanup...');
    
    let cleaned = 0;
    let errors = 0;
    
    // Get current manifest
    let currentManifest;
    try {
        const data = await fs.readFile(recovery.manifestPath, 'utf8');
        currentManifest = JSON.parse(data);
    } catch {
        currentManifest = recovery.defaultManifest;
    }
    
    // Clean up orphaned drive entries (no corestore)
    for (const driveId of (syncResult.orphanedEntryIds || [])) {
        try {
            delete currentManifest.drives[driveId];
            cleaned++;
            console.log(`[PearDrop] 🗑️ Removed orphaned drive entry: ${driveId}`);
        } catch (error) {
            console.error(`[PearDrop] Failed to remove orphaned entry ${driveId}:`, error.message);
            errors++;
        }
    }
    
    // Clean up empty corestores and their drive entries
    for (const driveId of (syncResult.emptyCorestoreIds || [])) {
        try {
            // Remove drive entry if exists
            if (currentManifest.drives[driveId]) {
                delete currentManifest.drives[driveId];
                console.log(`[PearDrop] 🗑️ Removed empty drive entry: ${driveId}`);
            }
            
            // Remove empty corestore folder
            await recovery.removeCorruptedDrive(driveId);
            console.log(`[PearDrop] 🗑️ Removed empty corestore folder: ${driveId}`);
            
            cleaned++;
        } catch (error) {
            console.error(`[PearDrop] Failed to cleanup empty drive ${driveId}:`, error.message);
            errors++;
        }
    }
    
    // Save updated manifest
    await recovery.saveManifest(currentManifest);
    
    // Show completion
    const { dialog } = require('electron');
    await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Cleanup Complete',
        message: `Cleanup finished: ${cleaned} items removed, ${errors} errors`,
        detail: 'Your drive list now only contains drives with actual data.'
    });
    
    // Refresh frontend - IMPORTANT: reload hyperdrive manager to reflect manifest changes
    if (cleaned > 0 && mainWindow && !mainWindow.isDestroyed()) {
        // Force hyperdrive manager to reload from the updated manifest
        await hyperdriveManager._loadManifest();
        
        const drives = hyperdriveManager.getAllDriveEntries();
        mainWindow.webContents.send('drives-updated', {
            action: 'cleaned',
            drives: drives
        });
        
        console.log(`[PearDrop] Frontend updated with ${drives.length} remaining drives`);
    }
}


// ============================================================================
// IPC Handlers
// ============================================================================

function setupIPC() {
    // ========================================================================
    // Hyperdrive File Sharing
    // ========================================================================

    // Create a shareable link for files
    ipcMain.handle('hyperdrive-share', async (event, { files, options = {} }) => {
        try {
            const result = await hyperdriveManager.createDrive(files, {
                ttlMs: options.ttlMs || 0,
                name: options.name
            });
            
            console.log('[PearDrop] Share created:', result.shareLink);
            
            // Calculate total bytes from files
            const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
            const shareName = options.name || (files.length === 1 ? files[0].name : `${files.length} files`);
            
            // Add to drives state (single source of truth for UI)
            const driveEntry = await hyperdriveManager.addDriveEntry({
                id: result.driveId,
                key: result.key,
                shareLink: result.shareLink,
                name: shareName,
                files: files.map(f => ({
                    name: f.name,
                    path: f.path,
                    size: f.size
                })),
                totalBytes: totalBytes,
                localPath: files[0]?.path ? path.dirname(files[0].path) : null,
                storagePath: path.join(hyperdriveManager.drivesDir, result.driveId),
                state: DriveState.ACTIVE,
                isUpload: true
            });
            
            // Notify renderer about new drive entry
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('drives-updated', {
                    action: 'added',
                    entry: driveEntry
                });
            }
            
            return {
                success: true,
                driveId: result.driveId,
                shareLink: result.shareLink,
                driveEntryId: driveEntry.id
            };
        } catch (error) {
            console.error('[PearDrop] Share failed:', error);
            return { success: false, error: error.message };
        }
    });

    // Stop sharing a drive
    ipcMain.handle('hyperdrive-stop', async (event, { driveId, delete: deleteParam = false }) => {
        try {
            await hyperdriveManager.stopDrive(driveId, { delete: deleteParam });
            console.log('[PearDrop] Share stopped:', driveId);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Quick local-only duplicate check (fast, no network)
    ipcMain.handle('hyperdrive-check-duplicate', async (event, { shareLink }) => {
        const driveKey = shareLink.replace('peardrop://', '').toLowerCase();
        const existingDrive = hyperdriveManager.getDriveEntryByKey(driveKey);
        
        if (existingDrive) {
            const localAvailable = await hyperdriveManager.checkLocalAvailability(existingDrive.id);
            return {
                isDuplicate: true,
                localStatus: localAvailable ? 'available' : 'missing',
                existingDrive: existingDrive,
                driveId: existingDrive.id
            };
        }
        
        return { isDuplicate: false };
    });

    // Open a shared drive for download
    // Includes dedup check - returns existing entry if already downloaded
    // Pass forceOpen: true to skip dedup check (for re-downloads)
    ipcMain.handle('hyperdrive-open', async (event, { shareLink, forceOpen = false }) => {
        try {
            console.log('[PearDrop] Opening:', shareLink, forceOpen ? '(force)' : '');
            
            // Check for duplicate BEFORE opening the drive (unless forcing)
            // Extract key from peardrop:// link
            const driveKey = shareLink.replace('peardrop://', '').toLowerCase();
            if (driveKey && !forceOpen) {
                const existingDrive = hyperdriveManager.getDriveEntryByKey(driveKey);
                
                if (existingDrive) {
                    // Check if local files still exist
                    const localAvailable = await hyperdriveManager.checkLocalAvailability(existingDrive.id);
                    
                    console.log('[PearDrop] Duplicate detected:', {
                        driveKey: driveKey.slice(0, 12) + '...',
                        localAvailable
                    });
                    
                    // Return duplicate info - let renderer decide what to do
                    return {
                        success: true,
                        isDuplicate: true,
                        localStatus: localAvailable ? 'available' : 'missing',
                        existingDrive: existingDrive,
                        driveId: existingDrive.id,
                        shareName: existingDrive.name,
                        totalBytes: existingDrive.totalBytes,
                        localPath: existingDrive.localPath
                    };
                }
            }
            
            // Not a duplicate, proceed with normal open
            const result = await hyperdriveManager.openDrive(shareLink);
            
            return {
                success: true,
                isDuplicate: false,
                driveId: result.driveId,
                files: result.files,
                shareName: result.shareName,
                totalBytes: result.totalBytes,
                hasManifest: result.hasManifest,
                peerConnected: result.peerConnected
            };
        } catch (error) {
            console.error('[PearDrop] Open failed:', error);
            return { success: false, error: error.message };
        }
    });

    // Abort a pending connection
    ipcMain.handle('hyperdrive-abort', async (event, { driveId }) => {
        try {
            if (driveId) {
                const aborted = hyperdriveManager.abortConnection(driveId);
                console.log('[PearDrop] Abort connection:', { driveId, aborted });
                return { success: true, aborted };
            } else {
                hyperdriveManager.abortAllConnections();
                console.log('[PearDrop] Aborted all pending connections');
                return { success: true, aborted: true };
            }
        } catch (error) {
            console.error('[PearDrop] Abort failed:', error);
            return { success: false, error: error.message };
        }
    });

    // Download files from an opened drive
    // Uses lib/downloader.js (✅ SAFE module - can be modified without touching sacred code)
    ipcMain.handle('hyperdrive-download', async (event, { driveId, destDir }) => {
        try {
            const session = hyperdriveManager.activeDrives.get(driveId);
            if (!session) {
                throw new Error('Session not found');
            }
            
            const downloadPath = destDir || DOWNLOADS_DIR;
            
            console.log('[PearDrop] Download starting via downloader module');
            
            // Use the downloader module with callbacks for UI updates
            const result = await downloadFromDrive(session.drive, {
                destDir: downloadPath,
                totalBytes: session.totalBytes || 0,
                shareName: session.shareName,
                
                onPeerConnected: (data) => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('peer-connected', {
                            driveId,
                            peerId: 'self',
                            shareName: data.shareName,
                            totalBytes: data.totalBytes
                        });
                    }
                },
                
                onProgress: (data) => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('upload-progress', {
                            peerId: 'self',
                            driveId,
                            ...data
                        });
                    }
                },
                
                onComplete: (data) => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('upload-complete', {
                            peerId: 'self',
                            driveId,
                            totalBytes: data.totalBytes,
                            duration: data.duration
                        });
                    }
                },
                
                onError: (data) => {
                    console.error('[PearDrop] File error:', data);
                }
            });
            
            // Add to drives state (single source of truth)
            const driveEntry = await hyperdriveManager.addDriveEntry({
                id: driveId,
                key: session.metadata?.key,
                shareLink: session.shareLink || `peardrop://${session.metadata?.key || 'unknown'}`,
                name: session.shareName,
                files: result.files,
                totalBytes: result.totalBytes,
                localPath: downloadPath,
                storagePath: path.join(hyperdriveManager.drivesDir, driveId),
                state: DriveState.ACTIVE,
                isUpload: false  // This is a download
            });
            
            // Mark session as seeding mode
            if (session) {
                session.isSeeding = true;
                session.driveEntryId = driveEntry.id;
            }
            
            console.log('[PearDrop] Download complete, now seeding:', driveEntry.name);
            
            // Notify renderer
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('files-downloaded', {
                    files: result.files,
                    downloadPath,
                    driveId: driveEntry.id,
                    isSeeding: true
                });
                
                // Notify about new drive entry
                mainWindow.webContents.send('drives-updated', {
                    action: 'added',
                    entry: driveEntry
                });
            }
            
            return { success: true, files: result.files, downloadPath, driveId: driveEntry.id };
        } catch (error) {
            console.error('[PearDrop] Download failed:', error);
            return { success: false, error: error.message };
        }
    });

    // Get status of all drives
    ipcMain.handle('hyperdrive-status', async () => {
        try {
            return { success: true, ...hyperdriveManager.getStatus() };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Open downloads folder
    ipcMain.handle('open-downloads', async () => {
        try {
            await shell.openPath(DOWNLOADS_DIR);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Open file in default application
    ipcMain.handle('open-file', async (event, { filePath }) => {
        try {
            if (!filePath) {
                return { success: false, error: 'No file path provided' };
            }
            const result = await shell.openPath(filePath);
            // shell.openPath returns empty string on success, error message on failure
            if (result) {
                return { success: false, error: result };
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Show file in Finder/Explorer
    ipcMain.handle('show-file-in-folder', async (event, { filePath }) => {
        try {
            if (!filePath) {
                return { success: false, error: 'No file path provided' };
            }
            shell.showItemInFolder(filePath);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Get drive info by ID
    ipcMain.handle('drive-get', async (event, { id }) => {
        try {
            const drive = hyperdriveManager.getDriveEntry(id);
            if (!drive) {
                return { success: false, error: 'Drive not found' };
            }
            return { success: true, drive };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // ========================================================================
    // DriveManager - Single source of truth for all drives
    // ========================================================================

    // Get all drives
    ipcMain.handle('drives-list', async () => {
        try {
            const drives = hyperdriveManager.getAllDriveEntries();
            return { success: true, drives };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Pause seeding (keep drive, stop network)
    ipcMain.handle('drives-pause', async (event, { id }) => {
        try {
            console.log('[PearDrop] Pausing drive', { id });
            
            // Stop the hyperdrive but keep storage
            const session = hyperdriveManager.activeDrives.get(id);
            if (session) {
                await hyperdriveManager.stopDrive(id, { delete: false });
            }
            
            // Update drive state
            const entry = await hyperdriveManager.pauseDriveEntry(id);
            
            return { success: true, entry };
        } catch (error) {
            console.error('[PearDrop] Failed to pause drive:', error);
            return { success: false, error: error.message };
        }
    });

    // Resume seeding
    ipcMain.handle('drives-resume', async (event, { id }) => {
        try {
            console.log('[PearDrop] Resuming drive', { id });
            
            // TODO: Implement re-joining swarm for paused drives
            // For now, just update state
            const entry = await hyperdriveManager.resumeDriveEntry(id);
            
            return { success: true, entry };
        } catch (error) {
            console.error('[PearDrop] Failed to resume drive:', error);
            return { success: false, error: error.message };
        }
    });

    // Remove drive completely
    ipcMain.handle('drives-remove', async (event, { id, deleteFiles = false }) => {
        try {
            console.log('[PearDrop] Removing drive', { id, deleteFiles });
            
            // Stop if active
            const session = hyperdriveManager.activeDrives.get(id);
            if (session) {
                console.log('[PearDrop] Stopping active drive', { id });
                await hyperdriveManager.stopDrive(id, { delete: true });
            }
            
            // Remove via drive state (handles storage + optional file deletion)
            const success = await hyperdriveManager.removeDriveEntry(id, { 
                deleteFiles, 
                deleteStorage: true 
            });
            
            console.log('[DEBUG] removeDriveEntry result:', {
                id,
                success,
                mainWindowExists: !!mainWindow,
                mainWindowDestroyed: mainWindow?.isDestroyed()
            });
            
            // Notify renderer (send event even if entry was already removed from manifest)
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('drives-updated', {
                    action: 'removed',
                    id
                });
            }
            
            console.log('[PearDrop] Drive removed completely', { id });
            return { success };
        } catch (error) {
            console.error('[PearDrop] Failed to remove drive:', error);
            return { success: false, error: error.message };
        }
    });

    // Check local file availability for all drives
    ipcMain.handle('drives-check-files', async () => {
        try {
            const drives = hyperdriveManager.getAllDriveEntries();
            const results = [];
            
            for (const drive of drives) {
                const available = await hyperdriveManager.checkLocalAvailability(drive.id);
                if (available !== drive.isLocalAvailable) {
                    await hyperdriveManager.updateDriveEntry(drive.id, { isLocalAvailable: available });
                }
                results.push({ ...drive, isLocalAvailable: available });
            }
            
            return { success: true, drives: results };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // ========================================================================
    // Debug Logging Control
    // ========================================================================

    // Get current debug state
    ipcMain.handle('get-debug', async () => {
        return { enabled: isDebugEnabled() };
    });

    // Set debug state (persists to ~/peardrop/config.json)
    ipcMain.handle('set-debug', async (event, { enabled }) => {
        setDebug(enabled);
        return { success: true, enabled: isDebugEnabled() };
    });

    // ========================================================================
    // QR Code generation
    // ========================================================================
    ipcMain.handle('generate-qr', async (event, { text }) => {
        const QRCode = require('qrcode');
        return await QRCode.toDataURL(text, { width: 160, margin: 1, color: { dark: '#000000', light: '#ffffff' } });
    });

    // ========================================================================
    // App version — used by the one-time reset notice in the renderer to
    // detect upgrade-across-fix-boundary scenarios.
    // ========================================================================
    ipcMain.handle('get-app-version', async () => {
        return app.getVersion();
    });

    // ========================================================================
    // File thumbnail — lazy thumbnail provider for the expanded drive items.
    //   * Images → return the file:// URL directly so the renderer can <img>
    //     it. No file read, no encoding, instant.
    //   * Anything else → app.getFileIcon returns the OS-native icon
    //     (Mac/Win/Linux). Encoded as data: URL.
    //   * Failures → return { kind: 'none' } so the renderer keeps the
    //     emoji fallback.
    // ========================================================================
    ipcMain.handle('get-file-thumbnail', async (event, payload) => {
        const filePath = payload && payload.path;
        try {
            if (!filePath) return { kind: 'none', src: null };

            const ext = path.extname(filePath).toLowerCase();
            const imageExts = new Set([
                '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.apng'
            ]);

            if (imageExts.has(ext)) {
                // Electron renderers can load file:// URLs directly into <img>
                const url = 'file:///' + filePath.replace(/\\/g, '/');
                return { kind: 'image', src: url };
            }

            const icon = await app.getFileIcon(filePath, { size: 'normal' });
            return { kind: 'icon', src: icon.toDataURL() };
        } catch (error) {
            return { kind: 'none', src: null, error: error.message };
        }
    });

    // ========================================================================
    // Legacy data detection — fallback for the one-time "share history was
    // reset" notice when localStorage has no lastSeenVersion yet (i.e. the
    // first launch after this build ships). Returns true if any pre-unified
    // state file is on disk (drives.json or drives-manifest.json), meaning
    // the user ran an older build that lost data to the purge-on-close bug.
    // Safe to remove together with the notice once retired.
    // ========================================================================
    ipcMain.handle('check-legacy-data-present', async () => {
        const os = require('os');
        const path = require('path');
        const fs = require('fs').promises;
        const candidates = [
            path.join(os.homedir(), 'peardrop', 'drives.json'),
            path.join(os.homedir(), 'peardrop', 'drives-manifest.json')
        ];
        for (const file of candidates) {
            try {
                await fs.access(file);
                return { present: true };
            } catch { /* missing — try next */ }
        }
        return { present: false };
    });

    // ========================================================================
    // File Stats (with folder expansion)
    // ========================================================================

    // Get stats for files/folders, expanding folder contents
    ipcMain.handle('get-files-stats', async (event, filePaths) => {
        const path = require('path');
        
        /**
         * Recursively get total size of a directory
         */
        async function getFolderSize(folderPath) {
            let totalSize = 0;
            const entries = await fs.readdir(folderPath, { withFileTypes: true });
            
            for (const entry of entries) {
                const entryPath = path.join(folderPath, entry.name);
                try {
                    if (entry.isDirectory()) {
                        totalSize += await getFolderSize(entryPath);
                    } else if (entry.isFile()) {
                        const stats = await fs.stat(entryPath);
                        totalSize += stats.size;
                    }
                } catch (err) {
                    console.log('[PearDrop] Skipping inaccessible entry:', entryPath);
                }
            }
            
            return totalSize;
        }
        
        /**
         * Recursively enumerate all files in a directory
         */
        async function enumerateFolderContents(folderPath, basePath = null) {
            const results = [];
            basePath = basePath || folderPath;
            const entries = await fs.readdir(folderPath, { withFileTypes: true });
            
            for (const entry of entries) {
                const entryPath = path.join(folderPath, entry.name);
                try {
                    if (entry.isDirectory()) {
                        const subResults = await enumerateFolderContents(entryPath, basePath);
                        results.push(...subResults);
                    } else if (entry.isFile()) {
                        const stats = await fs.stat(entryPath);
                        results.push({
                            path: entryPath,
                            name: entry.name,
                            relativePath: path.relative(basePath, entryPath),
                            size: stats.size
                        });
                    }
                } catch (err) {
                    console.log('[PearDrop] Skipping inaccessible entry:', entryPath);
                }
            }
            
            return results;
        }
        
        const results = [];
        
        for (const filePath of filePaths) {
            try {
                const stats = await fs.stat(filePath);
                
                if (stats.isDirectory()) {
                    // For folders: calculate total size and enumerate contents
                    const totalSize = await getFolderSize(filePath);
                    const contents = await enumerateFolderContents(filePath);
                    
                    results.push({
                        path: filePath,
                        name: path.basename(filePath),
                        size: totalSize,
                        type: 'folder',
                        fileCount: contents.length,
                        contents: contents
                    });
                    
                    console.log('[PearDrop] Folder stat:', path.basename(filePath), 
                        `${contents.length} files, ${formatBytes(totalSize)}`);
                } else {
                    // Regular file
                    results.push({
                        path: filePath,
                        name: path.basename(filePath),
                        size: stats.size,
                        type: 'file'
                    });
                }
            } catch (error) {
                console.error('[PearDrop] Failed to stat:', filePath, error.message);
            }
        }
        
        return results;
    });
}

// ============================================================================
// Migration Check (can be safely removed after migration completes)
// ============================================================================

/**
 * Check if drive data migration is needed and run with user consent
 */
async function checkAndRunMigration() {
    if (!migrationTool) {
        // Migration tool not available - continue normally
        return;
    }

    try {
        const migrationCheck = await migrationTool.checkMigrationNeeded();
        
        if (!migrationCheck.needed) {
            console.log('[PearDrop] No migration needed:', migrationCheck.reason);
            return;
        }

        console.log('[PearDrop] Migration needed:', migrationCheck.summary);

        // Show user consent dialog
        const { dialog } = require('electron');
        const response = await dialog.showMessageBox(mainWindow, {
            type: 'question',
            buttons: ['Migrate Drives', 'Skip (Boot Normally)'],
            defaultId: 0,
            cancelId: 1,
            title: 'Drive Data Migration',
            message: 'Saved drives need to be updated to the new format',
            detail: `Found ${migrationCheck.summary.totalToMigrate} drives that need migration.\n\n` +
                   `• ${migrationCheck.summary.driveManagerDrives} drives from old UI data\n` +
                   `• ${migrationCheck.summary.hyperdriveManagerDrives} drives from P2P data\n` +
                   `• ${migrationCheck.summary.orphanedDrives} orphaned drives will be cleaned\n\n` +
                   `Your original files will be backed up safely.\n\n` +
                   `Click "Migrate Drives" to update, or "Skip" to continue without migration.`,
            checkboxLabel: 'Remember this choice (migration can be run later)',
            checkboxChecked: false
        });

        if (response.response === 0) {
            // User chose to migrate
            console.log('[PearDrop] Starting migration with user consent...');
            
            const migrationResult = await migrationTool.runMigration();
            
            if (migrationResult.success) {
                console.log('[PearDrop] Migration completed successfully:', {
                    migrated: migrationResult.migrated,
                    cleaned: migrationResult.cleaned,
                    backedUp: migrationResult.backed_up
                });
                
                // Show success notification
                await dialog.showMessageBox(mainWindow, {
                    type: 'info',
                    buttons: ['Continue'],
                    title: 'Migration Complete',
                    message: `Successfully migrated ${migrationResult.migrated} drives`,
                    detail: `Cleaned ${migrationResult.cleaned} orphaned drives.\n` +
                           `Original files backed up:\n${migrationResult.backed_up.join('\n')}`
                });
            } else {
                console.error('[PearDrop] Migration failed:', migrationResult.error);
                
                // Show error but continue
                await dialog.showMessageBox(mainWindow, {
                    type: 'warning',
                    buttons: ['Continue Anyway'],
                    title: 'Migration Failed',
                    message: 'Drive migration failed, but app will continue normally',
                    detail: `Error: ${migrationResult.error}\n\nYou can try migration again later.`
                });
            }
        } else {
            console.log('[PearDrop] User skipped migration, continuing normally');
        }
        
    } catch (error) {
        console.error('[PearDrop] Migration check failed:', error);
        // Continue normally - don't let migration errors block startup
    }
}

// ============================================================================
// App Lifecycle
// ============================================================================

app.whenReady().then(async () => {
    try {
        await initializeApp();
        setupIPC();
        createWindow();
        
        // -------------------------------------------------------------------
        // Migration prompt — PAUSED (2026-05-13)
        // -------------------------------------------------------------------
        // The legacy → unified state migration is intentionally disabled.
        //
        // Why it's paused:
        //   • The previous purge-on-close bug (see fix in stopAll handlers)
        //     left most users with empty/orphaned legacy state files, which
        //     made checkMigrationNeeded() return `true` on every launch
        //     and re-prompted the dialog every time.
        //   • Until we revisit the migration UX (auto-skip when nothing
        //     real to migrate, persist the "remember this choice" flag,
        //     and consume the legacy files after a successful run), it
        //     is friendlier to skip the prompt entirely and inform users
        //     about the reset via a one-time in-app notice instead.
        //
        // What still lives in the codebase, untouched, for future use:
        //   • lib/migration.js                — the migration logic itself
        //   • checkAndRunMigration() below    — the user-consent flow
        //   • The optional require near the top of main.js
        //
        // How to re-enable when the UX is ready:
        //   • Uncomment the `await checkAndRunMigration();` line below.
        //   • Make sure response.checkboxChecked is read & persisted, and
        //     that legacy files are moved (not just copied) after success.
        //
        // await checkAndRunMigration();
        
        // CRITICAL: Check and fix drive manifest BEFORE initializing drives
        // This ensures we don't start network activity with corrupted data
        await checkForOrphanedDrives();
        
        // Initialize Hyperdrive manager with clean, accurate manifest
        await hyperdriveManager.init();
        
        // Notify frontend that drives have been loaded (especially after migration)
        if (mainWindow && !mainWindow.isDestroyed()) {
            const drives = hyperdriveManager.getAllDriveEntries();
            mainWindow.webContents.send('drives-updated', {
                action: 'loaded',
                drives: drives
            });
            console.log('[PearDrop] Notified frontend of loaded drives:', drives.length);
        }
        
        // Forward progress events to renderer
        hyperdriveManager.on('peer-connected', (data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('peer-connected', data);
            }
        });
        
        hyperdriveManager.on('peer-disconnected', (data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('peer-disconnected', data);
            }
        });
        
        hyperdriveManager.on('upload-progress', (data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('upload-progress', {
                    ...data,
                    bytesFormatted: formatBytes(data.bytesTransferred),
                    totalFormatted: formatBytes(data.totalBytes),
                    speedFormatted: formatSpeed(data.speed)
                });
            }
        });
        
        hyperdriveManager.on('upload-complete', (data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('upload-complete', data);
            }
        });
        
        // Download peer disconnected - sender went offline
        hyperdriveManager.on('download-peer-disconnected', (data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-peer-disconnected', data);
            }
        });
        
        console.log('[PearDrop] Ready');
        
    } catch (error) {
        console.error('[PearDrop] Startup failed:', error);
        const { dialog } = require('electron');
        dialog.showErrorBox('Startup Error', error.message);
        app.quit();
    }
});

app.on('window-all-closed', async () => {
    // Just disconnect from network, preserve all drives and storage
    try {
        await hyperdriveManager.stopAll({ delete: false });
        console.log('[PearDrop] Disconnected from network');
    } catch (error) {
        console.error('[PearDrop] Cleanup error:', error);
    }
    
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.on('before-quit', async () => {
    try {
        await hyperdriveManager.stopAll({ delete: false });
    } catch (error) {
        console.error('[PearDrop] Cleanup error:', error);
    }
});
