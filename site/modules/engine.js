import { clamp, round } from "./utils.js";

export const DEFAULT_LEAGUE = Object.freeze({
  teams: 10,
  slot: 1,
  rounds: 16,
  scoring: "ppr",
  roster: Object.freeze({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, "D/ST": 1, K: 1, bench: 7 }),
});

export const DEFAULT_WEIGHTS = Object.freeze({
  market: 34,
  value: 16,
  need: 15,
  scarcity: 12,
  urgency: 10,
  role: 6,
  availability: 4,
  schedule: 2,
  splits: 1,
});

export const MAX_CONTEXT_SHARE = 0.05;

export const COMPONENT_META = Object.freeze({
  market: { label: "Market quality", description: "Inverse ADP percentile in the current draft pool." },
  value: { label: "Pick value", description: "How far the player has fallen or would be reached for at this pick." },
  need: { label: "Roster need", description: "Open starter, flex, and balanced-bench pressure for this position." },
  scarcity: { label: "Positional scarcity", description: "The likely quality drop at this position before your next turn." },
  urgency: { label: "Next-pick urgency", description: "ADP and market volatility estimate of whether the player lasts." },
  role: { label: "Role signal", description: "Conservative active/depth metadata; not a projection." },
  availability: { label: "Availability", description: "Source-labeled injury/status signal, not a medical conclusion." },
  schedule: { label: "Schedule context", description: "Small roof, rest, and international-game stability modifier." },
  splits: { label: "Personal splits", description: "Shrunk historical roof/surface fit with sample-size guardrails." },
});

const FLEX_POSITIONS = new Set(["RB", "WR", "TE"]);

export function activeMarket(player, scoring = "ppr") {
  const key = scoring === "half-ppr" ? "halfPpr" : scoring;
  return player?.markets?.[key] ?? null;
}

export function overallToRoundPick(overall, teams) {
  const safeTeams = Math.max(1, Number(teams) || 1);
  const safeOverall = Math.max(1, Number(overall) || 1);
  return {
    round: Math.floor((safeOverall - 1) / safeTeams) + 1,
    pickInRound: ((safeOverall - 1) % safeTeams) + 1,
  };
}

export function snakePickForRound(slot, teams, round) {
  const safeSlot = clamp(slot, 1, teams);
  const safeRound = Math.max(1, Number(round) || 1);
  const offset = safeRound % 2 === 1 ? safeSlot : teams - safeSlot + 1;
  return (safeRound - 1) * teams + offset;
}

export function managerPicks(slot, teams, rounds) {
  return Array.from({ length: rounds }, (_, index) => snakePickForRound(slot, teams, index + 1));
}

export function nextManagerPick(currentOverall, league, { strictlyAfter = false } = {}) {
  const threshold = Math.max(1, Number(currentOverall) || 1) + (strictlyAfter ? 1 : 0);
  return managerPicks(league.slot, league.teams, league.rounds).find((pick) => pick >= threshold) ?? null;
}

export function isManagerPick(overall, league) {
  return managerPicks(league.slot, league.teams, league.rounds).includes(overall);
}

export function normalizedWeights(weights = DEFAULT_WEIGHTS) {
  const entries = Object.keys(DEFAULT_WEIGHTS).map((key) => [key, Math.max(0, Number(weights[key]) || 0)]);
  const total = entries.reduce((sum, [, value]) => sum + value, 0) || 1;
  const normalized = Object.fromEntries(entries.map(([key, value]) => [key, value / total]));
  const contextTotal = normalized.schedule + normalized.splits;
  if (contextTotal <= MAX_CONTEXT_SHARE) return normalized;

  const nonContextKeys = Object.keys(DEFAULT_WEIGHTS).filter((key) => !["schedule", "splits"].includes(key));
  const nonContextTotal = nonContextKeys.reduce((sum, key) => sum + normalized[key], 0);
  const defaultNonContextTotal = nonContextKeys.reduce((sum, key) => sum + DEFAULT_WEIGHTS[key], 0);
  for (const key of ["schedule", "splits"]) normalized[key] = normalized[key] / contextTotal * MAX_CONTEXT_SHARE;
  for (const key of nonContextKeys) {
    const share = nonContextTotal > 0 ? normalized[key] / nonContextTotal : DEFAULT_WEIGHTS[key] / defaultNonContextTotal;
    normalized[key] = share * (1 - MAX_CONTEXT_SHARE);
  }
  return normalized;
}

