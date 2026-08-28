import fs from "node:fs/promises";
import path from "node:path";

import { parseCsv } from "./lib/csv.mjs";
import { fetchTextOnce } from "./lib/data-io.mjs";
import {
  DEFAULT_LEAGUE,
  DEFAULT_WEIGHTS,
  activeMarket,
  buildRoster,
  isManagerPick,
  isSevereAvailabilityRisk,
  rankPlayers,
} from "../site/modules/engine.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCHEDULE_URL = "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv";
const STATS = [2022, 2023, 2024, 2025].map((season) => ({
  season,
  url: `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`,
}));
const POSITIONS = ["QB", "RB", "WR", "TE"];
const FEATURE_NAMES = [
  "intercept",
  "dome",
  "artificial surface",
  "short rest",
  "recorded outdoor weather",
  "temperature centered at 60F",
  "wind centered at 10 mph",
  "QB x temperature",
  "QB x wind",
  "RB x temperature",
  "RB x wind",
  "WR x temperature",
  "WR x wind",
  "TE x temperature",
  "TE x wind",
];

function canonicalTeam(value) {
  const team = String(value ?? "").trim().toUpperCase();
  return ({ LA: "LAR", STL: "LAR", OAK: "LV", SD: "LAC", JAC: "JAX", WSH: "WAS" })[team] ?? team;
}

function roofBucket(value) {
  const roof = String(value ?? "").toLowerCase();
  return ["dome", "closed", "indoors", "indoor"].includes(roof) ? "dome" : ["outdoors", "outdoor", "open"].includes(roof) ? "outdoor" : "unknown";
}

function artificialSurface(value) {
  return /turf|artificial|synthetic|astro|matrix|sportturf/i.test(String(value ?? ""));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function round(value, places = 3) {
  const multiplier = 10 ** places;
  return Math.round((Number(value) + Number.EPSILON) * multiplier) / multiplier;
}

function metrics(actual, predicted) {
  const errors = actual.map((value, index) => predicted[index] - value);
  return {
    mae: round(average(errors.map(Math.abs)), 3),
    rmse: round(Math.sqrt(average(errors.map((error) => error ** 2))), 3),
  };
}

function solve(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    if (Math.abs(divisor) < 1e-10) continue;
    for (let index = column; index <= size; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index <= size; index += 1) augmented[row][index] -= factor * augmented[column][index];
    }
  }
  return augmented.map((row, index) => Number.isFinite(row[size]) ? row[size] : index === 0 ? 0 : 0);
}

function fitRidge(rows, lambda) {
  const width = rows[0].features.length;
  const xtx = Array.from({ length: width }, () => Array(width).fill(0));
  const xty = Array(width).fill(0);
  for (const row of rows) {
    for (let left = 0; left < width; left += 1) {
      xty[left] += row.features[left] * row.residual;
      for (let right = 0; right < width; right += 1) xtx[left][right] += row.features[left] * row.features[right];
    }
  }
  for (let index = 1; index < width; index += 1) xtx[index][index] += lambda;
  return solve(xtx, xty);
}

function ridgePredict(rows, coefficients) {
  return rows.map((row) => row.baseline + row.features.reduce((sum, feature, index) => sum + feature * coefficients[index], 0));
}

function quantile(values, proportion) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * proportion)));
  return sorted[index];
}

function fitBoostedStumps(rows, iterations = 20, learningRate = 0.08) {
  const residualTargets = rows.map((row) => row.residual);
  const initial = average(residualTargets) ?? 0;
  const predictions = rows.map(() => initial);
  const stumps = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const residuals = residualTargets.map((value, index) => value - predictions[index]);
    let best = null;
    for (let feature = 1; feature < rows[0].features.length; feature += 1) {
      const featureValues = rows.map((row) => row.features[feature]);
      const thresholds = [...new Set([0.1, 0.25, 0.5, 0.75, 0.9].map((proportion) => quantile(featureValues, proportion)))];
      for (const threshold of thresholds) {
        const left = residuals.filter((_, index) => featureValues[index] <= threshold);
        const right = residuals.filter((_, index) => featureValues[index] > threshold);
        if (left.length < 20 || right.length < 20) continue;
        const leftValue = average(left);
        const rightValue = average(right);
        const error = residuals.reduce((sum, value, index) => sum + (value - (featureValues[index] <= threshold ? leftValue : rightValue)) ** 2, 0);
        if (!best || error < best.error) best = { feature, threshold, leftValue, rightValue, error };
      }
    }
    if (!best) break;
    stumps.push(best);
    rows.forEach((row, index) => {
      predictions[index] += learningRate * (row.features[best.feature] <= best.threshold ? best.leftValue : best.rightValue);
    });
  }
  return { initial, stumps, learningRate };
}

