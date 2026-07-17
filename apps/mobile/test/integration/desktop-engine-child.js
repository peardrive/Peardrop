/**
 * MODULE: test/integration/desktop-engine-child.js
 * PURPOSE: Drive the desktop engine (apps/desktop/lib/hyperdrive-manager.js)
 *          under node as the counterpart in cross-engine parity tests.
 * RUN:     node test/integration/desktop-engine-child.js <mode> <root> [arg]
 * MODES:
 *   share <root> <payloadPath> - init, share, print link, stay alive
 *   resume <root>              - init (resumes actives), stay alive
 *   receive <root> <link>      - openDrive; downloads when hydrated (inline
 *                                or via drive-ready-to-download), stays alive
 * PROTOCOL: one JSON object per stdout line, same shape as the mobile child.
 */
const path = require("path");

const DESKTOP = path.join(__dirname, "..", "..", "..", "desktop");
const { HyperdriveManager } = require(path.join(DESKTOP, "lib", "hyperdrive-manager.js"));
const { downloadFromDrive } = require(path.join(DESKTOP, "lib", "downloader.js"));

const [mode, root, extra] = process.argv.slice(2);

function out(evt, data = {}) {
  console.log(JSON.stringify({ evt, ...data }));
}

async function main() {
  const manager = new HyperdriveManager({
    drivesDir: path.join(root, "drives"),
    manifestPath: path.join(root, "drives-state.json"),
  });

  const autoDownload = async (driveId) => {
    out("download-start", { driveId });
    try {
      const session = manager.activeDrives.get(driveId);
      const res = await downloadFromDrive(session.drive, {
        destDir: path.join(root, "downloads"),
        totalBytes: session.totalBytes || 0,
        shareName: session.shareName,
      });
      out("download-result", { driveId, ok: true, files: res.files.length, failed: res.failed.length });
    } catch (err) {
      out("download-result", { driveId, ok: false, error: String(err?.message || err) });
    }
  };

  manager.on("drive-ready-to-download", (d) => {
    out("engine", { type: "drive-ready-to-download", ...d, files: d.files?.length });
    autoDownload(d.driveId);
  });

  await manager.init();
  out("ready", { mode, root });

  if (mode === "share") {
    const share = await manager.createDrive([{ path: extra }]);
    out("share-result", { ok: true, link: share.shareLink, driveId: share.driveId });
  } else if (mode === "receive") {
    const res = await manager.openDrive(extra);
    out("open-result", {
      ok: true,
      driveId: res.driveId,
      files: res.files.length,
      hasManifest: res.hasManifest,
      peerConnected: res.peerConnected,
    });
    if (res.peerConnected && res.files.length > 0) {
      await autoDownload(res.driveId);
    }
  } else if (mode !== "resume") {
    out("fatal", { error: `unknown mode ${mode}` });
    return;
  }

  setInterval(() => {}, 1 << 30);
}

main().catch((err) => out("fatal", { error: String(err?.stack || err) }));
