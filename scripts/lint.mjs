import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const ignored = new Set([".git", "dist", "node_modules", "output"]);

async function walk(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else files.push(target);
  }
  return files;
}

const files = await walk(root);
const scripts = files.filter((file) => [".js", ".mjs"].includes(path.extname(file)));
const jsonFiles = files.filter((file) => path.extname(file) === ".json");

for (const file of scripts) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Syntax check failed for ${path.relative(root, file)}\n${result.stderr}`);
}

for (const file of jsonFiles) JSON.parse(await fs.readFile(file, "utf8"));

const html = await fs.readFile(path.join(root, "site", "index.html"), "utf8");
const app = await fs.readFile(path.join(root, "site", "app.js"), "utf8");
const violations = [];
if (/\b(?:src|href)=["']\/(?!\/)/i.test(html)) violations.push("index.html contains a root-absolute asset path");
if (/\son[a-z]+\s*=/i.test(html)) violations.push("index.html contains an inline event handler");
if (/\.innerHTML\s*=|insertAdjacentHTML\s*\(/.test(app)) violations.push("app.js uses an HTML-string injection API");
if (violations.length) throw new Error(violations.join("\n"));

console.log(`Linted ${scripts.length} scripts and parsed ${jsonFiles.length} JSON files`);
