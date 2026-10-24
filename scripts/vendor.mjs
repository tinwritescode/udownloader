// Copies the third-party runtime files the extension loads from
// node_modules into vendor/. Versions are pinned in package.json and
// verified by package-lock.json, so `npm ci && npm run vendor` is
// reproducible.
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const from = (...p) => join(root, "node_modules", ...p);
const to = (...p) => join(root, "vendor", ...p);

const ffmpegDist = from("@ffmpeg", "ffmpeg", "dist", "esm");
const ffmpegFiles = readdirSync(ffmpegDist).filter((f) => f.endsWith(".js"));

const copies = [
  ...ffmpegFiles.map((f) => [join(ffmpegDist, f), to("ffmpeg", f)]),
  ...["ffmpeg-core.js", "ffmpeg-core.wasm"].map((f) => [from("@ffmpeg", "core", "dist", "esm", f), to("ffmpeg", "core", f)]),
  [from("mux.js", "dist", "mux.min.js"), to("muxjs", "mux.min.js")],
  [from("mux.js", "LICENSE"), to("muxjs", "LICENSE")],
];

rmSync(to(), { recursive: true, force: true });
mkdirSync(to("ffmpeg", "core"), { recursive: true });
mkdirSync(to("muxjs"), { recursive: true });
for (const [src, dest] of copies) cpSync(src, dest);
console.log(`vendor/: ${copies.length} files copied`);