function boostedPredict(rows, model) {
  return rows.map((row) => row.baseline + model.initial + model.stumps.reduce((sum, stump) => (
    sum + model.learningRate * (row.features[stump.feature] <= stump.threshold ? stump.leftValue : stump.rightValue)
  ), 0));
}

function buildHistoricalRows(scheduleText, statsTexts) {
  const schedule = parseCsv(scheduleText);
  const contextByTeamWeek = new Map();
  for (const game of schedule) {
    const season = Number(game.season);
    const week = Number(game.week);
    if (season < 2023 || season > 2025 || game.game_type !== "REG") continue;
    for (const [teamRaw, restRaw] of [[game.away_team, game.away_rest], [game.home_team, game.home_rest]]) {
      contextByTeamWeek.set(`${season}:${week}:${canonicalTeam(teamRaw)}`, {
        roof: roofBucket(game.roof),
        artificial: artificialSurface(game.surface),
        rest: Number(restRaw),
        temperature: game.temp === "" ? null : Number(game.temp),
        wind: game.wind === "" ? null : Number(game.wind),
      });
    }
  }
  const allStats = statsTexts.flatMap((text) => parseCsv(text)).filter((row) => row.season_type === "REG" && POSITIONS.includes(row.position));
  const seasonPlayerValues = new Map();
  const seasonPositionValues = new Map();
  for (const row of allStats) {
    const points = Number(row.fantasy_points_ppr);
    if (!Number.isFinite(points) || points < -20 || points > 100) continue;
    const playerKey = `${row.season}:${row.player_id}`;
    const positionKey = `${row.season}:${row.position}`;
    seasonPlayerValues.set(playerKey, [...(seasonPlayerValues.get(playerKey) ?? []), points]);
    seasonPositionValues.set(positionKey, [...(seasonPositionValues.get(positionKey) ?? []), points]);
  }
  const rows = [];
  for (const row of allStats) {
    const season = Number(row.season);
    if (season < 2023 || season > 2025) continue;
    const points = Number(row.fantasy_points_ppr);
    const team = canonicalTeam(row.team || row.recent_team);
    const context = contextByTeamWeek.get(`${season}:${Number(row.week)}:${team}`);
    if (!context || !Number.isFinite(points)) continue;
    const priorPlayer = average(seasonPlayerValues.get(`${season - 1}:${row.player_id}`) ?? []);
    const priorPosition = average(seasonPositionValues.get(`${season - 1}:${row.position}`) ?? []);
    const baseline = priorPlayer ?? priorPosition;
    if (!Number.isFinite(baseline)) continue;
    const weatherRecorded = context.roof === "outdoor" && Number.isFinite(context.temperature) && Number.isFinite(context.wind);
    const temperature = weatherRecorded ? (context.temperature - 60) / 20 : 0;
    const wind = weatherRecorded ? (context.wind - 10) / 10 : 0;
    const position = row.position;
    rows.push({
      season,
      playerId: row.player_id,
      position,
      actual: points,
      baseline,
      residual: points - baseline,
      features: [
        1,
        Number(context.roof === "dome"),
        Number(context.artificial),
        Number(Number.isFinite(context.rest) && context.rest < 7),
        Number(weatherRecorded),
        temperature,
        wind,
        Number(position === "QB") * temperature,
        Number(position === "QB") * wind,
        Number(position === "RB") * temperature,
        Number(position === "RB") * wind,
        Number(position === "WR") * temperature,
        Number(position === "WR") * wind,
        Number(position === "TE") * temperature,
        Number(position === "TE") * wind,
      ],
    });
  }
  return rows;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    return value / 2 ** 32;
  };
}

