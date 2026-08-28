import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = path.join(root, "site", "data");
const read = async (name) => JSON.parse(await fs.readFile(path.join(dataDir, name), "utf8"));
const [manifest, payload, research, environment] = await Promise.all([read("manifest.json"), read("players.json"), read("research.json"), read("environment.json")]);
const errors = [];
const warnings = [];
const players = payload.players;
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const validTimestamp = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
const validHttpsUrl = (value) => {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
};
const boundedNumber = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

if (manifest.schemaVersion !== 1) errors.push("manifest.schemaVersion must be 1");
if (payload.schemaVersion !== 1) errors.push("players.schemaVersion must be 1");
if (research.schemaVersion !== 1) errors.push("research.schemaVersion must be 1");
if (environment.schemaVersion !== 1) errors.push("environment.schemaVersion must be 1");
if (manifest.season !== 2026 || payload.season !== manifest.season || environment.season !== manifest.season) errors.push("bundle season must be 2026 and match across files");
if (!manifest.snapshotId || !manifest.generatedAt || Number.isNaN(new Date(manifest.generatedAt).getTime())) errors.push("manifest snapshot metadata is invalid");
if (payload.snapshotId !== manifest.snapshotId || research.snapshotId !== manifest.snapshotId || environment.snapshotId !== manifest.snapshotId) errors.push("bundle snapshot IDs do not match");
if (payload.generatedAt !== manifest.generatedAt || research.generatedAt !== manifest.generatedAt || environment.generatedAt !== manifest.generatedAt) errors.push("bundle generatedAt timestamps do not match");
if (!research.observedAt || Number.isNaN(Date.parse(research.observedAt)) || Date.parse(research.observedAt) > Date.parse(research.generatedAt)) errors.push("research observation timestamp is invalid");
const payloadForHash = structuredClone(payload);
const researchForHash = structuredClone(research);
const environmentForHash = structuredClone(environment);
delete payloadForHash.snapshotId;
delete researchForHash.snapshotId;
delete environmentForHash.snapshotId;
const digest = crypto.createHash("sha256")
  .update(`${JSON.stringify(payloadForHash, null, 2)}\n`)
  .update(`${JSON.stringify(researchForHash, null, 2)}\n`)
  .update(`${JSON.stringify(environmentForHash, null, 2)}\n`)
  .digest("hex")
  .slice(0, 10);
