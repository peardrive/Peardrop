/**
 * Isolated PearDrop engine test harness (does NOT touch ~/peardrop).
 * Usage:
 *   node test/integration/offline-provider.harness.js online   — sharer up first, receiver opens, downloads (baseline)
 *   node test/integration/offline-provider.harness.js offline  — receiver opens FIRST (no provider), then sharer
 *                                      comes online; verifies persistence + late hydrate
 *   node test/integration/offline-provider.harness.js reboot   — offline open, receiver "reboots" (new manager on
 *                                      same state dir), THEN sharer appears; verifies
 *                                      seeking survives restart and completes
 */
const path = require('path')
const os = require('os')
const fs = require('fs/promises')

const DESKTOP = path.join(__dirname, '..', '..')
const { HyperdriveManager } = require(path.join(DESKTOP, 'lib/hyperdrive-manager.js'))
const { downloadFromDrive } = require(path.join(DESKTOP, 'lib/downloader.js'))

const MODE = process.argv[2] || 'online'
const BASE = path.join(os.tmpdir(), `pd-harness-${Date.now()}`)

function mkManager(role) {
  return new HyperdriveManager({
    drivesDir: path.join(BASE, role, 'drives'),
    manifestPath: path.join(BASE, role, 'drives-state.json'),
  })
}

async function readState(role) {
  try {
    return JSON.parse(await fs.readFile(path.join(BASE, role, 'drives-state.json'), 'utf8'))
  } catch { return { drives: {} } }
}

function fail(msg) { console.error('❌ FAIL:', msg); process.exit(1) }
function pass(msg) { console.log('✅', msg) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function startSharer(payloadPath) {
  const sharer = mkManager('sharer')
  await sharer.init()
  const share = await sharer.createDrive([{ path: payloadPath }], { name: 'harness-share' })
  console.log('[harness] sharer link:', share.shareLink)
  return { sharer, share }
}

async function verifyDownload(receiver, driveId, expected) {
  const session = receiver.activeDrives.get(driveId)
  if (!session) fail('no active session for ' + driveId)
  const destDir = path.join(BASE, 'received')
  await fs.mkdir(destDir, { recursive: true })
  const result = await downloadFromDrive(session.drive, {
    destDir, totalBytes: session.totalBytes || 0, shareName: session.shareName,
  })
  if (result.failed.length) fail(`download reported ${result.failed.length} failed files`)
  const names = (await fs.readdir(destDir, { recursive: true })).filter(n => n.includes('payload'))
  if (!names.length) fail('payload file not found in download dir')
  const got = await fs.readFile(path.join(destDir, names[0]), 'utf8')
  if (got !== expected) fail('downloaded content mismatch')
  pass(`transfer complete, content verified (${result.files.length} file(s), ${result.totalBytes} bytes)`)
}

async function main() {
  const payloadPath = path.join(BASE, 'payload.txt')
  const expected = `peardrop harness ${MODE} ${BASE}`
  await fs.mkdir(BASE, { recursive: true })
  await fs.writeFile(payloadPath, expected)

  if (MODE === 'online') {
    const { share } = await startSharer(payloadPath)
    await sleep(10000) // let the DHT announce propagate before the receiver looks
    const receiver = mkManager('receiver')
    await receiver.init()
    const open = await receiver.openDrive(share.shareLink)
    console.log('[harness] openDrive →', { peerConnected: open.peerConnected, files: open.files.length })
    if (!open.peerConnected) fail('baseline: expected peerConnected=true with sharer online')
    await verifyDownload(receiver, open.driveId, expected)
  }

  if (MODE === 'offline' || MODE === 'reboot') {
    // 1. Create the share ONCE to learn its link, then take the provider offline.
    const first = await startSharer(payloadPath)
    const link = first.share.shareLink
    // hard-stop: destroy all sharer sessions WITHOUT persisting state changes
    // (mimics a crash/quit — state stays 'active' so sharer2.init() re-announces)
    for (const [id, s] of first.sharer.activeDrives) {
      try { await s.swarm?.destroy(); await s.drive?.close(); await s.store?.close() } catch {}
    }
    console.log('[harness] provider is now OFFLINE')
    await sleep(2000)

    // 2. Receiver opens the link with nobody home.
    let receiver = mkManager('receiver')
    await receiver.init()
    const readyEvents = []
    receiver.on('drive-ready-to-download', (d) => readyEvents.push(d))
    const open = await receiver.openDrive(link)
    console.log('[harness] openDrive (no provider) →', { peerConnected: open.peerConnected, driveId: open.driveId })
    if (open.peerConnected) fail('expected peerConnected=false with provider offline')

    // 3. THE PERSISTENCE CHECK: entry must exist on disk, seeking, manifestLoaded=false
    const state1 = await readState('receiver')
    const entry = state1.drives[open.driveId]
    if (!entry) fail('no manifest entry persisted for offline open (THE BUG)')
    if (entry.state !== 'seeking') fail(`entry state is ${entry.state}, expected seeking`)
    if (entry.manifestLoaded !== false) fail(`entry.manifestLoaded is ${entry.manifestLoaded}, expected false`)
    pass('offline open persisted immediately (seeking, manifestLoaded=false)')

    let driveId = open.driveId
    if (MODE === 'reboot') {
      // 4a. Simulate app restart: tear down receiver, new manager on same state.
      receiver.removeAllListeners('drive-ready-to-download')
      for (const [id, s] of receiver.activeDrives) {
        try { await s.swarm?.destroy(); await s.drive?.close(); await s.store?.close() } catch {}
      }
      await sleep(1000)
      receiver = mkManager('receiver')
      receiver.on('drive-ready-to-download', (d) => readyEvents.push(d))
      await receiver.init()  // must resume the seeking drive
      const resumed = receiver.activeDrives.get(driveId)
      if (!resumed) fail('seeking drive not resumed after reboot')
      pass('seeking drive resumed after simulated reboot')
    }

    // 4. Provider comes back online (resume the same drive from its state).
    console.log('[harness] provider coming back ONLINE...')
    const sharer2 = mkManager('sharer')
    await sharer2.init()  // resumes the original share drive + re-announces

    // 5. Wait for the receiver to hydrate + signal ready-to-download.
    const deadline = Date.now() + 90000
    while (readyEvents.length === 0 && Date.now() < deadline) await sleep(500)
    if (readyEvents.length === 0) fail('drive-ready-to-download never fired after provider returned (THE BUG, half 2)')
    pass(`late hydration fired drive-ready-to-download (${JSON.stringify({ shareName: readyEvents[0].shareName, files: readyEvents[0].files?.length })})`)

    const state2 = await readState('receiver')
    const entry2 = state2.drives[driveId]
    if (!entry2 || entry2.manifestLoaded !== true) fail('entry not re-persisted with manifestLoaded=true after hydration')
    if (!entry2.files?.length) fail('entry has no files after hydration')
    pass('entry hydrated + persisted (manifestLoaded=true, files known)')

    await verifyDownload(receiver, driveId, expected)
  }

  console.log('\n🍐 ALL CHECKS PASSED for mode:', MODE)
  process.exit(0)
}

main().catch(err => { console.error('harness error:', err); process.exit(1) })
