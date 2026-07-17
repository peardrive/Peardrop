/**
 * MODULE: test/integration/run-parity.mjs
 * PURPOSE: Cross-engine parity suite. Runs the REAL mobile backend under the
 *          Bare runtime against the REAL desktop engine under node, over the
 *          real DHT — proving the two implementations stay in line with each
 *          other without needing a phone.
 * RUN:     node test/integration/run-parity.mjs            (all scenarios)
 *          node test/integration/run-parity.mjs offline    (single scenario)
 * SCENARIOS:
 *   d2m      desktop shares → mobile receives (online)
 *   m2d      mobile shares → desktop receives (online)
 *   offline  mobile opens a link while the provider is OFFLINE:
 *            entry must persist as seeking/manifestLoaded:false, and when the
 *            provider (desktop) comes online the mobile engine must hydrate
 *            and auto-download — Guy & Daniel's exact failure case
 *   reboot   same as offline, but the mobile engine restarts (fresh process)
 *            while still waiting — the entry must survive boot cleanup and
 *            complete after the provider returns
 * KEY STATE: children speak one-JSON-object-per-stdout-line ({evt, ...}).
 */
import { spawn } from "child_process";
import { createInterface } from "readline";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.join(__dirname, "..", "..");
// Spawn the NATIVE bare binary directly. The `bare` package's bin/bare is a
// node wrapper that re-spawns the real runtime as a child with
// suppressSignals:true — killing the wrapper orphans the actual engine
// process, which then keeps corestore locks alive and breaks the reboot
// scenario (and leaks processes).
const BARE = path.join(
  MOBILE, "node_modules", `bare-runtime-${process.platform}-${process.arch}`, "bin", "bare");
const MOBILE_CHILD = path.join(__dirname, "mobile-engine-child.mjs");
const DESKTOP_CHILD = path.join(__dirname, "desktop-engine-child.js");

const BASE = path.join(os.tmpdir(), `pd-parity-${Date.now()}`);
const ONLY = process.argv[2] || null;

const children = new Set();
function cleanup() { for (const c of children) { try { c.kill("SIGKILL"); } catch {} } }
process.on("exit", cleanup);

