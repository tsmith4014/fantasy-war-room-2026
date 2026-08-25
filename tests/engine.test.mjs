import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LEAGUE,
  DEFAULT_WEIGHTS,
  buildRecommendationShortlist,
  buildRoster,
  isSevereAvailabilityRisk,
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

test("a third quarterback or tight end receives no additional roster-need credit", () => {
  const pool = [
    player("qb1", "Quarterback One", "QB", 10),
    player("qb2", "Quarterback Two", "QB", 20),
    player("qb3", "Quarterback Three", "QB", 30),
    player("te1", "Tight End One", "TE", 11),
    player("te2", "Tight End Two", "TE", 21),
    player("te3", "Tight End Three", "TE", 31),
  ];
  const playersById = new Map(pool.map((item) => [item.id, item]));
  const draftedIds = new Set(["qb1", "qb2", "te1", "te2"]);
  const myHistory = [...draftedIds].map((playerId, index) => ({ pick: index + 1, playerId, owner: "mine" }));
  const results = new Map(rankPlayers({
    players: pool,
    draftedIds,
    myHistory,
    playersById,
    league: DEFAULT_LEAGUE,
    weights: DEFAULT_WEIGHTS,
    currentPick: 100,
  }).map((entry) => [entry.player.id, entry]));

  assert.equal(results.get("qb3").components.need, 0);
  assert.equal(results.get("te3").components.need, 0);
});

test("the final two manager turns complete kicker and defense without recommending duplicates", () => {
  const rosterPlayers = [
    player("my-qb", "My Quarterback", "QB", 1),
    player("my-rb1", "My Running Back 1", "RB", 2),
    player("my-rb2", "My Running Back 2", "RB", 3),
    player("my-wr1", "My Receiver 1", "WR", 4),
    player("my-wr2", "My Receiver 2", "WR", 5),
    player("my-te", "My Tight End", "TE", 6),
    player("my-flex", "My Flex", "RB", 7),
    ...Array.from({ length: 7 }, (_, index) => player(`my-bench-${index + 1}`, `My Bench ${index + 1}`, index % 2 ? "WR" : "RB", index + 8)),
  ];
  const candidates = [
    player("best-skill", "Best Skill Player", "RB", 15),
    player("k1", "Kicker One", "K", 190),
    player("k2", "Kicker Two", "K", 191),
    player("dst1", "Defense One", "D/ST", 192),
    player("dst2", "Defense Two", "D/ST", 193),
  ];
  const pool = [...rosterPlayers, ...candidates];
  const playersById = new Map(pool.map((item) => [item.id, item]));

  for (const teams of [8, 10, 16]) {
    for (let slot = 1; slot <= teams; slot += 1) {
      const league = { ...DEFAULT_LEAGUE, teams, slot, roster: { ...DEFAULT_LEAGUE.roster } };
      let draftedIds = new Set(rosterPlayers.map((item) => item.id));
      let myHistory = rosterPlayers.map((item, index) => ({ pick: index + 1, playerId: item.id, owner: "mine" }));
      const round15Pick = snakePickForRound(slot, teams, 15);
      const first = rankPlayers({ players: pool, draftedIds, myHistory, playersById, league, weights: DEFAULT_WEIGHTS, currentPick: round15Pick });
      assert.ok(["D/ST", "K"].includes(first[0].player.position), `${teams}-team slot ${slot} did not prioritize a required late starter`);
      assert.equal(first[0].requiredStarter, true, `${teams}-team slot ${slot} did not flag its deadline selection`);
      assert.equal(first.find((entry) => entry.player.id === "best-skill").requiredStarter, false);

      const firstSelection = first[0].player;
      draftedIds = new Set([...draftedIds, firstSelection.id]);
      myHistory = [...myHistory, { pick: round15Pick, playerId: firstSelection.id, owner: "mine" }];
      const round16Pick = snakePickForRound(slot, teams, 16);
      const second = rankPlayers({ players: pool, draftedIds, myHistory, playersById, league, weights: DEFAULT_WEIGHTS, currentPick: round16Pick });
      assert.ok(["D/ST", "K"].includes(second[0].player.position), `${teams}-team slot ${slot} did not finish its required late starters`);
      assert.notEqual(second[0].player.position, firstSelection.position, `${teams}-team slot ${slot} recommended a redundant ${firstSelection.position}`);

      const secondSelection = second[0].player;
      draftedIds = new Set([...draftedIds, secondSelection.id]);
      myHistory = [...myHistory, { pick: round16Pick, playerId: secondSelection.id, owner: "mine" }];
      const afterCompletion = rankPlayers({ players: pool, draftedIds, myHistory, playersById, league, weights: DEFAULT_WEIGHTS, currentPick: round16Pick });
      assert.equal(afterCompletion.some((entry) => ["D/ST", "K"].includes(entry.player.position)), false);
    }
  }
});

