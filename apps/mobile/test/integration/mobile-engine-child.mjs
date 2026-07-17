/**
 * MODULE: test/integration/mobile-engine-child.mjs
 * PURPOSE: Drive the REAL mobile backend (backend/hyperdrive-engine.mjs)
 *          under the Bare runtime for parity testing — the exact code that
 *          ships in the app bundle, on the real DHT, no mocks.
 * RUN:     node_modules/bare/bin/bare test/integration/mobile-engine-child.mjs <mode> <root> [arg]
 * MODES:
 *   share <root> <payloadPath> - init, share the file, print link, stay alive
 *   resume <root>              - init only (boot hydration runs), stay alive;
 *                                auto-downloads on drive-ready-to-download
 *   open <root> <link>         - init, open the link, print result, stay alive;
 *                                auto-downloads on drive-ready-to-download
 * PROTOCOL: one JSON object per stdout line: { evt: <name>, ...data }.
 *           Engine events are forwarded as { evt: 'engine', ...event }.
 *           The orchestrator (run-parity.mjs) kills children when done.
 */
import {
  engineInit,
  engineSetEmit,
  engineShareFromPaths,
  engineOpenDrive,
  engineDownload,
} from "../../backend/hyperdrive-engine.mjs";

const argv = typeof Bare !== "undefined" ? Bare.argv : process.argv;
// Bare.argv = ['/path/bare', 'script.mjs', ...args]; node adds one more lead
const args = argv.slice(argv.findIndex((a) => a.includes("mobile-engine-child")) + 1);
const [mode, root, extra] = args;

function out(evt, data = {}) {
  console.log(JSON.stringify({ evt, ...data }));
}

async function autoDownload(driveId) {
  out("download-start", { driveId });
  try {
    const res = await engineDownload(driveId);
    out("download-result", {
      driveId,
      ok: !!res?.ok,
      files: res?.files?.length ?? 0,
      failed: res?.failed?.length ?? 0,
    });
  } catch (err) {
    out("download-result", { driveId, ok: false, error: String(err?.message || err) });
  }
}

async function main() {
  if (!mode || !root) {
    out("fatal", { error: "usage: <share|resume|open> <root> [payload|link]" });
    return;
  }

  engineSetEmit((event) => {
    out("engine", event);
    // Mirror the RN-side wiring: a late-arriving provider fires
    // drive-ready-to-download and the app auto-starts the grab.
    if (event?.type === "drive-ready-to-download" && event.driveId) {
      autoDownload(event.driveId);
    }
  });

  await engineInit(root);
  out("ready", { mode, root });

  if (mode === "share") {
    const res = await engineShareFromPaths([extra]);
    out("share-result", { ok: !!res?.ok, link: res?.shareLink, driveId: res?.driveId });
  } else if (mode === "open") {
    const res = await engineOpenDrive(extra);
    out("open-result", {
      ok: !!res?.ok,
      driveId: res?.driveId,
      files: res?.files?.length ?? 0,
      hasManifest: !!res?.hasManifest,
      peerConnected: res?.peerConnected ?? null,
      error: res?.error ? String(res.error?.message || res.error) : undefined,
    });
    // If the open already found the provider, grab immediately (the RN app
    // does this via the preview modal's Grab button).
    if (res?.ok && res.driveId && (res.files?.length ?? 0) > 0) {
      await autoDownload(res.driveId);
    }
  } else if (mode !== "resume") {
    out("fatal", { error: `unknown mode ${mode}` });
    return;
  }

  // stay alive for swarm traffic until the orchestrator kills us
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => out("fatal", { error: String(err?.stack || err) }));