export function rosterDefinitions(league = DEFAULT_LEAGUE) {
  const slots = [];
  const add = (position, count, eligible = [position]) => {
    for (let index = 1; index <= count; index += 1) {
      slots.push({
        key: count === 1 ? position : `${position}${index}`,
        label: count === 1 ? position : `${position}${index}`,
        type: "starter",
        eligible,
      });
    }
  };
  add("QB", league.roster.QB);
  add("RB", league.roster.RB);
  add("WR", league.roster.WR);
  add("TE", league.roster.TE);
  add("FLEX", league.roster.FLEX, [...FLEX_POSITIONS]);
  add("D/ST", league.roster["D/ST"]);
  add("K", league.roster.K);
  for (let index = 1; index <= league.roster.bench; index += 1) {
    slots.push({ key: `BENCH${index}`, label: `BN${index}`, type: "bench", eligible: ["QB", "RB", "WR", "TE", "D/ST", "K"] });
  }
  return slots;
}

export function buildRoster(myHistory, playersById, league = DEFAULT_LEAGUE) {
  const slots = rosterDefinitions(league).map((slot) => ({ ...slot, player: null, pick: null }));
  for (const entry of myHistory) {
    const player = playersById.get(entry.playerId);
    if (!player) continue;
    const exact = slots.find((slot) => slot.type === "starter" && !slot.player && slot.label.startsWith(player.position) && slot.eligible.includes(player.position));
    const flex = FLEX_POSITIONS.has(player.position)
      ? slots.find((slot) => slot.type === "starter" && !slot.player && slot.key.startsWith("FLEX"))
      : null;
    const bench = slots.find((slot) => slot.type === "bench" && !slot.player);
    const target = exact ?? flex ?? bench;
    if (target) {
      target.player = player;
      target.pick = entry.pick;
    }
  }
  return slots;
}

function rosterNeed(position, roster, league, currentPick) {
  const exactOpen = roster.some((slot) => slot.type === "starter" && !slot.player && slot.label.startsWith(position) && slot.eligible.includes(position));
  const draftedAtPosition = roster.filter((slot) => slot.player?.position === position).length;
  const { round } = overallToRoundPick(currentPick, league.teams);
  if (["D/ST", "K"].includes(position)) return exactOpen && round >= league.rounds - 2 && draftedAtPosition === 0 ? 62 : 12;
  if (["QB", "TE"].includes(position) && exactOpen) return 82;
  if (exactOpen) return 100;

  const flexOpen = FLEX_POSITIONS.has(position) && roster.some((slot) => slot.type === "starter" && !slot.player && slot.key.startsWith("FLEX"));
  if (flexOpen) return 78;

  if (["RB", "WR"].includes(position)) return draftedAtPosition < 5 ? 62 - draftedAtPosition * 5 : 30;
  if (["QB", "TE"].includes(position)) return draftedAtPosition === 0 ? 82 : draftedAtPosition === 1 ? 38 : 18;
  return 45;
}

function roleScore(player) {
  if (["D/ST", "K"].includes(player.position)) return 68;
  const order = Number(player.depthChartOrder);
  let score = Number.isFinite(order) && order > 0 ? ({ 1: 90, 2: 68, 3: 50 }[order] ?? 35) : 56;
  const status = String(player.status ?? "").toLowerCase();
  if (status && !["active", "inactive"].includes(status)) score -= 18;
  if (status === "inactive") score -= 25;
  return clamp(score);
}

function availabilityScore(player) {
  const injury = String(player.injuryStatus ?? "").toLowerCase();
  const status = String(player.status ?? "").toLowerCase();
  if (/ir|pup|out|suspend|nfi/.test(`${injury} ${status}`)) return 6;
  if (/inactive/.test(status)) return 18;
  if (/doubt/.test(injury)) return 24;
  if (/question|limited|day-to-day/.test(injury)) return 52;
  if (/probable/.test(injury)) return 76;
  return 92;
}

function scheduleScore(player) {
  const context = player.scheduleContext;
  if (!context?.games) return 50;
  const domeRate = context.domeGames / context.games;
  const warningPenalty = Math.min(8, (context.metadataWarnings?.length ?? 0) * 3);
  return clamp(52 + domeRate * 16 - context.shortWeeks * 3.5 - context.internationalGames * 1.8 - warningPenalty);
}

function splitScore(player) {
  const value = Number(player.splits?.contextScore);
  const confidence = clamp(player.splits?.confidence ?? 0, 0, 1);
  if (!Number.isFinite(value) || confidence <= 0) return 50;
  return clamp(50 + (value - 50) * confidence);
}

function scarcityScore(player, available, scoring, nextPick) {
  const current = activeMarket(player, scoring);
  if (!current) return 45;
  const peers = available
    .filter((candidate) => candidate.position === player.position && activeMarket(candidate, scoring))
    .sort((a, b) => activeMarket(a, scoring).adp - activeMarket(b, scoring).adp);
  const index = peers.findIndex((candidate) => candidate.id === player.id);
  if (index < 0) return 45;
  const likelyGone = peers.filter((candidate) => activeMarket(candidate, scoring).adp < nextPick).length;
  const fallbackIndex = Math.min(peers.length - 1, Math.max(index + 1, likelyGone));
  const fallback = activeMarket(peers[fallbackIndex], scoring);
  const gap = fallback ? fallback.adp - current.adp : 0;
  return clamp(42 + gap * 5.5);
}

