// Emit latest.json for Tauri 2 updater.
//
// Reads .sig files produced by `tauri build` (createUpdaterArtifacts: true)
// and writes a manifest pointing at the GitHub Release download URLs.
//
// Env:
//   VERSION   — "v0.1.1" (refs/tags/<VERSION>)
//   REPO      — "owner/repo"

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const VERSION = (process.env.VERSION ?? "").replace(/^v/, "");
const REPO = process.env.REPO ?? "";

if (!VERSION || !REPO) {
  console.error("VERSION and REPO env vars are required");
  process.exit(1);
}

const releaseBase = `https://github.com/${REPO}/releases/download/v${VERSION}`;
const pubDate = new Date().toISOString().replace(/\.\d+Z$/, "Z");

function pick(dir, predicate) {
  const entries = readdirSync(dir);
  return entries.find(predicate) ?? null;
}

function readSig(path) {
  return readFileSync(path, "utf8").trim();
}

const winSigFile = pick("artifacts/windows", (f) => f.endsWith(".nsis.zip.sig"));
const macSigFile = pick("artifacts/macos",   (f) => f.endsWith(".app.tar.gz.sig"));

if (!winSigFile) console.warn("⚠️  no Windows .nsis.zip.sig found in artifacts/windows");
if (!macSigFile) console.warn("⚠️  no macOS .app.tar.gz.sig found in artifacts/macos");

const winZipUrl = winSigFile ? `${releaseBase}/${winSigFile.replace(/\.sig$/, "")}` : null;
const macTarUrl = macSigFile ? `${releaseBase}/${macSigFile.replace(/\.sig$/, "")}` : null;

const platforms = {};
if (winSigFile) {
  platforms["windows-x86_64"] = {
    signature: readSig(join("artifacts/windows", winSigFile)),
    url: winZipUrl,
  };
}
if (macSigFile) {
  platforms["darwin-aarch64"] = {
    signature: readSig(join("artifacts/macos", macSigFile)),
    url: macTarUrl,
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
