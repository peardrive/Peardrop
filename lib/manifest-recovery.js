/**
 * MODULE: manifest-recovery.js
 * PURPOSE: Robust drives-state.json recovery and validation system
 * VERSION: 0.19.0
 * 
 * EXPORTS:
 *   - ManifestRecovery(manifestPath, drivesDir) - Recovery manager
 *     - loadWithRecovery() - Load manifest with automatic recovery
 *     - validateAndSync() - Validate manifest against drive folders
 *     - rebuildFromDrives() - Rebuild from drive folder scanning
 *     - recoverPartial() - Attempt partial recovery from corrupted data
 *     - scanDriveFolder(driveId) - Extract metadata from single drive
 *     - cleanupOrphans() - Remove orphaned drives/manifest entries
 * 
 * EXTERNAL CALLS:
 *   - Node.js fs/promises
 *   - Corestore, Hyperdrive (for drive scanning)
 *   - path module
 * 
 * PHILOSOPHY:
 *   - Isolated recovery logic (don't contaminate hyperdrive-manager)
 *   - Fail gracefully - prefer partial recovery over total loss
 *   - Always sync drives folder ↔ manifest consistency
 *   - Backup corrupted data before overwriting
 */

const fs = require('fs').promises
const path = require('path')

class ManifestRecovery {
  constructor(manifestPath, drivesDir) {
    this.manifestPath = manifestPath
    this.drivesDir = drivesDir
    this.defaultManifest = {
      drives: {},
      stats: {
        totalCreated: 0,
        totalPurged: 0,
        totalBytesShared: 0
      }
    }
  }

