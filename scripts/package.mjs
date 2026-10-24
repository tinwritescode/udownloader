// Builds dist/udownloader-v<version>.zip from an allowlist of the files
// the extension needs at runtime. Run `npm run vendor` first.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const json = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));
const { version } = json("manifest.json");
if (version !== json("package.json").version) throw new Error(`manifest.json ${version} and package.json versions differ`);

const tag = process.argv[2];
if (tag && tag !== `v${version}`) throw new Error(`Tag ${tag} does not match manifest version ${version}`);
if (!existsSync(join(root, "vendor", "ffmpeg", "core", "ffmpeg-core.wasm"))) throw new Error("vendor/ is missing; run `npm run vendor`");

const pages = readdirSync(root).filter((f) => /\.(html|css|js)$/.test(f));
const files = ["manifest.json", "LICENSE", "THIRD_PARTY_NOTICES.txt", ...pages, "icons", "vendor"];

const out = join(root, "dist", `udownloader-v${version}.zip`);
mkdirSync(join(root, "dist"), { recursive: true });
rmSync(out, { force: true });
execFileSync("zip", ["-q", "-r", "-X", out, ...files, "-x", "*.DS_Store"], { cwd: root, stdio: "inherit" });
console.log(`dist/udownloader-v${version}.zip`);