function runMockDraft(players, scoring, slot, seed) {
  const league = { ...DEFAULT_LEAGUE, slot, scoring, roster: { ...DEFAULT_LEAGUE.roster } };
  const playersById = new Map(players.map((player) => [player.id, player]));
  const draftedIds = new Set();
  const myHistory = [];
  const random = seededRandom(seed);
  const totalPicks = league.teams * league.rounds;
  for (let pick = 1; pick <= totalPicks; pick += 1) {
    if (isManagerPick(pick, league)) {
      const ranked = rankPlayers({ players, draftedIds, myHistory, playersById, league, weights: DEFAULT_WEIGHTS, currentPick: pick });
      const required = ranked.filter((entry) => entry.requiredStarter);
      const pool = required.length ? required : ranked;
      const selection = pool.find((entry) => !isSevereAvailabilityRisk(entry.player)) ?? pool[0];
      if (!selection) break;
      draftedIds.add(selection.player.id);
      myHistory.push({ pick, playerId: selection.player.id, owner: "mine", adp: selection.market.adp });
      continue;
    }
    const available = players.filter((player) => !draftedIds.has(player.id) && activeMarket(player, scoring))
      .sort((left, right) => activeMarket(left, scoring).adp - activeMarket(right, scoring).adp);
    if (!available.length) break;
    const window = available.slice(0, Math.min(8, available.length));
    const selection = window[Math.floor((random() ** 1.8) * window.length)];
    draftedIds.add(selection.id);
  }
  const roster = buildRoster(myHistory, playersById, league);
  const mine = myHistory.map((entry) => playersById.get(entry.playerId)).filter(Boolean);
  const counts = Object.fromEntries(["QB", "RB", "WR", "TE", "D/ST", "K"].map((position) => [position, mine.filter((player) => player.position === position).length]));
  const byeCounts = new Map();
  for (const player of mine.filter((player) => !["D/ST", "K"].includes(player.position) && player.bye)) byeCounts.set(player.bye, (byeCounts.get(player.bye) ?? 0) + 1);
  return {
    complete: roster.filter((rosterSlot) => rosterSlot.type === "starter" && !rosterSlot.player).length === 0,
    thirdQb: counts.QB >= 3,
    thirdTe: counts.TE >= 3,
    duplicateDst: counts["D/ST"] >= 2,
    duplicateK: counts.K >= 2,
    severeRiskSelections: mine.filter(isSevereAvailabilityRisk).length,
    maximumByeCluster: Math.max(0, ...byeCounts.values()),
    averagePickValue: round(average(myHistory.map((entry) => entry.pick - entry.adp)) ?? 0, 2),
  };
}

function improvement(base, candidate, key) {
  return round(((base[key] - candidate[key]) / base[key]) * 100, 2);
}

function selectFeatures(rows, indexes) {
  return rows.map((row) => ({ ...row, features: indexes.map((index) => row.features[index]) }));
}

function tuneRidge(trainingRows, validationRows) {
  const candidates = [0.1, 1, 10, 100, 1_000].map((lambda) => {
    const coefficients = fitRidge(trainingRows, lambda);
    return { lambda, validation: metrics(validationRows.map((row) => row.actual), ridgePredict(validationRows, coefficients)) };
  });
  candidates.sort((left, right) => left.validation.mae - right.validation.mae || left.validation.rmse - right.validation.rmse);
  return candidates[0].lambda;
}

const [scheduleResponse, statsResponses, playersPayload, environmentPayload] = await Promise.all([
  fetchTextOnce(SCHEDULE_URL, { timeoutMs: 30_000, maxBytes: 15_000_000 }),
  Promise.all(STATS.map(({ url }) => fetchTextOnce(url, { timeoutMs: 60_000, maxBytes: 15_000_000 }))),
  fs.readFile(path.join(ROOT, "site", "data", "players.json"), "utf8").then(JSON.parse),
  fs.readFile(path.join(ROOT, "site", "data", "environment.json"), "utf8").then(JSON.parse),
]);