function urgencyScore(market, nextPick) {
  if (!market || !nextPick) return 50;
  const deviation = Math.max(2.5, Number(market.stdev) || 7);
  const z = (nextPick - market.adp) / deviation;
  return clamp(100 / (1 + Math.exp(-z)));
}

function recommendationReason(components, player, market, currentPick) {
  if (components.availability < 35) return "high status risk—verify before selecting";
  const candidates = [];
  const valueDelta = currentPick - market.adp;
  if (valueDelta >= 6) candidates.push({ value: components.value + 8, text: `${round(valueDelta, 0)} picks past ADP` });
  if (components.need >= 90) candidates.push({ value: components.need, text: "fills an open starter" });
  if (components.scarcity >= 72) candidates.push({ value: components.scarcity, text: `${player.position} tier cliff is approaching` });
  if (components.urgency >= 82) candidates.push({ value: components.urgency, text: "unlikely to reach your next turn" });
  if (components.market >= 80) candidates.push({ value: components.market, text: "top-end market profile" });
  candidates.sort((a, b) => b.value - a.value);
  return candidates[0]?.text ?? "balanced market, roster, and scarcity fit";
}

export function scorePlayer({ player, available, roster, league, weights, currentPick, nextPick }) {
  const market = activeMarket(player, league.scoring);
  if (!market) return null;
  const poolMax = Math.max(league.teams * league.rounds, ...available.map((candidate) => activeMarket(candidate, league.scoring)?.adp ?? 0));
  const components = {
    market: clamp(100 - ((market.adp - 1) / Math.max(1, poolMax - 1)) * 100),
    value: clamp(50 + ((currentPick - market.adp) / Math.max(12, league.teams * 2.5)) * 45),
    need: rosterNeed(player.position, roster, league, currentPick),
    scarcity: scarcityScore(player, available, league.scoring, nextPick),
    urgency: urgencyScore(market, nextPick),
    role: roleScore(player),
    availability: availabilityScore(player),
    schedule: scheduleScore(player),
    splits: splitScore(player),
  };
  const normalized = normalizedWeights(weights);
  const weighted = Object.fromEntries(Object.entries(components).map(([key, value]) => [key, value * normalized[key]]));
  const score = clamp(Object.values(weighted).reduce((sum, value) => sum + value, 0));
  return {
    player,
    market,
    score: round(score, 1),
    components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, round(value, 1)])),
    weighted: Object.fromEntries(Object.entries(weighted).map(([key, value]) => [key, round(value, 2)])),
    reason: recommendationReason(components, player, market, currentPick),
  };
}

export function rankPlayers({ players, draftedIds = new Set(), myHistory = [], playersById, league = DEFAULT_LEAGUE, weights = DEFAULT_WEIGHTS, currentPick = 1 }) {
  const available = players.filter((player) => !draftedIds.has(player.id) && activeMarket(player, league.scoring));
  const roster = buildRoster(myHistory, playersById, league);
  const nextPick = nextManagerPick(currentPick, league, { strictlyAfter: isManagerPick(currentPick, league) })
    ?? league.teams * league.rounds;
  return available
    .map((player) => scorePlayer({ player, available, roster, league, weights, currentPick, nextPick }))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.market.adp - b.market.adp || a.player.name.localeCompare(b.player.name));
}

export function projectUpcomingTurns({ players, draftedIds, myHistory, playersById, league, weights, currentPick, count = 4 }) {
  const futurePicks = managerPicks(league.slot, league.teams, league.rounds).filter((pick) => pick >= currentPick).slice(0, count);
  const simulatedDrafted = new Set(draftedIds);
  const simulatedHistory = [...myHistory];
  const plan = [];
  let priorPick = currentPick;

  for (const targetPick of futurePicks) {
    const opponentSelections = Math.max(0, targetPick - priorPick);
    players
      .filter((player) => !simulatedDrafted.has(player.id) && activeMarket(player, league.scoring))
      .sort((a, b) => activeMarket(a, league.scoring).adp - activeMarket(b, league.scoring).adp)
      .slice(0, opponentSelections)
      .forEach((player) => simulatedDrafted.add(player.id));
    const ranked = rankPlayers({ players, draftedIds: simulatedDrafted, myHistory: simulatedHistory, playersById, league, weights, currentPick: targetPick });
    const selection = ranked[0];
    if (!selection) break;
    plan.push({ pick: targetPick, ...selection });
    simulatedDrafted.add(selection.player.id);
    simulatedHistory.push({ pick: targetPick, playerId: selection.player.id, owner: "mine" });
    priorPick = targetPick + 1;
  }
  return plan;
}
