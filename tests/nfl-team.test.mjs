import test from "node:test";
import assert from "node:assert/strict";

import { canonicalBye, canonicalTeam } from "../scripts/lib/nfl-team.mjs";

test("FFC free-agent identity and zero bye normalize to explicit nulls", () => {
  const team = canonicalTeam("FA");
  assert.equal(team, null);
  assert.equal(canonicalBye(team, 0, "Bub Means bye"), null);
});

test("active NFL teams retain aliases and require a real bye week", () => {
  assert.equal(canonicalTeam("JAC"), "JAX");
  assert.equal(canonicalBye("JAX", 8, "player bye"), 8);
  assert.throws(() => canonicalBye("JAX", 0, "player bye"), /outside 1\.\.18/);
});
