import test from "node:test";
import assert from "node:assert/strict";
import {
  STATE_VERSION,
  addPick,
  defaultState,
  importSession,
  toggleQueue,
  undoPick,
  validateState,
} from "../site/modules/state.js";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

test("default state passes validation", () => {
  const state = defaultState();
  assert.equal(state.schemaVersion, STATE_VERSION);
  assert.deepEqual(validateState(state, new Set()).errors, []);
});

test("pick history is append-only and undoable", () => {
  let state = defaultState();
  state = addPick(state, { playerId: "p1", owner: "mine" });
  state = addPick(state, { playerId: "p2", owner: "other", scoreSnapshot: { score: 72 } });
  assert.deepEqual(state.history.map((entry) => entry.pick), [1, 2]);
  assert.equal(state.history[0].owner, "mine");
  state = undoPick(state);
  assert.deepEqual(state.history.map((entry) => entry.playerId), ["p1"]);
});

test("duplicate players and non-contiguous picks are rejected", () => {
  const state = defaultState();
  state.history = [
    { pick: 1, playerId: "p1", owner: "mine" },
    { pick: 3, playerId: "p1", owner: "other" },
  ];
  const result = validateState(state, new Set(["p1"]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("more than once")));
  assert.ok(result.errors.some((error) => error.includes("contiguous")));
});

test("imports preserve picks whose player has left the current market snapshot", () => {
  const state = defaultState();
  state.history = [{ pick: 1, playerId: "missing", owner: "mine", playerSnapshot: { name: "Saved Player", position: "WR", team: "OLD" } }];
  const imported = importSession({ exportType: "fantasy-war-room-session", session: state }, new Set(["known"]));
  assert.equal(imported.history[0].playerId, "missing");
  const result = validateState(imported, new Set(["known"]));
  assert.equal(result.valid, true);
  assert.equal(result.warnings.length, 1);
});

test("imports reject missing or unbounded roster definitions", () => {
  const missing = defaultState();
  delete missing.league.roster;
  assert.throws(() => importSession(missing, new Set()), /Roster settings are missing/);

  const huge = defaultState();
  huge.league.roster.bench = 1_000_000;
  assert.throws(() => importSession(huge, new Set()), /Roster bench must be an integer from 0 to 20/);
});

test("imports reject roster sizes that do not match the draft rounds", () => {
  const state = defaultState();
  state.league.roster.bench = 6;
  assert.throws(() => importSession(state, new Set()), /Roster size must equal/);
});

test("market shrinkage warns without discarding an otherwise valid session", () => {
  const state = defaultState();
  const marketSets = { ppr: new Set(Array.from({ length: 100 }, (_, index) => `p${index}`)), "half-ppr": new Set(), standard: new Set() };
  const result = validateState(state, marketSets);
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((warning) => warning.includes("fewer players")));
});

test("imports require complete weights and enforce the context ceiling", () => {
  const incomplete = defaultState();
  incomplete.weights = {};
  assert.throws(() => importSession(incomplete, new Set()), /Weight market is missing/);

  const contextHeavy = defaultState();
  contextHeavy.weights = { ...contextHeavy.weights, market: 0, value: 0, need: 0, scarcity: 0, urgency: 0, role: 0, availability: 0, schedule: 50, splits: 50 };
  assert.throws(() => importSession(contextHeavy, new Set()), /at most 5% combined/);
});

test("imported owners must match the configured snake turns", () => {
  const state = defaultState();
  state.history = [{ pick: 1, playerId: "p1", owner: "other" }];
  assert.throws(() => importSession(state, new Set(["p1"])), /does not match the configured snake turn/);
});

test("picks cannot be appended after the configured draft is complete", () => {
  let state = defaultState();
  state.league = { ...state.league, teams: 8, rounds: 10 };
  state.history = Array.from({ length: 80 }, (_, index) => ({ pick: index + 1, playerId: `p${index + 1}`, owner: "other" }));
  const result = addPick(state, { playerId: "p81", owner: "other" });
  assert.equal(result, state);
  assert.equal(result.history.length, 80);
});

test("the local target queue is persistent, ordered, removable, and import-safe", () => {
  let state = defaultState();
  state = toggleQueue(state, "p2");
  state = toggleQueue(state, "p1");
  assert.deepEqual(state.queue, ["p2", "p1"]);
  state = toggleQueue(state, "p2");
  assert.deepEqual(state.queue, ["p1"]);

  const imported = importSession(state, new Set(["p1"]));
  assert.deepEqual(imported.queue, ["p1"]);
});

test("legacy version-two sessions without a target queue remain valid", () => {
  const state = defaultState();
  delete state.queue;
  assert.equal(validateState(state, new Set()).valid, true);
});

test("duplicate or malformed target queue entries are rejected", () => {
  const duplicate = defaultState();
  duplicate.queue = ["p1", "p1"];
  assert.equal(validateState(duplicate, new Set(["p1"])).valid, false);

  const malformed = defaultState();
  malformed.queue = [42];
  assert.equal(validateState(malformed, new Set()).valid, false);
});

test("imports bound reserved local player notes", () => {
  const state = defaultState();
  state.playerNotes = { p1: "x".repeat(501) };
  assert.equal(validateState(state, new Set(["p1"])).valid, false);

  state.playerNotes = [];
  assert.equal(validateState(state, new Set(["p1"])).valid, false);
});