const expectedSnapshotId = `${manifest.generatedAt.slice(0, 10).replaceAll("-", "")}-${digest}`;
if (manifest.snapshotId !== expectedSnapshotId) errors.push("bundle snapshot digest does not match payloads");
if (!Array.isArray(manifest.sources) || manifest.sources.length < 3) errors.push("manifest needs at least three attributed sources");
if (new Set((manifest.sources ?? []).map((source) => source.id)).size !== (manifest.sources ?? []).length) errors.push("manifest source IDs are not unique");
const sourceIds = new Set((manifest.sources ?? []).map((source) => source.id));
if (manifest.files?.players !== "players.json" || manifest.files?.research !== "research.json" || manifest.files?.environment !== "environment.json") errors.push("manifest file map is invalid");
if (!boundedNumber(manifest.leaguePreset?.teams, 8, 16) || !boundedNumber(manifest.leaguePreset?.rounds, 10, 24) || manifest.leaguePreset?.scoring !== "ppr") errors.push("manifest league preset is invalid");
for (const key of ["markets", "playerStatus", "trends", "headlines", "history", "schedule"]) {
  if (!validTimestamp(manifest.observationTimes?.[key])) errors.push(`manifest observation time ${key} is missing or invalid`);
}
for (const [key, value] of Object.entries(manifest.observationTimes ?? {})) {
  if (Number.isNaN(Date.parse(value)) || Date.parse(value) > Date.parse(manifest.generatedAt)) errors.push(`manifest observation time ${key} is invalid`);
}
for (const [format, window] of Object.entries(manifest.marketWindows ?? {})) {
  if (!["ppr", "halfPpr", "standard"].includes(format) || !/^2026-\d{2}-\d{2}$/.test(window?.startDate ?? "") || !/^2026-\d{2}-\d{2}$/.test(window?.endDate ?? "") || !Number.isInteger(window?.totalDrafts) || window.totalDrafts < 1 || window.startDate > window.endDate) errors.push(`manifest market window ${format} is invalid`);
}
for (const [index, source] of (manifest.sources ?? []).entries()) {
  const label = `manifest.sources[${index}]`;
  if (!isObject(source) || typeof source.id !== "string" || !source.id || source.id.length > 160) errors.push(`${label}.id is invalid`);
  if (typeof source.name !== "string" || !source.name || source.name.length > 200) errors.push(`${label}.name is invalid`);
  if (typeof source.kind !== "string" || !source.kind) errors.push(`${label}.kind is invalid`);
  if (!validHttpsUrl(source.url)) errors.push(`${label}.url must use HTTPS`);
  if (!validTimestamp(source.retrievedAt) || Date.parse(source.retrievedAt) > Date.parse(manifest.generatedAt)) errors.push(`${label}.retrievedAt is invalid`);
  if (!Number.isInteger(source.records) || source.records < 0) errors.push(`${label}.records is invalid`);
  if (typeof source.attribution !== "string" || !source.attribution) errors.push(`${label}.attribution is missing`);
  if (typeof source.terms !== "string" || !source.terms) errors.push(`${label}.terms is missing`);
  if (!isObject(source.freshness) || !new Set(["fresh", "stale", "error"]).has(source.freshness.state) || !boundedNumber(source.freshness.maxAgeHours, 1, 8_760)) errors.push(`${label}.freshness is invalid`);
}
if (research.observedAt !== manifest.observationTimes?.headlines) errors.push("headline observation timestamps do not match");
for (const sourceId of research.trends?.sourceIds ?? []) if (!sourceIds.has(sourceId)) errors.push(`trend source is missing: ${sourceId}`);
const nflTeams = new Set(["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC", "LV", "LAC", "LAR", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SF", "SEA", "TB", "TEN", "WAS"]);
if (environment.climateBaseline?.period !== "2001-2020" || environment.climateBaseline?.sourceId !== "nasa-power-climatology" || !validTimestamp(environment.climateBaseline?.retrievedAt)) errors.push("environment climate baseline metadata is invalid");
if (!sourceIds.has(environment.climateBaseline?.sourceId)) errors.push("environment climate source is missing");
if (!Array.isArray(environment.outlookCoverage) || !isObject(environment.forecastCoverage) || !Array.isArray(environment.forecastCoverage.games)) errors.push("environment coverage metadata is invalid");
for (const [index, outlook] of (environment.outlookCoverage ?? []).entries()) {
  if (!sourceIds.has(outlook.sourceId) || !["6-10 day", "8-14 day", "week 3-4"].includes(outlook.horizon) || !["temperature", "precipitation"].includes(outlook.dimension)
    || !/^2026-\d{2}-\d{2}$/.test(outlook.issuedDate ?? "") || !/^2026-\d{2}-\d{2}$/.test(outlook.validStart ?? "") || !/^2026-\d{2}-\d{2}$/.test(outlook.validEnd ?? "")
    || outlook.validStart > outlook.validEnd || !Number.isInteger(outlook.featureCount) || outlook.featureCount < 1 || outlook.featureCount > 500) errors.push(`environment.outlookCoverage[${index}] is invalid`);
}
const environmentTeams = Object.entries(environment.teams ?? {});
if (environmentTeams.length !== 32 || environmentTeams.some(([team]) => !nflTeams.has(team))) errors.push("environment must contain all 32 NFL teams");
const environmentGameCounts = new Map();
for (const [team, teamPayload] of environmentTeams) {
  const summary = teamPayload?.summary;
  const games = teamPayload?.games;
  if (!isObject(summary) || summary.team !== team || summary.games !== 17 || !Array.isArray(games) || games.length !== 17) {
    errors.push(`environment team payload is invalid for ${team}`);
    continue;
  }
  for (const key of ["outdoorClimateGames", "coldClimateGames", "hotClimateGames", "wetClimateGames", "windyClimateGames", "outlookGames", "forecastGames", "marketGames"]) {
    if (!Number.isInteger(summary[key]) || summary[key] < 0 || summary[key] > 17) errors.push(`environment ${team} summary.${key} is invalid`);
  }
  for (const key of ["averageOutdoorClimateTemperatureF", "averageOutdoorClimatePrecipitationMmPerDay", "averageOutdoorClimateWindMph", "averageMarketImpliedPoints"]) {
    if (summary[key] !== null && !Number.isFinite(summary[key])) errors.push(`environment ${team} summary.${key} is invalid`);
  }
  if (!boundedNumber(summary.marketPulseScore, 40, 60) || !Array.isArray(summary.sourceIds) || summary.sourceIds.some((sourceId) => !sourceIds.has(sourceId))) errors.push(`environment ${team} summary metadata is invalid`);
  const weeks = new Set();
  for (const [index, game] of games.entries()) {
    const label = `environment.teams.${team}.games[${index}]`;
    if (typeof game.gameId !== "string" || !game.gameId || weeks.has(game.week) || !Number.isInteger(game.week) || game.week < 1 || game.week > 18) errors.push(`${label} identity/week is invalid`);
    weeks.add(game.week);
    environmentGameCounts.set(game.gameId, (environmentGameCounts.get(game.gameId) ?? 0) + 1);
    if (!/^202(?:6|7)-\d{2}-\d{2}$/.test(game.gameday ?? "") || !validTimestamp(game.kickoffUtc) || !nflTeams.has(game.opponent) || typeof game.home !== "boolean" || typeof game.stadiumId !== "string" || !game.stadiumId || typeof game.stadium !== "string" || !game.stadium) errors.push(`${label} schedule metadata is invalid`);
    if (!new Set(["US", "GB", "ES", "AU", "MX", "DE", "FR", "BR"]).has(game.countryCode) || !new Set(["dome", "outdoor", "unknown"]).has(game.roof) || !new Set(["grass", "hybrid", "artificial", "unknown"]).has(game.surface)) errors.push(`${label} venue metadata is invalid`);
    const normal = game.climateNormal;
    if (!isObject(normal) || normal.baselinePeriod !== "2001-2020" || !["JAN", "SEP", "OCT", "NOV", "DEC"].includes(normal.month)
      || !boundedNumber(normal.temperatureF, -50, 130) || !boundedNumber(normal.precipitationMmPerDay, 0, 30) || !boundedNumber(normal.windMph, 0, 50)
      || normal.sourceId !== "nasa-power-climatology" || !/not a game forecast/i.test(normal.label ?? "")) errors.push(`${label}.climateNormal is invalid`);
    for (const [dimension, outlook] of Object.entries(game.outlook ?? {})) {
      if (!["temperature", "precipitation"].includes(dimension) || !new Set(["above-normal", "below-normal", "near-normal", "equal-chances"]).has(outlook.category)
        || !boundedNumber(outlook.probability, 0, 100) || !sourceIds.has(outlook.sourceId) || !/not an exact forecast/i.test(outlook.label ?? "")
        || game.gameday < outlook.validStart || game.gameday > outlook.validEnd) errors.push(`${label}.outlook.${dimension} is invalid`);
    }
    if (game.forecast !== null) {
      if (!isObject(game.forecast) || game.forecast.kind !== "game-window-forecast" || !validTimestamp(game.forecast.issuedAt) || !validTimestamp(game.forecast.windowStart) || !sourceIds.has(game.forecast.sourceId)) errors.push(`${label}.forecast is invalid`);
      for (const key of ["temperatureF", "windMph", "precipitationProbability", "precipitationMm"]) if (game.forecast[key] !== null && game.forecast[key] !== undefined && !Number.isFinite(game.forecast[key])) errors.push(`${label}.forecast.${key} is invalid`);
    }
    if (game.market !== null && (!isObject(game.market) || !boundedNumber(game.market.totalPoints, 20, 80) || !boundedNumber(game.market.spread, -50, 50)
      || !boundedNumber(game.market.teamImpliedPoints, 0, 60) || !validTimestamp(game.market.observedAt) || game.market.sourceId !== "nflverse-schedules" || !/not a projection guarantee/i.test(game.market.label ?? ""))) errors.push(`${label}.market is invalid`);
  }
}
if ([...environmentGameCounts.values()].some((count) => count !== 2) || environmentGameCounts.size !== 272) errors.push("environment games must appear exactly once for each team in all 272 matchups");
if (!Array.isArray(players) || players.length < 180 || players.length > 500) errors.push(`player count ${players?.length ?? 0} is outside 180..500`);

const ids = new Set();
const positionSet = new Set(["QB", "RB", "WR", "TE", "D/ST", "K"]);
for (const [index, player] of (players ?? []).entries()) {
  const label = `players[${index}]`;
  if (typeof player.id !== "string" || !player.id || player.id.length > 128 || ids.has(player.id)) errors.push(`${label} has a missing/duplicate/invalid id`);
  ids.add(player.id);
  if (!player.name || typeof player.name !== "string" || player.name.length > 120) errors.push(`${label}.name is invalid`);
  if (!positionSet.has(player.position)) errors.push(`${label}.position is invalid: ${player.position}`);
  if (player.team !== null && (typeof player.team !== "string" || !/^[A-Z]{2,3}$/.test(player.team))) errors.push(`${label}.team is invalid`);
  if (player.bye !== null && (!Number.isInteger(player.bye) || player.bye < 1 || player.bye > 18)) errors.push(`${label}.bye is invalid`);
  if ((player.active !== null && typeof player.active !== "boolean") || (player.status !== null && typeof player.status !== "string") || (player.injuryStatus !== null && typeof player.injuryStatus !== "string")) errors.push(`${label} status fields are invalid`);
  if (!isObject(player.trends) || !Number.isInteger(player.trends.adds24h) || player.trends.adds24h < 0 || !Number.isInteger(player.trends.drops24h) || player.trends.drops24h < 0) errors.push(`${label}.trends is invalid`);
  if (!player.markets?.ppr || !Number.isFinite(player.markets.ppr.adp) || player.markets.ppr.adp <= 0) errors.push(`${label} has no valid PPR market`);
  for (const [format, market] of Object.entries(player.markets ?? {})) {
    if (!["ppr", "halfPpr", "standard"].includes(format)) errors.push(`${label}.markets.${format} is an unsupported format`);
    if (!boundedNumber(market.adp, 0.1, 500) || !Number.isInteger(market.rank) || market.rank < 1 || market.rank > 500 || !boundedNumber(market.stdev, 0, 250) || !Number.isInteger(market.timesDrafted) || market.timesDrafted < 0 || !Number.isInteger(market.tier) || market.tier < 1 || market.tier > 50 || !Number.isInteger(market.positionRank) || market.positionRank < 1) errors.push(`${label}.markets.${format} is invalid`);
    if (!isObject(market.sample) || !boundedNumber(market.sample.teams, 8, 16) || !Number.isInteger(market.sample.totalDrafts) || market.sample.totalDrafts < 1 || !/^2026-\d{2}-\d{2}$/.test(market.sample.startDate ?? "") || !/^2026-\d{2}-\d{2}$/.test(market.sample.endDate ?? "") || market.sample.startDate > market.sample.endDate) errors.push(`${label}.markets.${format}.sample is invalid`);
    if (!sourceIds.has(market.sourceId)) errors.push(`${label}.markets.${format} source is missing`);
  }
  const context = player.scheduleContext;
  if (context !== null && (!isObject(context) || context.season !== manifest.season || !Number.isInteger(context.games) || context.games < 0 || context.games > 18)) errors.push(`${label}.scheduleContext is invalid`);
  if (context) {
    for (const key of ["domeGames", "outdoorGames", "unknownRoofGames", "grassGames", "hybridGames", "turfGames", "unknownSurfaceGames", "shortWeeks", "internationalGames"]) if (!Number.isInteger(context[key]) || context[key] < 0 || context[key] > context.games) errors.push(`${label}.scheduleContext.${key} is invalid`);
    if (context.domeGames + context.outdoorGames + context.unknownRoofGames !== context.games) errors.push(`${label} roof buckets do not equal schedule games`);
    if (context.grassGames + context.hybridGames + context.turfGames + context.unknownSurfaceGames !== context.games) errors.push(`${label} surface buckets do not equal schedule games`);
    if (!Array.isArray(context.metadataWarnings) || !Array.isArray(context.venueOverridesApplied) || !boundedNumber(context.minimumRestDays, 0, 30) || !boundedNumber(context.averageRestDays, 0, 30)) errors.push(`${label}.scheduleContext metadata is invalid`);
    if (!sourceIds.has(context.sourceId)) errors.push(`${label} schedule source is missing`);
  }
  if (!player.statusObservedAt || Number.isNaN(Date.parse(player.statusObservedAt)) || Date.parse(player.statusObservedAt) > Date.parse(manifest.generatedAt)) errors.push(`${label}.statusObservedAt is invalid`);
  if (player.splits) {
    if (!sourceIds.has(player.splits.sourceId)) errors.push(`${label} historical source is missing`);
    if (player.splits.scheduleTeam !== player.team || player.splits.scheduleSeason !== manifest.season) errors.push(`${label} historical schedule fit is stale`);
    if (!Array.isArray(player.splits.seasons) || player.splits.seasons.some((season) => ![2023, 2024, 2025].includes(season)) || !Number.isInteger(player.splits.games) || player.splits.games < 6 || player.splits.games > 80 || !boundedNumber(player.splits.contextScore, 40, 60) || !boundedNumber(player.splits.confidence, 0, 0.65)) errors.push(`${label}.splits bounds are invalid`);
    for (const bucketName of ["dome", "outdoor", "artificial", "naturalOrHybrid", "cold", "mild", "windy", "calm"]) {
      const bucket = player.splits.buckets?.[bucketName];
      if (!bucket || !Number.isInteger(bucket.games) || bucket.games < 0 || bucket.games > player.splits.games || (bucket.pprPerGame !== null && !boundedNumber(bucket.pprPerGame, -20, 100))) errors.push(`${label}.splits.buckets.${bucketName} is invalid`);
    }
  }
}

const pprRanks = (players ?? []).map((player) => player.markets?.ppr?.rank).filter(Number.isFinite).sort((a, b) => a - b);
if (new Set(pprRanks).size !== pprRanks.length) errors.push("PPR market ranks are not unique");
if (typeof payload.attribution !== "string" || !payload.attribution) errors.push("players attribution is missing");
if (typeof research.notice !== "string" || !research.notice || research.notice.length > 1_000) errors.push("research notice is invalid");
if (!isObject(research.trends) || !boundedNumber(research.trends.windowHours, 1, 168) || !Array.isArray(research.trends.add) || !Array.isArray(research.trends.drop)) errors.push("research trends are invalid");
for (const [side, items] of [["add", research.trends?.add], ["drop", research.trends?.drop]]) {
  for (const [index, item] of (items ?? []).entries()) if (typeof item.sleeperId !== "string" || typeof item.name !== "string" || !positionSet.has(item.position) || !Number.isInteger(item.count) || item.count < 0) errors.push(`research.trends.${side}[${index}] is invalid`);
}
if (!Array.isArray(research.items)) errors.push("research.items must be an array");
const researchIds = new Set();
for (const [index, item] of (research.items ?? []).entries()) {
  try {
    const url = new URL(item.url);
    if (url.protocol !== "https:") errors.push(`research.items[${index}].url must use HTTPS`);
  } catch { errors.push(`research.items[${index}].url is invalid`); }
  if (typeof item.id !== "string" || !item.id || item.id.length > 160 || researchIds.has(item.id)) errors.push(`research.items[${index}].id is missing, invalid, or duplicate`);
  researchIds.add(item.id);
  if (!item.title || item.title.length > 300) errors.push(`research.items[${index}].title is invalid`);
  if (!sourceIds.has(item.sourceId)) errors.push(`research.items[${index}] source is missing`);
  // Syndicated publisher clocks can lead the runner slightly. Preserve the
  // source timestamp, but reject anything beyond a bounded one-hour skew.
  if (typeof item.source !== "string" || !item.source || typeof item.category !== "string" || !item.category || !validTimestamp(item.publishedAt) || Date.parse(item.publishedAt) > Date.parse(research.generatedAt) + 3_600_000) errors.push(`research.items[${index}] metadata is invalid`);
  if (item.content || item.body || (item.summary?.length ?? 0) > 500) errors.push(`research.items[${index}] contains excessive article content`);
}

if ((manifest.warnings ?? []).length) warnings.push(...manifest.warnings);
if (errors.length) {
  console.error(errors.map((error) => `ERROR: ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${players.length} players, ${research.items.length} research items, and ${manifest.sources.length} sources`);
  for (const warning of warnings) console.log(`WARNING: ${warning}`);
}
