import fs from "node:fs/promises";
import path from "node:path";

import { assessDraftReadiness } from "./lib/readiness.mjs";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await fs.readFile(path.join(root, "site", "data", "manifest.json"), "utf8"));
const now = process.env.FANTASY_READINESS_NOW ? new Date(process.env.FANTASY_READINESS_NOW) : new Date();
const result = assessDraftReadiness(manifest, { now });

for (const warning of result.warnings) console.warn(`WARNING: ${warning}`);
if (!result.ready) {
  console.error(result.errors.map((error) => `ERROR: ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  const oldest = Math.max(...Object.values(result.ages));
  console.log(`Draft-ready data gate passed: draft-critical inputs are at most ${oldest.toFixed(1)} hours old.`);
}