test("every exact starter is forced on its last safe turn in supported ten-round drafts", () => {
  const rosterPlayers = [
    player("my-rb1", "My Running Back 1", "RB", 1),
    player("my-rb2", "My Running Back 2", "RB", 2),
    player("my-wr1", "My Receiver 1", "WR", 3),
    player("my-wr2", "My Receiver 2", "WR", 4),
  ];
  const candidates = [
    player("best-skill", "Best Skill Player", "RB", 5),
    player("qb", "Required Quarterback", "QB", 150),
    player("te", "Required Tight End", "TE", 151),
    player("dst", "Required Defense", "D/ST", 152),
    player("k", "Required Kicker", "K", 153),
  ];
  const pool = [...rosterPlayers, ...candidates];
  const playersById = new Map(pool.map((item) => [item.id, item]));

  for (let teams = 8; teams <= 16; teams += 1) {
    for (let slot = 1; slot <= teams; slot += 1) {
      const league = { ...DEFAULT_LEAGUE, teams, slot, rounds: 10, roster: { ...DEFAULT_LEAGUE.roster, bench: 1 } };
      let draftedIds = new Set(rosterPlayers.map((item) => item.id));
      let myHistory = rosterPlayers.map((item, index) => ({ pick: index + 1, playerId: item.id, owner: "mine" }));

      for (let round = 7; round <= 10; round += 1) {
        const currentPick = snakePickForRound(slot, teams, round);
        const ranked = rankPlayers({ players: pool, draftedIds, myHistory, playersById, league, weights: DEFAULT_WEIGHTS, currentPick });
        assert.equal(ranked[0].requiredStarter, true, `${teams}-team slot ${slot} round ${round} did not force an exact starter`);
        assert.notEqual(ranked[0].player.id, "best-skill", `${teams}-team slot ${slot} round ${round} spent a deadline pick on a non-starter`);
        draftedIds = new Set([...draftedIds, ranked[0].player.id]);
        myHistory = [...myHistory, { pick: currentPick, playerId: ranked[0].player.id, owner: "mine" }];
      }

      const roster = buildRoster(myHistory, playersById, league);
      const openExact = roster.filter((entry) => entry.type === "starter" && entry.eligible.length === 1 && !entry.player);
      assert.deepEqual(openExact, [], `${teams}-team slot ${slot} did not complete every exact starter`);
    }
  }
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

test("severe availability risk recognizes PUP, IR, Out, Doubtful, and Inactive labels", () => {
  for (const [label, extras] of [
    ["PUP", { status: "PUP" }],
    ["IR", { status: "IR" }],
    ["Out", { injuryStatus: "Out" }],
    ["Doubtful", { injuryStatus: "Doubtful" }],
    ["Inactive", { status: "Inactive" }],
  ]) {
    assert.equal(isSevereAvailabilityRisk(player(label, label, "WR", 10, extras)), true, `${label} was not severe`);
  }
  assert.equal(isSevereAvailabilityRisk(player("questionable", "Questionable", "WR", 10, { injuryStatus: "Questionable" })), false);
  assert.equal(isSevereAvailabilityRisk(player("active", "Active", "WR", 10)), false);
});

test("future-turn plans skip severe availability risks while a safe recommendation exists", () => {
  const severe = player("severe", "Severe Risk", "WR", 1, { status: "PUP" });
  const safe = player("safe", "Safe Receiver", "WR", 2);
  const pool = [severe, safe];
  const byId = new Map(pool.map((item) => [item.id, item]));
  const league = { ...DEFAULT_LEAGUE, teams: 8, slot: 1, rounds: 1, roster: { ...DEFAULT_LEAGUE.roster, QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, "D/ST": 0, K: 0, bench: 1 } };

  const plan = projectUpcomingTurns({
    players: pool,
    draftedIds: new Set(),
    myHistory: [],
    playersById: byId,
    league,
    weights: DEFAULT_WEIGHTS,
    currentPick: 1,
    count: 1,
  });

  assert.equal(plan[0].player.id, "safe");
  assert.equal(rankPlayers({ players: pool, playersById: byId, league, weights: DEFAULT_WEIGHTS, currentPick: 1 }).some((entry) => entry.player.id === "severe"), true);
});

test("future-turn plans retain a severe required starter when no safe positional alternative exists", () => {
  const severe = player("severe-qb", "Severe Quarterback", "QB", 100, { injuryStatus: "Out" });
  const safeBench = player("safe-rb", "Safe Running Back", "RB", 1);
  const pool = [severe, safeBench];
  const byId = new Map(pool.map((item) => [item.id, item]));
  const league = { ...DEFAULT_LEAGUE, teams: 8, slot: 1, rounds: 1, roster: { ...DEFAULT_LEAGUE.roster, QB: 1, RB: 0, WR: 0, TE: 0, FLEX: 0, "D/ST": 0, K: 0, bench: 1 } };

  const plan = projectUpcomingTurns({
    players: pool,
    draftedIds: new Set(),
    myHistory: [],
    playersById: byId,
    league,
    weights: DEFAULT_WEIGHTS,
    currentPick: 1,
    count: 1,
  });

  assert.equal(plan[0].player.id, "severe-qb");
  assert.equal(plan[0].requiredStarter, true);
});

test("required starters remain ahead of a full queued-player shortlist", () => {
  const entry = (id, position, { requiredStarter = false, severe = false } = {}) => ({
    player: {
      id,
      name: id,
      position,
      status: severe ? "Inactive" : "Active",
      injuryStatus: severe ? "IR" : null,
    },
    requiredStarter,
  });
  const ranked = [
    entry("injured-kicker", "K", { requiredStarter: true, severe: true }),
    entry("kicker", "K", { requiredStarter: true }),
    entry("defense", "D/ST", { requiredStarter: true }),
    entry("wr-1", "WR"),
    entry("wr-2", "WR"),
    entry("wr-3", "WR"),
    entry("wr-4", "WR"),
    entry("wr-5", "WR"),
    entry("injured", "RB", { severe: true }),
  ];
  const shortlist = buildRecommendationShortlist({ ranked, queue: ["wr-1", "wr-2", "wr-3", "wr-4", "wr-5"], limit: 5 });
  assert.deepEqual(shortlist.map((item) => item.player.id), ["kicker", "defense", "wr-1", "wr-2", "wr-3"]);
});

test("a severe required starter appears only when no safe required option remains", () => {
  const severe = { player: player("severe", "Severe Kicker", "K", 1, { status: "PUP" }), requiredStarter: true };
  const safe = { player: player("safe", "Safe Kicker", "K", 2), requiredStarter: true };
  assert.deepEqual(buildRecommendationShortlist({ ranked: [severe, safe] }).map((item) => item.player.id), ["safe"]);
  assert.deepEqual(buildRecommendationShortlist({ ranked: [severe] }).map((item) => item.player.id), ["severe"]);
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