const historical = buildHistoricalRows(scheduleResponse.text, statsResponses.map((response) => response.text));
const train2023 = historical.filter((row) => row.season === 2023);
const validation2024 = historical.filter((row) => row.season === 2024);
const training = historical.filter((row) => row.season <= 2024);
const test = historical.filter((row) => row.season === 2025);
const validationActual = validation2024.map((row) => row.actual);

const structuralFeatureIndexes = [0, 1, 2, 3];
const structuralTrain2023 = selectFeatures(train2023, structuralFeatureIndexes);
const structuralValidation2024 = selectFeatures(validation2024, structuralFeatureIndexes);
const structuralTraining = selectFeatures(training, structuralFeatureIndexes);
const structuralTest = selectFeatures(test, structuralFeatureIndexes);
const selectedStructuralLambda = tuneRidge(structuralTrain2023, structuralValidation2024);
const structuralCoefficients = fitRidge(structuralTraining, selectedStructuralLambda);
const selectedLambda = tuneRidge(train2023, validation2024);
const ridgeCoefficients = fitRidge(training, selectedLambda);
const testActual = test.map((row) => row.actual);
const baselineMetrics = metrics(testActual, test.map((row) => row.baseline));
const structuralMetrics = metrics(testActual, ridgePredict(structuralTest, structuralCoefficients));
const ridgeMetrics = metrics(testActual, ridgePredict(test, ridgeCoefficients));

const boostCandidates = [5, 10, 20, 40].map((iterations) => {
  const model = fitBoostedStumps(train2023, iterations);
  return { iterations, validation: metrics(validationActual, boostedPredict(validation2024, model)) };
});
boostCandidates.sort((left, right) => left.validation.mae - right.validation.mae || left.validation.rmse - right.validation.rmse);
const selectedIterations = boostCandidates[0].iterations;
const boostModel = fitBoostedStumps(training, selectedIterations);
const boostMetrics = metrics(testActual, boostedPredict(test, boostModel));

const coefficientRows = FEATURE_NAMES.map((name, index) => ({ name, coefficient: ridgeCoefficients[index] }))
  .filter(({ name }) => name !== "intercept")
  .sort((left, right) => Math.abs(right.coefficient) - Math.abs(left.coefficient))
  .slice(0, 6);

const players = playersPayload.players.map((player) => ({
  ...player,
  environmentContext: environmentPayload.teams?.[player.team]?.summary ?? null,
}));
const mockResults = [];
for (const scoring of ["ppr", "half-ppr", "standard"]) {
  for (let slot = 1; slot <= 10; slot += 1) {
    for (let repetition = 0; repetition < 3; repetition += 1) mockResults.push({ scoring, slot, ...runMockDraft(players, scoring, slot, 20260826 + slot * 100 + repetition * 7 + scoring.length) });
  }
}
const mockCount = mockResults.length;
const count = (predicate) => mockResults.filter(predicate).length;
const ridgeLift = { mae: improvement(baselineMetrics, ridgeMetrics, "mae"), rmse: improvement(baselineMetrics, ridgeMetrics, "rmse") };
const structuralLift = { mae: improvement(baselineMetrics, structuralMetrics, "mae"), rmse: improvement(baselineMetrics, structuralMetrics, "rmse") };
const weatherIncrement = { mae: improvement(structuralMetrics, ridgeMetrics, "mae"), rmse: improvement(structuralMetrics, ridgeMetrics, "rmse") };
const boostLift = { mae: improvement(baselineMetrics, boostMetrics, "mae"), rmse: improvement(baselineMetrics, boostMetrics, "rmse") };
const environmentEarnedWeight = weatherIncrement.mae > 0 && weatherIncrement.rmse > 0 && ridgeLift.mae > 0 && boostLift.mae > 0;

