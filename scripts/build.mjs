import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "site");
const target = path.join(root, "dist");
const workbookName = "2026_fantasy_football_draft_war_room_enhanced.xlsx";
const workbookSource = path.join(root, "outputs", "01a00cb2-1b20-7532-a316-3f9b477c6c34", workbookName);

if (path.dirname(target) !== root || path.basename(target) !== "dist") {
  throw new Error(`Refusing to build into unexpected path: ${target}`);
}

await fs.rm(target, { recursive: true, force: true });
await fs.cp(source, target, { recursive: true, errorOnExist: false });
await fs.mkdir(path.join(target, "downloads"), { recursive: true });
await fs.copyFile(workbookSource, path.join(target, "downloads", workbookName));
await fs.writeFile(path.join(target, ".nojekyll"), "", "utf8");

const required = [
  "index.html",
  "app.js",
  "styles.css",
  "modules/engine.js",
  "modules/state.js",
  "data/manifest.json",
  "data/players.json",
  "data/research.json",
  "data/environment.json",
  `downloads/${workbookName}`,
];

for (const file of required) {
  const stat = await fs.stat(path.join(target, file));
  if (!stat.isFile() || stat.size === 0) throw new Error(`Build output is missing or empty: ${file}`);
}

console.log(`Built ${required.length} required assets plus static files into ${target}`);
