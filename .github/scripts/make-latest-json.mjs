// Emit latest.json for Tauri 2 updater.
//
// Reads .sig files produced by `tauri build` (createUpdaterArtifacts: true)
// and writes a manifest pointing at the GitHub Release download URLs.
//
// Tauri 2 updater targets:
//   Windows NSIS → the installer .exe IS the updater artefact,
//                  signature lives in *.exe.sig.
//   macOS  app   → the .app.tar.gz bundle is the updater artefact,
//                  signature in *.app.tar.gz.sig.
//
// Artifact layout from actions/upload-artifact@v4: paths are anchored at the
// longest common prefix, so macOS files land in artifacts/macos/dmg/ +
// artifacts/macos/macos/. We recurse to find the .sig regardless of depth.
//
// Env:
//   VERSION   — "v0.1.1" (refs/tags/<VERSION>)
//   REPO      — "owner/repo"

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const VERSION = (process.env.VERSION ?? "").replace(/^v/, "");
const REPO = process.env.REPO ?? "";

if (!VERSION || !REPO) {
  console.error("VERSION and REPO env vars are required");
  process.exit(1);
}

const releaseBase = `https://github.com/${REPO}/releases/download/v${VERSION}`;
const pubDate = new Date().toISOString().replace(/\.\d+Z$/, "Z");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function findSig(dir, suffix) {
  try {
    return walk(dir).find((f) => f.endsWith(suffix)) ?? null;
  } catch {
    return null;
  }
}

const winSig = findSig("artifacts/windows", ".exe.sig");
const macSig = findSig("artifacts/macos",   ".app.tar.gz.sig");

if (!winSig) console.warn("⚠️  no Windows .exe.sig found");
if (!macSig) console.warn("⚠️  no macOS .app.tar.gz.sig found");

const platforms = {};

if (winSig) {
  const installer = basename(winSig).replace(/\.sig$/, "");
  platforms["windows-x86_64"] = {
    signature: readFileSync(winSig, "utf8").trim(),
    url: `${releaseBase}/${installer}`,
  };
}

if (macSig) {
  const archive = basename(macSig).replace(/\.sig$/, "");
  platforms["darwin-aarch64"] = {
    signature: readFileSync(macSig, "utf8").trim(),
    url: `${releaseBase}/${archive}`,
  };
}

const manifest = {
  version: VERSION,
  notes: `KroxPersonas v${VERSION}`,
  pub_date: pubDate,
  platforms,
};

writeFileSync("latest.json", JSON.stringify(manifest, null, 2));
console.log("✓ wrote latest.json");
console.log(JSON.stringify(manifest, null, 2));
