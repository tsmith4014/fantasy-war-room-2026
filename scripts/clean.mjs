import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const target = path.join(root, "dist");

if (path.dirname(target) !== root || path.basename(target) !== "dist") {
  throw new Error(`Refusing to clean unexpected path: ${target}`);
}

await fs.rm(target, { recursive: true, force: true });
console.log(`Cleaned ${target}`);
