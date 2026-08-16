import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LEAGUE,
  DEFAULT_WEIGHTS,
  buildRoster,
  managerPicks,
  nextManagerPick,
  normalizedWeights,
  overallToRoundPick,
  projectUpcomingTurns,
  rankPlayers,
  snakePickForRound,
} from "../site/modules/engine.js";

const player = (id, name, position, adp, extras = {}) => ({
  id,
  name,
  position,
  team: "TST",
  bye: 8,
  status: "Active",
  injuryStatus: null,
  depthChartOrder: 1,
  markets: { ppr: { rank: Math.ceil(adp), adp, stdev: 5, tier: 1, timesDrafted: 100 } },
  scheduleContext: { games: 17, domeGames: 8, outdoorGames: 9, turfGames: 8, shortWeeks: 1, internationalGames: 0, metadataWarnings: [] },
  ...extras,
});

test("snake math is correct for edge and middle slots", () => {
  assert.equal(snakePickForRound(1, 10, 1), 1);
  assert.equal(snakePickForRound(1, 10, 2), 20);
  assert.equal(snakePickForRound(10, 10, 1), 10);
  assert.equal(snakePickForRound(10, 10, 2), 11);
  assert.deepEqual(managerPicks(3, 10, 4), [3, 18, 23, 38]);
  assert.equal(nextManagerPick(19, { ...DEFAULT_LEAGUE, slot: 1 }), 20);
});

test("round and in-round pick derive from overall pick", () => {
  assert.deepEqual(overallToRoundPick(1, 10), { round: 1, pickInRound: 1 });
  assert.deepEqual(overallToRoundPick(20, 10), { round: 2, pickInRound: 10 });
  assert.deepEqual(overallToRoundPick(21, 10), { round: 3, pickInRound: 1 });
});

test("roster assigns exact starters, flex, then bench", () => {
  const players = [
    player("rb1", "RB One", "RB", 1),
    player("rb2", "RB Two", "RB", 2),
    player("rb3", "RB Three", "RB", 3),
    player("rb4", "RB Four", "RB", 4),
  ];
  const byId = new Map(players.map((item) => [item.id, item]));
  const history = players.map((item, index) => ({ playerId: item.id, pick: index + 1, owner: "mine" }));
  const roster = buildRoster(history, byId, DEFAULT_LEAGUE);
  assert.equal(roster.find((slot) => slot.key === "RB1").player.id, "rb1");
  assert.equal(roster.find((slot) => slot.key === "RB2").player.id, "rb2");
  assert.equal(roster.find((slot) => slot.key === "FLEX").player.id, "rb3");
  assert.equal(roster.find((slot) => slot.key === "BENCH1").player.id, "rb4");
});