function fail(msg) { console.error("❌ FAIL:", msg); process.exitCode = 1; cleanup(); process.exit(1); }
function pass(msg) { console.log("✅", msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spawn a child; returns { proc, waitFor(evtName, timeoutMs), events } */
function launch(kind, args, label) {
  const [cmd, baseArgs] = kind === "mobile" ? [BARE, [MOBILE_CHILD]] : [process.execPath, [DESKTOP_CHILD]];
  const proc = spawn(cmd, [...baseArgs, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  children.add(proc);
  const events = [];
  const waiters = [];
  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    let obj;
    try { obj = JSON.parse(line); } catch { return; } // ignore engine console noise
    events.push(obj);
    if (process.env.PARITY_VERBOSE) console.log(`  [${label}]`, line);
    if (obj.evt === "fatal") fail(`${label} fatal: ${obj.error}`);
    for (const w of [...waiters]) {
      if (w.match(obj)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(obj); }
    }
  });
  proc.stderr.on("data", (d) => { if (process.env.PARITY_VERBOSE) console.error(`  [${label}!]`, String(d).trim()); });
  return {
    proc,
    events,
    kill() { children.delete(proc); try { proc.kill("SIGKILL"); } catch {} },
    waitFor(match, timeoutMs, what) {
      const fn = typeof match === "string" ? (o) => o.evt === match : match;
      const hit = events.find(fn);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${what || match} in ${label}`)), timeoutMs);
        waiters.push({ match: fn, resolve: (o) => { clearTimeout(t); resolve(o); } });
      });
    },
  };
}

async function makePayload(name) {
  const p = path.join(BASE, name);
  const content = `peardrop parity ${name} ${BASE}`;
  await fs.writeFile(p, content);
  return { p, content };
}

async function findDownloaded(rootDir, needle) {
  const names = await fs.readdir(rootDir, { recursive: true }).catch(() => []);
  const hit = names.find((n) => n.includes(needle) && !n.includes("drives"));
  return hit ? fs.readFile(path.join(rootDir, hit), "utf8") : null;
}

async function mobileManifest(root) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, "peardrop", "drives-manifest.json"), "utf8"));
  } catch { return { drives: {} }; }
}

// ---------------------------------------------------------------------------

async function scenarioD2M() {
  console.log("\n— d2m: desktop shares → mobile receives (online) —");
  const { p, content } = await makePayload("payload-d2m.txt");
  const sharer = launch("desktop", ["share", path.join(BASE, "d2m-sharer"), p], "d.share");
  const { link } = await sharer.waitFor("share-result", 60000, "share link");
  await sleep(10000); // let the DHT announce propagate

  const mroot = path.join(BASE, "d2m-mobile");
  const receiver = launch("mobile", ["open", mroot, link], "m.recv");
  const open = await receiver.waitFor("open-result", 90000, "open result");
  if (!open.ok) fail(`mobile open failed: ${open.error}`);
  const dl = await receiver.waitFor("download-result", 120000, "download");
  if (!dl.ok || dl.failed > 0) fail("mobile download failed");
  const got = await findDownloaded(path.join(mroot, "peardrop", "downloads"), "payload-d2m");
  if (got !== content) fail("d2m content mismatch");
  pass(`d2m: desktop → mobile transfer verified (${dl.files} file(s))`);
  sharer.kill(); receiver.kill();
}

async function scenarioM2D() {
  console.log("\n— m2d: mobile shares → desktop receives (online) —");
  const { p, content } = await makePayload("payload-m2d.txt");
  const sharer = launch("mobile", ["share", path.join(BASE, "m2d-mobile"), p], "m.share");
  const sr = await sharer.waitFor("share-result", 60000, "mobile share link");
  if (!sr.ok) fail("mobile share failed");
  await sleep(10000);

  const droot = path.join(BASE, "m2d-desktop");
  const receiver = launch("desktop", ["receive", droot, sr.link], "d.recv");
  const open = await receiver.waitFor("open-result", 90000, "desktop open");
  const dl = await receiver.waitFor("download-result", 120000, "desktop download");
  if (!dl.ok || dl.failed > 0) fail("desktop download failed");
  const got = await findDownloaded(path.join(droot, "downloads"), "payload-m2d");
  if (got !== content) fail("m2d content mismatch");
  pass(`m2d: mobile → desktop transfer verified (peerConnected=${open.peerConnected})`);
  sharer.kill(); receiver.kill();
}

async function offlineCommon({ reboot }) {
  const tag = reboot ? "reboot" : "offline";
  console.log(`\n— ${tag}: mobile opens with provider OFFLINE${reboot ? ", then mobile restarts" : ""} —`);
  const { p, content } = await makePayload(`payload-${tag}.txt`);

  // 1. Learn the link, then take the provider offline (kill -9 = crash;
  //    desktop entry stays 'active' so a later resume re-announces it).
  const sharerRoot = path.join(BASE, `${tag}-sharer`);
  const sharer1 = launch("desktop", ["share", sharerRoot, p], "d.share");
  const { link } = await sharer1.waitFor("share-result", 60000, "share link");
  sharer1.kill();
  await sleep(2000);
  console.log("  provider is now OFFLINE");

  // 2. Mobile opens the link with nobody home.
  const mroot = path.join(BASE, `${tag}-mobile`);
  let receiver = launch("mobile", ["open", mroot, link], "m.recv");
  const open = await receiver.waitFor("open-result", 90000, "open result");
  if (open.files > 0) fail("expected zero files with provider offline");

  // 3. THE PERSISTENCE CHECK — mirrors the desktop harness assertions.
  const m1 = await mobileManifest(mroot);
  const entry = Object.values(m1.drives).find((d) => d.origin === "received");
  if (!entry) fail("no manifest entry persisted for offline open");
  if (entry.state !== "seeking") fail(`entry state is '${entry.state}', expected 'seeking' (ACTIVE-empty = the old bug)`);
  if (entry.manifestLoaded !== false) fail(`entry.manifestLoaded is ${entry.manifestLoaded}, expected false`);
  pass(`${tag}: offline open persisted (seeking, manifestLoaded=false)`);

  if (reboot) {
    // 4a. Simulate app restart: kill the engine process, start a fresh one.
    // The generous sleep lets macOS release the dead process's corestore
    // flock — booting too fast hits the (correctly transient)
    // "File descriptor could not be locked" hydration failure.
    receiver.kill();
    await sleep(6000);
    receiver = launch("mobile", ["resume", mroot], "m.resume");
    await receiver.waitFor("ready", 30000, "mobile ready after reboot");
    await sleep(3000); // boot hydration is async
    const m2 = await mobileManifest(mroot);
    const entry2 = Object.values(m2.drives).find((d) => d.origin === "received");
    if (!entry2) fail("seeking entry was purged by boot cleanup (the old bug)");
    if (entry2.state !== "seeking") fail(`after reboot entry state is '${entry2.state}'`);
    pass("reboot: seeking entry survived boot cleanup and resumed");
  }

  // 4. Provider comes back online.
  console.log("  provider coming back ONLINE...");
  const sharer2 = launch("desktop", ["resume", sharerRoot], "d.resume");
  await sharer2.waitFor("ready", 30000, "sharer resumed");

  // 5. Mobile must hydrate + auto-download without any further user action.
  const ready = await receiver.waitFor(
    (o) => o.evt === "engine" && o.type === "drive-ready-to-download", 180000, "drive-ready-to-download");
  pass(`${tag}: late hydration fired drive-ready-to-download`);
  const dl = await receiver.waitFor("download-result", 120000, "auto-download");
  if (!dl.ok || dl.failed > 0) fail("auto-download failed");
  const got = await findDownloaded(path.join(mroot, "peardrop", "downloads"), `payload-${tag}`);
  if (got !== content) fail(`${tag} content mismatch`);

  const m3 = await mobileManifest(mroot);
  const entry3 = Object.values(m3.drives).find((d) => d.origin === "received");
  if (entry3?.manifestLoaded !== true) fail("entry not re-persisted with manifestLoaded=true after hydration");
  pass(`${tag}: hydrated, auto-downloaded, content verified — full parity with desktop`);
  receiver.kill(); sharer2.kill();
}

// ---------------------------------------------------------------------------

const SCENARIOS = {
  d2m: scenarioD2M,
  m2d: scenarioM2D,
  offline: () => offlineCommon({ reboot: false }),
  reboot: () => offlineCommon({ reboot: true }),
};

await fs.mkdir(BASE, { recursive: true });
console.log("work dir:", BASE);
for (const [name, fn] of Object.entries(SCENARIOS)) {
  if (ONLY && ONLY !== name) continue;
  await fn();
}
console.log("\n🍐 PARITY SUITE PASSED" + (ONLY ? ` (scenario: ${ONLY})` : " (all scenarios)"));
cleanup();
process.exit(0);