const report = `# Environment and draft model lab

Generated ${new Date().toISOString()} from nflverse weekly player/schedule observations and the current published draft pool. This is a reproducible diagnostic, not a claim that weather causes fantasy outcomes.

## Walk-forward design

- Target: weekly full-PPR fantasy points for QB/RB/WR/TE.
- Baseline: each player's prior-season PPR/game, falling back to the prior-season position average.
- Training/selection: 2023 trains hyperparameters; 2024 selects them; 2023–24 refits; 2025 is untouched until final evaluation.
- Context features: roof, surface, rest, recorded outdoor temperature/wind, and position interactions. No future schedule field or 2025 target enters training.
- Precipitation is not fitted: nflverse does not supply historical game precipitation. NASA precipitation remains a clearly labeled venue climate normal with zero direct model weight.

## Held-out 2025 results

| Model | MAE | RMSE | MAE change vs baseline | RMSE change vs baseline |
| --- | ---: | ---: | ---: | ---: |
| Prior-season player baseline | ${baselineMetrics.mae} | ${baselineMetrics.rmse} | — | — |
| Ridge roof/surface/rest only (lambda ${selectedStructuralLambda}) | ${structuralMetrics.mae} | ${structuralMetrics.rmse} | ${structuralLift.mae}% | ${structuralLift.rmse}% |
| Ridge plus recorded temperature/wind (lambda ${selectedLambda}) | ${ridgeMetrics.mae} | ${ridgeMetrics.rmse} | ${ridgeLift.mae}% | ${ridgeLift.rmse}% |
| Boosted-stump residual model (${selectedIterations} rounds) | ${boostMetrics.mae} | ${boostMetrics.rmse} | ${boostLift.mae}% | ${boostLift.rmse}% |

${environmentEarnedWeight
    ? `Recorded temperature/wind improved the ridge ablation by ${weatherIncrement.mae}% MAE and ${weatherIncrement.rmse}% RMSE, while both context techniques beat the baseline. The app may retain a tiny, sample-guarded environment contribution.`
    : `Recorded temperature/wind did not improve both ridge ablation errors (MAE ${weatherIncrement.mae}%, RMSE ${weatherIncrement.rmse}%). Climate/outlook data stays primarily descriptive; only guarded player splits and the existing hard 5% combined context cap remain.`}

Largest ridge context coefficients after the player baseline (directional, not causal):

${coefficientRows.map(({ name, coefficient }) => `- ${name}: ${round(coefficient, 4)}`).join("\n")}

Coverage: ${historical.length.toLocaleString("en-US")} modeled weekly rows; ${training.length.toLocaleString("en-US")} train/refit rows; ${test.length.toLocaleString("en-US")} held-out 2025 rows.

## Randomized mock-draft stress test

${mockCount} seeded drafts covered every slot in 10-team, 16-round PPR, half-PPR, and standard leagues. Opponent picks sample around ADP instead of following one deterministic script.

| Invariant / outcome | Result |
| --- | ---: |
| Complete starting rosters | ${count((result) => result.complete)} / ${mockCount} |
| Drafts with a third QB | ${count((result) => result.thirdQb)} |
| Drafts with a third TE | ${count((result) => result.thirdTe)} |
| Drafts with duplicate D/ST | ${count((result) => result.duplicateDst)} |
| Drafts with duplicate K | ${count((result) => result.duplicateK)} |
| Severe-risk manager selections | ${mockResults.reduce((sum, result) => sum + result.severeRiskSelections, 0)} |
| Worst same-bye cluster | ${Math.max(...mockResults.map((result) => result.maximumByeCluster))} |
| Mean pick-minus-ADP value | ${round(average(mockResults.map((result) => result.averagePickValue)), 2)} picks |

## Guardrails retained

- NASA monthly temperature, precipitation, and wind are climate normals, never game forecasts.
- CPC categories are kept as issued; the model does not invent an exact temperature or rain chance from them.
- NWS/MET forecasts appear only inside their documented horizon and are not substituted when absent.
- Surface, weather, travel, rest, and personal splits share a maximum 5% score contribution.
- Market lines are sparse snapshots and remain low-weight context, not season projections or betting advice.
`;

await fs.writeFile(path.join(ROOT, "research", "MODEL_LAB.md"), report, "utf8");
console.log(`Model lab complete: ${historical.length} weekly rows, ${mockCount} mock drafts. Ridge MAE ${ridgeMetrics.mae}; boosted MAE ${boostMetrics.mae}; baseline ${baselineMetrics.mae}.`);