test("weights normalize to one", () => {
  const normalized = normalizedWeights({ ...DEFAULT_WEIGHTS, market: 0 });
  assert.ok(Math.abs(Object.values(normalized).reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
  assert.equal(normalized.market, 0);
});

test("schedule and split context can never exceed five percent combined", () => {
  const normalized = normalizedWeights({ market: 0, value: 0, need: 0, scarcity: 0, urgency: 0, role: 0, availability: 0, schedule: 50, splits: 50 });
  assert.ok(Math.abs(Object.values(normalized).reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
  assert.ok(normalized.schedule + normalized.splits <= 0.05 + Number.EPSILON);
});

test("half-PPR setting resolves the normalized halfPpr market key", async () => {
  const { activeMarket } = await import("../site/modules/engine.js");
  const candidate = player("half", "Half Back", "RB", 20, {
    markets: {
      ppr: { rank: 20, adp: 20, stdev: 4, tier: 2, timesDrafted: 10 },
      halfPpr: { rank: 12, adp: 12, stdev: 3, tier: 1, timesDrafted: 15 },
    },
  });
  assert.equal(activeMarket(candidate, "half-ppr").adp, 12);
});

test("a missing scoring market never silently falls back to PPR", async () => {
  const { activeMarket } = await import("../site/modules/engine.js");
  const candidate = player("ppr-only", "PPR Only", "WR", 20);
  assert.equal(activeMarket(candidate, "half-ppr"), null);
  assert.equal(activeMarket(candidate, "standard"), null);
});

test("ranking rewards an open starter need and returns bounded components", () => {
  const pool = [
    player("rb", "Running Back", "RB", 10),
    player("qb", "Quarterback", "QB", 11),
    player("wr", "Wide Receiver", "WR", 12),
    player("te", "Tight End", "TE", 20),
  ];
  const byId = new Map(pool.map((item) => [item.id, item]));
  const results = rankPlayers({ players: pool, playersById: byId, league: DEFAULT_LEAGUE, weights: DEFAULT_WEIGHTS, currentPick: 10 });
  assert.equal(results.length, 4);
  assert.ok(results.every((result) => result.score >= 0 && result.score <= 100));
  assert.ok(results.every((result) => Object.values(result.components).every((value) => value >= 0 && value <= 100)));
  assert.equal(results[0].components.need, 100);
});

test("position-specific roster need delays defense and kicker while moderating QB and TE", () => {
  const pool = [
    player("rb", "Running Back", "RB", 10),
    player("qb", "Quarterback", "QB", 11),
    player("te", "Tight End", "TE", 12),
    player("dst", "Test Defense", "D/ST", 13),
    player("k", "Test Kicker", "K", 14),
  ];
  const byId = new Map(pool.map((item) => [item.id, item]));
  const opening = new Map(rankPlayers({
    players: pool,
    playersById: byId,
    league: DEFAULT_LEAGUE,
    weights: DEFAULT_WEIGHTS,
    currentPick: 1,
  }).map((entry) => [entry.player.position, entry.components.need]));

  assert.equal(opening.get("RB"), 100);
  assert.equal(opening.get("QB"), 82);
  assert.equal(opening.get("TE"), 82);
  assert.equal(opening.get("D/ST"), 12);
  assert.equal(opening.get("K"), 12);

  const lateRoundPick = (DEFAULT_LEAGUE.rounds - 3) * DEFAULT_LEAGUE.teams + 1;
  const late = new Map(rankPlayers({
    players: pool,
    playersById: byId,
    league: DEFAULT_LEAGUE,
    weights: DEFAULT_WEIGHTS,
    currentPick: lateRoundPick,
  }).map((entry) => [entry.player.position, entry.components.need]));

  assert.equal(late.get("D/ST"), 62);
  assert.equal(late.get("K"), 62);
});

test("an inactive roster status is surfaced as a high availability risk", () => {
  const active = player("active", "Active Receiver", "WR", 20);
  const inactive = player("inactive", "Inactive Receiver", "WR", 21, { status: "Inactive" });
  const pool = [active, inactive];
  const byId = new Map(pool.map((item) => [item.id, item]));
  const results = rankPlayers({ players: pool, playersById: byId, league: DEFAULT_LEAGUE, weights: DEFAULT_WEIGHTS, currentPick: 20 });
  const activeResult = results.find((entry) => entry.player.id === "active");
  const inactiveResult = results.find((entry) => entry.player.id === "inactive");

  assert.equal(activeResult.components.availability, 92);
  assert.equal(inactiveResult.components.availability, 18);
  assert.match(inactiveResult.reason, /status risk/i);
});

test("future-turn plans remove one likely player for every intervening opponent pick", () => {
  const pool = Array.from({ length: 30 }, (_, index) => player(`p${index + 1}`, `Player ${index + 1}`, index % 2 ? "WR" : "RB", index + 1));
  const byId = new Map(pool.map((item) => [item.id, item]));
  const plan = projectUpcomingTurns({
    players: pool,
    draftedIds: new Set(),
    myHistory: [],
    playersById: byId,
    league: DEFAULT_LEAGUE,
    weights: DEFAULT_WEIGHTS,
    currentPick: 1,
    count: 2,
  });
  assert.deepEqual(plan.map((item) => item.pick), [1, 20]);
  assert.ok(plan[1].market.adp >= 20, `expected a plausible pick-20 survivor, got ADP ${plan[1].market.adp}`);
});
