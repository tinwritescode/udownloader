// Renders assets/icon.svg to the PNG sizes the manifest lists.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const root = join(import.meta.dirname, "..");
const svg = readFileSync(join(root, "assets", "icon.svg"));
for (const size of [16, 32, 48, 128]) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  writeFileSync(join(root, "icons", `icon-${size}.png`), png);
}
console.log("icons/: 4 sizes written");