  /**
   * Main entry point - load manifest safely (NO automatic recovery)
   */
  async loadWithRecovery() {
    try {
      // Try normal load first
      const data = await fs.readFile(this.manifestPath, 'utf8')
      const manifest = JSON.parse(data)
      
      // Validate structure
      if (!manifest.drives || !manifest.stats) {
        throw new Error('Invalid manifest structure')
      }
      
      // Only validate, don't auto-rebuild
      return await this.validateOnly(manifest)
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('[ManifestRecovery] No manifest found - will scan for orphaned drives after init')
        return this.defaultManifest
      } else {
        console.warn('[ManifestRecovery] Manifest corrupted - will offer recovery options after init')
        // Backup corrupted file
        try {
          const backupPath = this.manifestPath + '.corrupted.' + Date.now()
          await fs.copyFile(this.manifestPath, backupPath)
          console.log('[ManifestRecovery] Backed up corrupted manifest to:', backupPath)
        } catch {}
        return this.defaultManifest
      }
    }
  }

  /**
   * Validate manifest against actual drive folders (cleanup only, no recovery)
   */
  async validateOnly(manifest) {
    let manifestChanged = false
    const manifestDrives = Object.keys(manifest.drives)
    const driveFolders = []
    
    try {
      const entries = await fs.readdir(this.drivesDir, { withFileTypes: true })
      driveFolders.push(...entries.filter(e => e.isDirectory()).map(e => e.name))
    } catch {
      // If drives dir doesn't exist, we'll have empty driveFolders
    }

    console.log('[ManifestRecovery] Validating manifest against drives folder', {
      manifestDrives: manifestDrives.length,
      driveFolders: driveFolders.length
    })

    // Remove manifest entries for missing drive folders (cleanup only)
    for (const driveId of manifestDrives) {
      if (!driveFolders.includes(driveId)) {
        console.log('[ManifestRecovery] Removing manifest entry for missing drive folder', { driveId })
        delete manifest.drives[driveId]
        manifestChanged = true
      }
    }

    // Save updated manifest if changed
    if (manifestChanged) {
      await this.saveManifest(manifest)
      console.log('[ManifestRecovery] Manifest cleaned after validation')
    }

    return manifest
  }

  /**
   * CORESTORE-CANONICAL RECOVERY: Corestore is truth, drive-state is map
   * Steps 1-11 exactly as specified by user
   */
  async scanAndSync() {
    console.log('[ManifestRecovery] Starting corestore-canonical recovery...')
    
    // STEP 1: Scan all corestores (the canonical truth)
    const corestoreData = await this._scanAllCorestores()
    
    // STEP 2: Load current drive manifest (the map)
    let currentManifest
    try {
      const data = await fs.readFile(this.manifestPath, 'utf8')
      currentManifest = JSON.parse(data)
    } catch {
      currentManifest = this.defaultManifest
    }
    
    // STEP 3: Check if they match - if yes, boot normally
    const syncAnalysis = this._analyzeSync(corestoreData, currentManifest)
    if (syncAnalysis.inSync && corestoreData.empty.length === 0) {
      console.log('[ManifestRecovery] Corestore and manifest already in sync')
      return { needsUserAttention: false, inSync: true, manifest: currentManifest }
    }
    
    console.log('[ManifestRecovery] Sync required:', syncAnalysis.summary)
    
    // STEP 4-7: Process each corestore that needs fixing
    const recoveryResults = await this._processCorestoreRecovery(corestoreData, currentManifest)
    
    // STEP 8-10: Handle drives with no corestore (orphaned map entries)
    const cleanupResults = await this._handleOrphanedDrives(corestoreData, currentManifest)
    
    // STEP 11: Save and return results (no loop - one pass only)
    await this.saveManifest(currentManifest)
    
    return {
      needsUserAttention: recoveryResults.changed || cleanupResults.needsCleanup,
      corestoresWithData: corestoreData.withData.length,
      corestoresEmpty: corestoreData.empty.length,
      corestoresErrored: corestoreData.errored.length,
      entriesRecovered: recoveryResults.recovered,
      entriesCreated: recoveryResults.created,
      orphanedEntries: cleanupResults.orphaned,
      cleanupRecommended: cleanupResults.needsCleanup,
      manifest: currentManifest,
      // Pass actual arrays for cleanup
      emptyCorestoreIds: corestoreData.empty,
      orphanedEntryIds: cleanupResults.orphaned
    }
  }

  /**
   * STEP 1: Scan ALL corestores to establish ground truth
   * NEVER modify corestore - only READ what exists
   */
  async _scanAllCorestores() {
    console.log('[ManifestRecovery] STEP 1: Scanning corestores (canonical truth)...')
    
    const result = {
      withData: [],    // Corestores with actual files
      empty: [],       // Corestores with no files (mark for cleanup)
      errored: []      // Corestores that couldn't be read
    }
    
    try {
      const entries = await fs.readdir(this.drivesDir, { withFileTypes: true })
      const driveFolders = entries.filter(e => e.isDirectory()).map(e => e.name)
      
      for (const driveId of driveFolders) {
        try {
          // Check for CORESTORE file
          const corestoreFile = path.join(this.drivesDir, driveId, 'CORESTORE')
          await fs.access(corestoreFile)
          
          // READ (never modify) the corestore data
          const driveData = await this.scanDriveFolder(driveId)
          
          if (driveData && (driveData.files.length > 0 || driveData.totalBytes > 0)) {
            result.withData.push({ driveId, data: driveData })
            console.log(`[ManifestRecovery] Corestore ${driveId}: HAS DATA - ${driveData.name} (${driveData.files.length} files)`)
          } else {
            result.empty.push(driveId)
            console.log(`[ManifestRecovery] Corestore ${driveId}: EMPTY - no files found`)
          }
        } catch (error) {
          result.errored.push({ driveId, error: error.message })
          console.log(`[ManifestRecovery] Corestore ${driveId}: ERROR - ${error.message}`)
        }
      }
      
      console.log(`[ManifestRecovery] Corestore scan complete: ${result.withData.length} with data, ${result.empty.length} empty, ${result.errored.length} errored`)
      return result
      
    } catch (error) {
      console.error('[ManifestRecovery] Failed to scan corestores:', error)
      return result
    }
  }

  /**
   * STEP 3: Analyze if corestore truth matches drive-state map
   */
  _analyzeSync(corestoreData, manifest) {
    const manifestDrives = Object.keys(manifest.drives || {})
    const corestoreIds = [...corestoreData.withData.map(c => c.driveId), ...corestoreData.empty]
    
    let mismatches = 0
    let needsRecovery = []
    let orphanedEntries = []
    
    // Check corestores against manifest
    for (const { driveId, data } of corestoreData.withData) {
      const manifestEntry = manifest.drives[driveId]
      if (!manifestEntry) {
        needsRecovery.push(driveId)
        mismatches++
      } else if (this.isDriveDataCorrupted(manifestEntry) || manifestEntry.name !== data.name) {
        needsRecovery.push(driveId)
        mismatches++
      }
    }
    
    // Check manifest against corestores
    for (const driveId of manifestDrives) {
      if (!corestoreIds.includes(driveId)) {
        orphanedEntries.push(driveId)
        mismatches++
      }
    }
    
    return {
      inSync: mismatches === 0,
      needsRecovery,
      orphanedEntries,
      emptyCorestores: corestoreData.empty,
      summary: `${needsRecovery.length} need recovery, ${orphanedEntries.length} orphaned entries, ${corestoreData.empty.length} empty corestores`
    }
  }

  /**
   * STEPS 4-7: Process each corestore that needs drive entry recovery
   */
  async _processCorestoreRecovery(corestoreData, manifest) {
    console.log('[ManifestRecovery] STEPS 4-7: Processing corestores with data...')
    
    let recovered = 0
    let created = 0
    let changed = false
    
    for (const { driveId, data } of corestoreData.withData) {
      const existingEntry = manifest.drives[driveId]
      
      if (!existingEntry) {
        // STEP 6: Create new drive entry (no existing entry)
        manifest.drives[driveId] = data
        manifest.stats.totalCreated++
        manifest.stats.totalBytesShared += data.totalBytes || 0
        created++
        changed = true
        console.log(`[ManifestRecovery] ✅ STEP 6: Created drive entry for ${driveId}: ${data.name}`)
        
      } else if (this.isDriveDataCorrupted(existingEntry) || existingEntry.name !== data.name) {
        // STEP 6: Update existing drive entry with corestore truth
        const oldBytes = existingEntry.totalBytes || 0
        const newBytes = data.totalBytes || 0
        
        const updatedEntry = {
          ...data,
          // Preserve non-data metadata
          createdAt: existingEntry.createdAt || data.createdAt,
          state: existingEntry.state || data.state,
          localPath: existingEntry.localPath || data.localPath,
          stats: { ...existingEntry.stats, ...data.stats }
        }
        
        manifest.drives[driveId] = updatedEntry
        manifest.stats.totalBytesShared += (newBytes - oldBytes)
        recovered++
        changed = true
        console.log(`[ManifestRecovery] 🔄 STEP 6: Recovered drive entry for ${driveId}: ${data.name} (was: ${existingEntry.name})`)
      }
    }
    
    console.log(`[ManifestRecovery] Recovery processing complete: ${created} created, ${recovered} recovered`)
    return { created, recovered, changed }
  }

  /**
   * STEPS 8-10: Handle drive entries that have no corestore
   */
  async _handleOrphanedDrives(corestoreData, manifest) {
    console.log('[ManifestRecovery] STEPS 8-10: Checking for orphaned drive entries...')
    
    const corestoreIds = new Set([
      ...corestoreData.withData.map(c => c.driveId),
      ...corestoreData.empty,
      ...corestoreData.errored.map(c => c.driveId)
    ])
    
    const orphaned = []
    
    // STEP 8: Find drive entries with no corestore
    for (const driveId of Object.keys(manifest.drives)) {
      if (!corestoreIds.has(driveId)) {
        orphaned.push(driveId)
        console.log(`[ManifestRecovery] 📍 STEP 8: Found orphaned drive entry: ${driveId} (${manifest.drives[driveId].name})`)
      }
    }
    
    // Include empty corestores in cleanup recommendation
    const totalToCleanup = [...orphaned, ...corestoreData.empty]
    const needsCleanup = totalToCleanup.length > 0
    
    if (needsCleanup) {
      console.log(`[ManifestRecovery] 🗑️ STEP 9: Recommend cleanup: ${orphaned.length} orphaned entries, ${corestoreData.empty.length} empty corestores`)
    }
    
    return {
      orphaned,
      emptyCorestores: corestoreData.empty,
      needsCleanup,
      totalToCleanup
    }
  }

  /**
   * Check if a drive's manifest data appears corrupted
   */
  isDriveDataCorrupted(drive) {
    return (
      (drive.name === 'Recovered download' || drive.name === 'Recovered share') ||
      ((!drive.files || drive.files.length === 0) && (drive.totalBytes === 0) && 
       (drive.name?.includes('Recovered') || drive.name === 'Empty share'))
    )
  }

  /**
   * Attempt to recover a corrupted manifest by parsing what we can
   */
  async recoverPartial() {
    console.log('[ManifestRecovery] Attempting partial manifest recovery...')
    
    try {
      // Backup corrupted file first
      const corruptedData = await fs.readFile(this.manifestPath, 'utf8')
      const backupPath = this.manifestPath + '.corrupted.' + Date.now()
      await fs.writeFile(backupPath, corruptedData)
      console.log('[ManifestRecovery] Backed up corrupted manifest', { backupPath })
      
      // Look for recoverable drive entries using regex
      const driveMatches = corruptedData.match(/"(drive_[^"]+|recv_[^"]+)": \{[^}]+\}/g) || []
      
      console.log('[ManifestRecovery] Found potentially recoverable entries', { count: driveMatches.length })
      
      // If we found some entries, try to parse them individually
      if (driveMatches.length > 0) {
        const manifest = { ...this.defaultManifest }
        let recoveredCount = 0
        
        for (const match of driveMatches) {
          try {
            // Try to parse individual drive entry
            const entryJson = `{${match}}`
            const entry = JSON.parse(entryJson)
            const driveId = Object.keys(entry)[0]
            
            // Validate the entry has required fields
            if (entry[driveId].key && entry[driveId].state) {
              manifest.drives[driveId] = entry[driveId]
              recoveredCount++
            }
          } catch {
            // Skip corrupted entries
          }
        }
        
        if (recoveredCount > 0) {
          console.log('[ManifestRecovery] Recovered entries from corruption', { recoveredCount })
          await this.saveManifest(manifest)
          return await this.validateAndSync(manifest)
        }
      }
      
    } catch (error) {
      console.warn('[ManifestRecovery] Partial recovery failed', error.message)
    }

    // Fall back to rebuilding from drives
    console.log('[ManifestRecovery] Falling back to rebuild from drives...')
    return await this.rebuildFromDrives()
  }

  /**
   * Recover a single orphaned drive and add to manifest
   * Checks for duplicates before adding
   */
  async recoverSingleDrive(driveId, currentManifest) {
    console.log('[ManifestRecovery] Recovering single drive', { driveId })
    
    // Check if already exists in manifest
    if (currentManifest.drives[driveId]) {
      return { success: false, error: 'Drive already exists in manifest', driveId }
    }

    try {
      const metadata = await this.scanDriveFolder(driveId)
      if (!metadata) {
        return { success: false, error: 'Failed to scan drive folder', driveId }
      }

      // Check for duplicate by key (prevent duplicate shares)
      const existingByKey = Object.values(currentManifest.drives).find(
        drive => drive.key === metadata.key
      )
      if (existingByKey) {
        console.log('[ManifestRecovery] Found duplicate drive by key', { 
          driveId, 
          existingId: existingByKey.driveId 
        })
        // Remove the orphaned folder since we have the same drive already
        await this.removeCorruptedDrive(driveId)
        return { 
          success: false, 
          error: `Duplicate of existing drive ${existingByKey.driveId}`, 
          driveId,
          cleaned: true 
        }
      }

      // Add to manifest
      currentManifest.drives[driveId] = metadata
      currentManifest.stats.totalCreated++
      currentManifest.stats.totalBytesShared += metadata.totalBytes || 0

      await this.saveManifest(currentManifest)

      console.log('[ManifestRecovery] Successfully recovered drive', { 
        driveId, 
        name: metadata.name, 
        files: metadata.files?.length,
        totalBytes: metadata.totalBytes
      })

      return { 
        success: true, 
        driveId, 
        metadata,
        name: metadata.name,
        files: metadata.files?.length || 0,
        totalBytes: metadata.totalBytes || 0
      }

    } catch (error) {
      console.error('[ManifestRecovery] Failed to recover drive', { driveId, error: error.message })
      return { success: false, error: error.message, driveId }
    }
  }

  /**
   * Scan a single drive folder and extract metadata
   */
  async scanDriveFolder(driveId) {
    const drivePath = path.join(this.drivesDir, driveId)
    
    try {
      // Verify it's a valid corestore directory
      const corestoreFile = path.join(drivePath, 'CORESTORE')
      await fs.access(corestoreFile)
    } catch {
      throw new Error('Not a valid corestore directory')
    }

    const Corestore = require('corestore')
    const Hyperdrive = require('hyperdrive')
    
    const store = new Corestore(drivePath)
    let drive, metadata
    
    try {
      await store.ready()
      drive = new Hyperdrive(store)
      await drive.ready()

      const key = drive.key.toString('hex')
      const discoveryKey = drive.discoveryKey.toString('hex')
      
      // Try to read manifest
      let manifestData = null
      let actualFiles = []
      
      console.log(`[ManifestRecovery] DEBUG ${driveId}: Starting file scan...`)
      
      try {
        const manifestBuffer = await drive.get('/.peardrop.json')
        if (manifestBuffer && manifestBuffer.length > 0) {
          manifestData = JSON.parse(manifestBuffer.toString())
          console.log(`[ManifestRecovery] DEBUG ${driveId}: Found manifest with ${manifestData.files?.length || 0} files`)
        } else {
          console.log(`[ManifestRecovery] DEBUG ${driveId}: Manifest buffer empty or null, trying direct file listing...`)
          // Manifest exists but empty - fall through to direct file listing
        }
      } catch (manifestError) {
        console.log(`[ManifestRecovery] DEBUG ${driveId}: No manifest (${manifestError.message}), trying direct file listing...`)
      }
      
      // If no valid manifest data, try listing files directly
      if (!manifestData) {
        try {
          let fileCount = 0
          for await (const entry of drive.list('/')) {
            fileCount++
            console.log(`[ManifestRecovery] DEBUG ${driveId}: Found file: ${entry.key}`)
            if (entry.key !== '/.peardrop.json') {
              try {
                const stat = await drive.stat(entry.key)
                actualFiles.push({
                  path: entry.key,
                  name: path.basename(entry.key),
                  size: stat.blob.byteLength
                })
                console.log(`[ManifestRecovery] DEBUG ${driveId}: File ${entry.key} size: ${stat.blob.byteLength} bytes`)
              } catch (statError) {
                // File exists in listing but can't stat - still count it
                actualFiles.push({
                  path: entry.key,
                  name: path.basename(entry.key),
                  size: 0
                })
                console.log(`[ManifestRecovery] DEBUG ${driveId}: File ${entry.key} - stat failed: ${statError.message}`)
              }
            }
          }
          console.log(`[ManifestRecovery] DEBUG ${driveId}: Direct listing found ${fileCount} total entries, ${actualFiles.length} actual files`)
        } catch (listError) {
          console.log(`[ManifestRecovery] DEBUG ${driveId}: File listing failed: ${listError.message}`)
        }
      }

      // Use manifest data if available, otherwise use discovered files
      const files = manifestData?.files || actualFiles
      const totalBytes = manifestData?.totalBytes || 
        actualFiles.reduce((sum, f) => sum + (f.size || 0), 0)
      
      // Determine if this is upload or download drive
      const isUpload = driveId.startsWith('drive_')
      const isDownload = driveId.startsWith('recv_')
      
      // Generate meaningful name
      let name
      if (manifestData?.name) {
        name = manifestData.name
      } else if (files.length === 1) {
        name = files[0].name || files[0].path
      } else if (files.length > 1) {
        name = `${files.length} files`
      } else {
        // No files found - this is either a pending download or empty upload
        if (isDownload) {
          name = 'Waiting for connection'  // Downloads that never got files
        } else {
          name = 'Empty share'  // Uploads with no files added
        }
      }
      
      // Build metadata structure
      metadata = {
        driveId: driveId,
        key: key,
        discoveryKey: discoveryKey,
        state: isUpload ? 'paused' : 'paused', // Always start paused for safety
        files: files,
        totalBytes: totalBytes,
        localPath: null,
        storagePath: drivePath,
        name: name,
        shareLink: `peardrop://${key}`,
        createdAt: manifestData?.created || Date.now(),
        isUpload: isUpload,
        stats: {
          uploaded: 0,
          downloaded: 0,
          peers: 0
        }
      }

      return metadata

    } finally {
      if (drive) await drive.close()
      if (store) await store.close()
    }
  }

  /**
   * Clean up orphaned drives and manifest entries
   */
  async cleanupOrphans(manifest) {
    let cleaned = false
    
    try {
      const entries = await fs.readdir(this.drivesDir, { withFileTypes: true })
      const driveFolders = entries.filter(e => e.isDirectory()).map(e => e.name)
      const manifestDrives = Object.keys(manifest.drives)
      
      // Remove drive folders not in manifest
      for (const driveId of driveFolders) {
        if (!manifestDrives.includes(driveId)) {
          console.log('[ManifestRecovery] Removing orphaned drive folder', { driveId })
          await this.removeCorruptedDrive(driveId)
          cleaned = true
        }
      }
      
      // Remove manifest entries for missing drive folders
      for (const driveId of manifestDrives) {
        if (!driveFolders.includes(driveId)) {
          console.log('[ManifestRecovery] Removing orphaned manifest entry', { driveId })
          delete manifest.drives[driveId]
          cleaned = true
        }
      }
      
      if (cleaned) {
        await this.saveManifest(manifest)
        console.log('[ManifestRecovery] Orphan cleanup completed')
      }
      
    } catch (error) {
      console.warn('[ManifestRecovery] Orphan cleanup failed', error.message)
    }
    
    return manifest
  }

  /**
   * Remove a corrupted drive folder
   */
  async removeCorruptedDrive(driveId) {
    try {
      const drivePath = path.join(this.drivesDir, driveId)
      await fs.rm(drivePath, { recursive: true, force: true })
      console.log('[ManifestRecovery] Removed corrupted drive folder', { driveId })
    } catch (error) {
      console.warn('[ManifestRecovery] Failed to remove drive folder', { driveId, error: error.message })
    }
  }

  /**
   * Save manifest to disk
   */
  async saveManifest(manifest) {
    try {
      await fs.writeFile(
        this.manifestPath,
        JSON.stringify(manifest, null, 2)
      )
    } catch (error) {
      console.error('[ManifestRecovery] Failed to save manifest', error)
      throw error
    }
  }
}

module.exports = ManifestRecovery