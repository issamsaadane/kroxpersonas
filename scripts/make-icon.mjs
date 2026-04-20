import sharp from "/Users/isssaada/Documents/KroxFlow Repo/kroxflow-media-os/app/node_modules/sharp/lib/index.js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(resolve(here, "../src-tauri/icons/source.svg"));
const out = resolve(here, "../src-tauri/icons/app-icon.png");

const png = await sharp(svg, { density: 384 })
  .resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();

writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
