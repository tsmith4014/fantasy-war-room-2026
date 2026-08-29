import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { parseCsv } from "./lib/csv.mjs";
import { fetchJsonOnce, fetchTextOnce, jsonText, readJsonIfPresent, retryOptional, withFileLock, writeAtomicBundle } from "./lib/data-io.mjs";
import {
  CPC_OUTLOOK_FEEDS,
  buildEnvironmentPayload,
  countryCodeForStadium,
  kickoffUtc,
  parseCpcOutlookKml,
  summarizeMetCompact,
  summarizeNwsHourly,
  validateVenueClimate,
} from "./lib/environment.mjs";
import { feedSourceId, fetchFeedSet } from "./lib/feed-refresh.mjs";
import { cleanUntrustedText } from "./lib/rss.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_DIR = path.join(ROOT, "site", "data");
const RUN_LOCK_PATH = path.join(DATA_DIR, ".refresh-data.lock");
const RESEARCH_DIR = path.join(ROOT, "research");
const OVERRIDE_PATH = path.join(ROOT, "docs", "venue-overrides.json");
const CLIMATE_PATH = path.join(ROOT, "docs", "venue-climate.json");
const SEASON = 2026;
const TEAMS = 10;
const MAX_AGE_HOURS = 36;

const FFC_FORMATS = Object.freeze([
  { key: "ppr", endpoint: "ppr", label: "PPR" },
  { key: "halfPpr", endpoint: "half-ppr", label: "Half-PPR" },
  { key: "standard", endpoint: "standard", label: "Standard" },
]);
const FFC_HELP_URL = "https://help.fantasyfootballcalculator.com/article/42-adp-rest-api";
const SLEEPER_DOCS_URL = "https://docs.sleeper.com/";
const SCHEDULE_URL = "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv";
const STATS_RELEASE_URL = "https://github.com/nflverse/nflverse-data/releases/tag/stats_player";
const STATS_URLS = Object.freeze([2023, 2024, 2025].map((season) => ({
  season,
  url: `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`,
})));
const INTERNATIONAL_URL = "https://operations.nfl.com/programs-initiatives/international-growth/nfl-international-games";

const TEAM_FEEDS = Object.freeze([
  ["ARI", "Arizona Cardinals", "azcardinals.com"],
  ["ATL", "Atlanta Falcons", "atlantafalcons.com"],
  ["BAL", "Baltimore Ravens", "baltimoreravens.com"],
  ["BUF", "Buffalo Bills", "buffalobills.com"],
  ["CAR", "Carolina Panthers", "panthers.com"],
  ["CHI", "Chicago Bears", "chicagobears.com"],
  ["CIN", "Cincinnati Bengals", "bengals.com"],
  ["CLE", "Cleveland Browns", "clevelandbrowns.com"],
  ["DAL", "Dallas Cowboys", "dallascowboys.com"],
  ["DEN", "Denver Broncos", "denverbroncos.com"],
  ["DET", "Detroit Lions", "detroitlions.com"],
  ["GB", "Green Bay Packers", "packers.com"],
  ["HOU", "Houston Texans", "houstontexans.com"],
  ["IND", "Indianapolis Colts", "colts.com"],
  ["JAX", "Jacksonville Jaguars", "jaguars.com"],
  ["KC", "Kansas City Chiefs", "chiefs.com"],
  ["LV", "Las Vegas Raiders", "raiders.com"],
  ["LAC", "Los Angeles Chargers", "chargers.com"],
  ["LAR", "Los Angeles Rams", "therams.com"],
  ["MIA", "Miami Dolphins", "miamidolphins.com"],
  ["MIN", "Minnesota Vikings", "vikings.com"],
  ["NE", "New England Patriots", "patriots.com"],
  ["NO", "New Orleans Saints", "neworleanssaints.com"],
  ["NYG", "New York Giants", "giants.com"],
  ["NYJ", "New York Jets", "newyorkjets.com"],
  ["PHI", "Philadelphia Eagles", "philadelphiaeagles.com"],
  ["PIT", "Pittsburgh Steelers", "steelers.com"],
  ["SF", "San Francisco 49ers", "49ers.com"],
  ["SEA", "Seattle Seahawks", "seahawks.com"],
  ["TB", "Tampa Bay Buccaneers", "buccaneers.com"],
  ["TEN", "Tennessee Titans", "tennesseetitans.com"],
  ["WAS", "Washington Commanders", "commanders.com"],
].map(([team, name, domain]) => ({ team, name, domain, url: `https://www.${domain}/rss/news` })));

const TEAM_CODES = new Set(TEAM_FEEDS.map(({ team }) => team));
const TEAM_ALIASES = Object.freeze({
  LA: "LAR", STL: "LAR", OAK: "LV", SD: "LAC", JAC: "JAX", WSH: "WAS",
});
const INTERNATIONAL_STADIUMS = new Set([
  "melbournecricketground", "mcg", "maracanastadium", "maracana",
  "tottenhamhotspurstadium", "wembleystadium", "stadedefrance",
  "fcbayernmunichstadium", "fcbayernmunicharena", "allianzarena",
  "bernabeu", "santiagobernabeu", "estadiobanorte", "estadioazteca",
]);
const POSITION_MAP = Object.freeze({ DEF: "D/ST", DST: "D/ST", "D/ST": "D/ST", PK: "K", K: "K", QB: "QB", RB: "RB", WR: "WR", TE: "TE" });

const argumentsSet = new Set(process.argv.slice(2));
for (const argument of argumentsSet) {
  if (!["--include-history", "--environment-only"].includes(argument)) throw new Error(`Unknown option: ${argument}`);
}
const includeHistory = argumentsSet.has("--include-history");
const environmentOnly = argumentsSet.has("--environment-only");
if (includeHistory && environmentOnly) throw new Error("--include-history and --environment-only cannot be combined");
const generatedAt = new Date().toISOString();

function canonicalTeam(value) {
  const team = cleanUntrustedText(value, 8).toUpperCase();
  return (TEAM_ALIASES[team] ?? team) || null;
}

function canonicalPosition(value) {
  return POSITION_MAP[cleanUntrustedText(value, 12).toUpperCase()] ?? null;
}

function canonicalVenue(value) {
  return cleanUntrustedText(value, 160).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function canonicalName(value) {
  return cleanUntrustedText(value, 120)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function numberInRange(value, minimum, maximum, label, { integer = false, nullable = false } = {}) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum || (integer && !Number.isInteger(number))) {
    throw new Error(`${label} is outside ${minimum}..${maximum}`);
  }
  return number;
}

function optionalText(value, maxLength = 120) {
  const text = cleanUntrustedText(value, maxLength);
  return text || null;
}

function round(value, places = 2) {
  const multiplier = 10 ** places;
  return Math.round((Number(value) + Number.EPSILON) * multiplier) / multiplier;
}

function computeSnapshotDigest(playersPayload, research, environment) {
  const playersForHash = structuredClone(playersPayload);
  const researchForHash = structuredClone(research);
  const environmentForHash = structuredClone(environment);
  delete playersForHash.snapshotId;
  delete researchForHash.snapshotId;
  delete environmentForHash.snapshotId;
  return crypto.createHash("sha256")
    .update(jsonText(playersForHash))
    .update(jsonText(researchForHash))
    .update(jsonText(environmentForHash))
    .digest("hex")
    .slice(0, 10);
}

function sourceRecord({ id, name, url, kind, retrievedAt = generatedAt, records, attribution, terms, refreshPolicy, details, freshnessState = "fresh", maxAgeHours = MAX_AGE_HOURS }) {
  const parsed = new URL(url);
  if (!new Set(["https:", "http:"]).has(parsed.protocol)) throw new Error(`Unsafe source URL for ${id}`);
  return {
    id,
    name,
    kind,
    url: parsed.toString(),
    retrievedAt,
    records,
    attribution,
    terms,
    freshness: { state: freshnessState, maxAgeHours },
    ...(refreshPolicy ? { refreshPolicy } : {}),
    ...(details ? { details } : {}),
  };
}

function parseFfcPayload(payload, format) {
  if (!payload || payload.status !== "Success" || !Array.isArray(payload.players)) throw new Error(`FFC ${format.label} payload is invalid`);
  if (Number(payload.meta?.teams) !== TEAMS) throw new Error(`FFC ${format.label} did not return a ${TEAMS}-team market`);
  if (payload.players.length < (format.key === "ppr" ? 180 : 100) || payload.players.length > 500) {
    throw new Error(`FFC ${format.label} returned an implausible ${payload.players.length} players`);
  }
  const seen = new Set();
  const players = payload.players.map((raw, index) => {
    const ffcId = String(numberInRange(raw.player_id, 1, 1_000_000, `FFC ${format.label} player_id`, { integer: true }));
    if (seen.has(ffcId)) throw new Error(`FFC ${format.label} duplicated player ${ffcId}`);
    seen.add(ffcId);
    const name = optionalText(raw.name, 120);
    const position = canonicalPosition(raw.position);
    const team = canonicalTeam(raw.team);
    if (!name || !position) throw new Error(`FFC ${format.label} player ${ffcId} has invalid identity data`);
    if (team && !TEAM_CODES.has(team)) throw new Error(`FFC ${format.label} player ${name} has unknown team ${team}`);
    return {
      ffcId,
      name,
      position,
      team,
      bye: numberInRange(raw.bye, 1, 18, `${name} bye`, { integer: true, nullable: true }),
      rank: index + 1,
      adp: numberInRange(raw.adp, 0.1, 500, `${name} ADP`),
      formatted: optionalText(raw.adp_formatted, 20),
      timesDrafted: numberInRange(raw.times_drafted, 0, 10_000_000, `${name} times drafted`, { integer: true }),
      high: numberInRange(raw.high, 1, 1_000, `${name} high`, { integer: true }),
      low: numberInRange(raw.low, 1, 1_000, `${name} low`, { integer: true }),
      stdev: numberInRange(raw.stdev, 0, 500, `${name} stdev`),
    };
  });
  players.sort((left, right) => left.adp - right.adp || left.name.localeCompare(right.name));
  players.forEach((player, index) => { player.rank = index + 1; });

  const start = String(payload.meta?.start_date ?? "");
  const end = String(payload.meta?.end_date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error(`FFC ${format.label} sample dates are invalid`);
  const meta = {
    scoring: optionalText(payload.meta.type, 40),
    teams: TEAMS,
    rounds: numberInRange(payload.meta.rounds, 1, 30, `FFC ${format.label} rounds`, { integer: true }),
    totalDrafts: numberInRange(payload.meta.total_drafts, 1, 100_000_000, `FFC ${format.label} total drafts`, { integer: true }),
    sampleStart: start,
    sampleEnd: end,
  };
  return { players, meta };
}

function validateSleeperPlayers(payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== "object" || Object.keys(payload).length < 1_000) {
    throw new Error("Sleeper all-player payload is invalid");
  }
  return payload;
}

function parseTrends(payload, label) {
  if (!Array.isArray(payload) || payload.length > 200) throw new Error(`Sleeper ${label} trends payload is invalid`);
  const seen = new Set();
  return payload.map((raw) => {
    const playerId = cleanUntrustedText(raw?.player_id, 40);
    const count = numberInRange(raw?.count, 0, 100_000_000, `Sleeper ${label} trend count`, { integer: true });
    if (!playerId || seen.has(playerId)) throw new Error(`Sleeper ${label} trend identity is invalid`);
    seen.add(playerId);
    return { playerId, count };
  });
}

function buildSleeperIndex(sleeperPlayers) {
  const byIdentity = new Map();
  const byId = new Map();
  for (const [rawId, raw] of Object.entries(sleeperPlayers)) {
    const id = cleanUntrustedText(rawId, 40);
    // Use Sleeper's primary position when it is draftable. Dual-role players
    // can list a defensive fantasy position first even when the primary field
    // is WR (for example Travis Hunter).
    const position = canonicalPosition(raw?.position)
      ?? raw?.fantasy_positions?.map(canonicalPosition).find(Boolean)
      ?? null;
    const team = canonicalTeam(raw?.team ?? raw?.team_abbr);
    const fullName = position === "D/ST" ? `${team ?? id} Defense` : optionalText(raw?.full_name ?? `${raw?.first_name ?? ""} ${raw?.last_name ?? ""}`, 120);
    if (!id || !position || !fullName) continue;
    const rawDepthOrder = Number(raw?.depth_chart_order);
    const player = {
      id,
      name: fullName,
      position,
      team: TEAM_CODES.has(team) ? team : null,
      active: raw?.active === true,
      status: optionalText(raw?.status, 60),
      injuryStatus: optionalText(raw?.injury_status, 60),
      injuryBodyPart: optionalText(raw?.injury_body_part, 80),
      depthChartOrder: Number.isInteger(rawDepthOrder) && rawDepthOrder >= 1 && rawDepthOrder <= 30 ? rawDepthOrder : null,
      gsisId: optionalText(raw?.gsis_id, 40),
    };
    byId.set(id, player);
    const identity = `${canonicalName(fullName)}|${position}`;
    const list = byIdentity.get(identity) ?? [];
    list.push(player);
    byIdentity.set(identity, list);
  }
  return { byIdentity, byId };
}

function matchSleeper(ffcPlayer, sleeperIndex) {
  if (ffcPlayer.position === "D/ST") return sleeperIndex.byId.get(ffcPlayer.team) ?? null;
  const candidates = sleeperIndex.byIdentity.get(`${canonicalName(ffcPlayer.name)}|${ffcPlayer.position}`) ?? [];
  if (candidates.length === 1) return candidates[0];
  const sameTeam = candidates.filter((candidate) => candidate.team === ffcPlayer.team);
  if (sameTeam.length === 1) return sameTeam[0];
  const active = candidates.filter((candidate) => candidate.active);
  return active.length === 1 ? active[0] : null;
}

function makeMarket(player, ffcMeta, formatKey) {
  return {
    rank: player.rank,
    adp: round(player.adp, 1),
    formatted: player.formatted,
    timesDrafted: player.timesDrafted,
    high: player.high,
    low: player.low,
    stdev: round(player.stdev, 1),
    sample: {
      teams: TEAMS,
      totalDrafts: ffcMeta.totalDrafts,
      startDate: ffcMeta.sampleStart,
      endDate: ffcMeta.sampleEnd,
    },
    sourceId: `ffc-adp-${formatKey.toLowerCase()}`,
  };
}

function assignMarketTiers(players, format) {
  const byPosition = new Map();
  for (const player of players) {
    if (!player.markets[format]) continue;
    const list = byPosition.get(player.position) ?? [];
    list.push(player);
    byPosition.set(player.position, list);
  }
  for (const [position, list] of byPosition) {
    list.sort((left, right) => left.markets[format].adp - right.markets[format].adp);
    const tierCapacity = ["RB", "WR"].includes(position) ? 8 : ["QB", "TE"].includes(position) ? 6 : 5;
    let tier = 1;
    let inTier = 0;
    list.forEach((player, index) => {
      const previous = list[index - 1];
      const gap = previous ? player.markets[format].adp - previous.markets[format].adp : 0;
      if (index > 0 && (gap >= 8 || inTier >= tierCapacity)) {
        tier += 1;
        inTier = 0;
      }
      player.markets[format].tier = tier;
      player.markets[format].positionRank = index + 1;
      inTier += 1;
    });
  }
}

function dateWithin(date, start, end) {
  const time = Date.parse(date);
  return Number.isFinite(time) && time >= Date.parse(start) && (!end || time <= Date.parse(end));
}

function validateOverrides(payload) {
  if (payload?.schemaVersion !== 1 || !Array.isArray(payload.overrides)) throw new Error("venue-overrides.json is invalid");
  const ids = new Set();
  for (const override of payload.overrides) {
    if (!override.id || ids.has(override.id) || !Array.isArray(override.stadiumNames) || !override.stadiumNames.length) throw new Error("Venue override identity is invalid");
    ids.add(override.id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(override.effectiveFrom) || (override.effectiveThrough && !/^\d{4}-\d{2}-\d{2}$/.test(override.effectiveThrough))) throw new Error(`Venue override ${override.id} has invalid dates`);
    if (!override.provenance?.url || !override.provenance?.publisher || !override.provenance?.reviewedAt) throw new Error(`Venue override ${override.id} lacks provenance`);
    new URL(override.provenance.url);
  }
  return payload;
}

function applyVenueOverride(game, overrides) {
  const stadium = canonicalVenue(game.stadium);
  const matching = overrides.filter((override) => override.stadiumNames.some((name) => canonicalVenue(name) === stadium)
    && dateWithin(game.gameday, override.effectiveFrom, override.effectiveThrough));
  if (matching.length > 1) throw new Error(`Multiple venue overrides match ${game.stadium} on ${game.gameday}`);
  if (!matching.length) return { ...game, appliedOverride: null, verifySurface: false };
  const override = matching[0];
  return {
    ...game,
    roof: override.set.roof ?? game.roof,
    surface: override.set.surface ?? game.surface,
    appliedOverride: override.id,
    verifySurface: override.verifySurface === true,
  };
}

function roofBucket(value) {
  const roof = cleanUntrustedText(value, 40).toLowerCase();
  if (["dome", "closed", "indoors", "indoor"].includes(roof)) return "dome";
  if (["outdoors", "outdoor", "open"].includes(roof)) return "outdoor";
  return "unknown";
}

function surfaceBucket(value) {
  const surface = cleanUntrustedText(value, 60).toLowerCase();
  if (surface === "hybrid") return "hybrid";
  if (surface.includes("grass") || surface.includes("natural")) return "grass";
  if (surface === "unknown" || !surface) return "unknown";
  if (/turf|artificial|synthetic|astro|matrix/.test(surface)) return "artificial";
  return "unknown";
}

function normalizeScheduleRows(csvText, venueConfig) {
  const rows = parseCsv(csvText);
  const required = ["game_id", "season", "game_type", "week", "gameday", "gametime", "away_team", "home_team", "away_rest", "home_rest", "roof", "surface", "stadium_id", "stadium", "spread_line", "total_line", "temp", "wind"];
  for (const header of required) if (!(header in rows[0])) throw new Error(`nflverse schedule is missing ${header}`);

  return rows.map((raw) => {
    const game = {
      gameId: cleanUntrustedText(raw.game_id, 40),
      season: numberInRange(raw.season, 1999, 2100, "schedule season", { integer: true }),
      gameType: cleanUntrustedText(raw.game_type, 8),
      week: numberInRange(raw.week, 1, 25, "schedule week", { integer: true }),
      gameday: cleanUntrustedText(raw.gameday, 20),
      gametime: cleanUntrustedText(raw.gametime, 8),
      awayTeam: canonicalTeam(raw.away_team),
      homeTeam: canonicalTeam(raw.home_team),
      awayRest: numberInRange(raw.away_rest, 0, 30, "away rest", { integer: true, nullable: true }),
      homeRest: numberInRange(raw.home_rest, 0, 30, "home rest", { integer: true, nullable: true }),
      roof: cleanUntrustedText(raw.roof, 40),
      surface: cleanUntrustedText(raw.surface, 60),
      stadiumId: cleanUntrustedText(raw.stadium_id, 20),
      stadium: cleanUntrustedText(raw.stadium, 160),
      spreadLine: numberInRange(raw.spread_line, -50, 50, "schedule spread line", { nullable: true }),
      totalLine: numberInRange(raw.total_line, 0, 100, "schedule total line", { nullable: true }),
      actualTemperatureF: numberInRange(raw.temp, -50, 130, "schedule temperature", { nullable: true }),
      actualWindMph: numberInRange(raw.wind, 0, 100, "schedule wind", { nullable: true }),
      marketObservedAt: generatedAt,
    };
    const targetSeasonGame = game.season === SEASON && game.gameType === "REG";
    if (!game.gameId || !/^\d{4}-\d{2}-\d{2}$/.test(game.gameday) || !game.stadium) throw new Error("nflverse schedule has invalid game metadata");
    if (targetSeasonGame && (!/^\d{2}:\d{2}$/.test(game.gametime) || !game.stadiumId)) throw new Error(`nflverse ${SEASON} schedule has incomplete game metadata for ${game.gameId}`);
    const corrected = applyVenueOverride(game, venueConfig.overrides);
    return {
      ...corrected,
      kickoffUtc: kickoffUtc(corrected.gameday, corrected.gametime),
      roofBucket: roofBucket(corrected.roof),
      surfaceBucket: surfaceBucket(corrected.surface),
      international: INTERNATIONAL_STADIUMS.has(canonicalVenue(corrected.stadium)),
    };
  });
}

function buildScheduleContexts(scheduleRows) {
  const games = scheduleRows.filter((game) => game.season === SEASON && game.gameType === "REG");
  if (games.length !== 272) throw new Error(`Expected 272 ${SEASON} regular-season games; received ${games.length}`);
  const buckets = new Map([...TEAM_CODES].map((team) => [team, {
    season: SEASON,
    games: 0,
    domeGames: 0,
    outdoorGames: 0,
    unknownRoofGames: 0,
    grassGames: 0,
    hybridGames: 0,
    turfGames: 0,
    unknownSurfaceGames: 0,
    shortWeeks: 0,
    internationalGames: 0,
    restDays: [],
    metadataWarnings: [],
    venueOverridesApplied: [],
    sourceId: "nflverse-schedules",
  }]));

  for (const game of games) {
    if (!TEAM_CODES.has(game.awayTeam) || !TEAM_CODES.has(game.homeTeam) || game.awayTeam === game.homeTeam) throw new Error(`Schedule game has invalid teams: ${game.awayTeam} at ${game.homeTeam}`);
    const international = INTERNATIONAL_STADIUMS.has(canonicalVenue(game.stadium));
    const roof = roofBucket(game.roof);
    const surface = surfaceBucket(game.surface);
    for (const [team, rest] of [[game.awayTeam, game.awayRest], [game.homeTeam, game.homeRest]]) {
      const context = buckets.get(team);
      context.games += 1;
      if (roof === "dome") context.domeGames += 1;
      else if (roof === "outdoor") context.outdoorGames += 1;
      else context.unknownRoofGames += 1;
      if (surface === "grass") context.grassGames += 1;
      else if (surface === "hybrid") context.hybridGames += 1;
      else if (surface === "artificial") context.turfGames += 1;
      else context.unknownSurfaceGames += 1;
      if (rest !== null) context.restDays.push(rest);
      if (rest !== null && rest < 7) context.shortWeeks += 1;
      if (international) context.internationalGames += 1;
      if (game.appliedOverride && !context.venueOverridesApplied.includes(game.appliedOverride)) context.venueOverridesApplied.push(game.appliedOverride);
      if (game.verifySurface) context.metadataWarnings.push(`${game.stadium} surface must be verified closer to kickoff`);
    }
  }

  for (const [team, context] of buckets) {
    if (context.games !== 17) throw new Error(`${team} has ${context.games} regular-season games; expected 17`);
    if (context.unknownRoofGames) context.metadataWarnings.push(`${context.unknownRoofGames} ${context.unknownRoofGames === 1 ? "game has" : "games have"} unknown/retractable roof state`);
    if (context.unknownSurfaceGames) context.metadataWarnings.push(`${context.unknownSurfaceGames} ${context.unknownSurfaceGames === 1 ? "game has" : "games have"} unverified surface metadata`);
    context.metadataWarnings = [...new Set(context.metadataWarnings)].sort();
    context.venueOverridesApplied.sort();
    context.minimumRestDays = Math.min(...context.restDays);
    context.averageRestDays = round(context.restDays.reduce((sum, value) => sum + value, 0) / context.restDays.length, 1);
    delete context.restDays;
  }
  return buckets;
}

function historyGameIndex(scheduleRows) {
  const index = new Map();
  for (const game of scheduleRows) {
    if (game.season < 2023 || game.season > 2025 || game.gameType !== "REG") continue;
    const context = {
      roof: roofBucket(game.roof),
      surface: surfaceBucket(game.surface),
      temperatureF: game.actualTemperatureF,
      windMph: game.actualWindMph,
    };
    index.set(`${game.season}:${game.week}:${game.awayTeam}`, context);
    index.set(`${game.season}:${game.week}:${game.homeTeam}`, context);
  }
  return index;
}

function refitHistoricalContext(split, scheduleContext, team, environmentContext = null) {
  const dome = split.buckets?.dome;
  const outdoor = split.buckets?.outdoor;
  const artificial = split.buckets?.artificial;
  const natural = split.buckets?.naturalOrHybrid;
  const roofUsable = (dome?.games ?? 0) >= 6 && (outdoor?.games ?? 0) >= 6;
  const surfaceUsable = (artificial?.games ?? 0) >= 6 && (natural?.games ?? 0) >= 6;
  const roofDelta = roofUsable ? dome.pprPerGame - outdoor.pprPerGame : 0;
  const surfaceDelta = surfaceUsable ? artificial.pprPerGame - natural.pprPerGame : 0;
  const cold = split.buckets?.cold;
  const mild = split.buckets?.mild;
  const windy = split.buckets?.windy;
  const calm = split.buckets?.calm;
  const coldUsable = (cold?.games ?? 0) >= 6 && (mild?.games ?? 0) >= 6;
  const windUsable = (windy?.games ?? 0) >= 6 && (calm?.games ?? 0) >= 6;
  const coldDelta = coldUsable ? cold.pprPerGame - mild.pprPerGame : 0;
  const windDelta = windUsable ? windy.pprPerGame - calm.pprPerGame : 0;
  const games = Number(split.games) || 0;
  const pairedMinimum = Math.max(
    roofUsable ? Math.min(dome.games, outdoor.games) : 0,
    surfaceUsable ? Math.min(artificial.games, natural.games) : 0,
    coldUsable ? Math.min(cold.games, mild.games) : 0,
    windUsable ? Math.min(windy.games, calm.games) : 0,
  );
  const confidence = (roofUsable || surfaceUsable || coldUsable || windUsable) ? Math.min(0.65, (pairedMinimum / 18) * Math.min(1, games / 40)) : 0;
  const domeExposure = scheduleContext?.games ? scheduleContext.domeGames / scheduleContext.games - 0.5 : 0;
  const artificialExposure = scheduleContext?.games ? scheduleContext.turfGames / scheduleContext.games - 0.5 : 0;
  const outdoorClimateGames = environmentContext?.outdoorClimateGames ?? 0;
  const coldExposure = outdoorClimateGames ? environmentContext.coldClimateGames / outdoorClimateGames : 0;
  const windExposure = outdoorClimateGames ? environmentContext.windyClimateGames / outdoorClimateGames : 0;
  const fit = roofDelta * domeExposure
    + surfaceDelta * artificialExposure
    + coldDelta * coldExposure * 0.5
    + windDelta * windExposure * 0.5;
  return {
    ...split,
    contextScore: round(Math.max(40, Math.min(60, 50 + fit * 0.75)), 1),
    confidence: round(confidence, 2),
    scheduleTeam: team ?? null,
    scheduleSeason: SEASON,
  };
}

function computeHistorySplits(statsDocuments, scheduleRows, players, environmentTeams = {}) {
  const documents = Array.isArray(statsDocuments) ? statsDocuments : [statsDocuments];
  const rows = documents.flatMap((document) => parseCsv(document));
  const required = ["player_id", "season", "season_type", "week", "position", "fantasy_points_ppr"];
  for (const header of required) if (!(header in rows[0])) throw new Error(`nflverse player stats are missing ${header}`);
  if (!("team" in rows[0]) && !("recent_team" in rows[0])) throw new Error("nflverse player stats are missing team identity");
  const availableSeasons = [...new Set(rows.map((row) => Number(row.season)).filter((season) => season >= 2023 && season <= 2025))].sort();
  if (availableSeasons.join(",") !== "2023,2024,2025") throw new Error(`Expected nflverse seasons 2023,2024,2025; received ${availableSeasons.join(",")}`);
  for (const player of players) {
    if (player.splits?.sourceId === "nflverse-player-stats") delete player.splits;
  }
  const wantedByGsis = new Map(players.map((player) => [player.sourceIds.gsis, player]).filter(([id]) => id));
  const identityCandidates = new Map();
  for (const player of players) {
    const key = `${canonicalName(player.name)}|${player.position}`;
    const candidates = identityCandidates.get(key) ?? [];
    candidates.push(player);
    identityCandidates.set(key, candidates);
  }
  const wantedByIdentity = new Map([...identityCandidates].filter(([, candidates]) => candidates.length === 1).map(([key, [player]]) => [key, player]));
  const gameIndex = historyGameIndex(scheduleRows);
  const samples = new Map();
  const add = (id, bucket, value, nflverseId, matchMethod) => {
    const playerSamples = samples.get(id) ?? { games: 0, dome: [], outdoor: [], artificial: [], natural: [], cold: [], mild: [], windy: [], calm: [], nflverseIds: new Set(), matchMethods: new Set() };
    playerSamples.games += 1;
    if (bucket.roof === "dome") playerSamples.dome.push(value);
    if (bucket.roof === "outdoor") playerSamples.outdoor.push(value);
    if (bucket.surface === "artificial") playerSamples.artificial.push(value);
    if (["grass", "hybrid"].includes(bucket.surface)) playerSamples.natural.push(value);
    if (bucket.roof === "outdoor" && Number.isFinite(bucket.temperatureF)) {
      if (bucket.temperatureF < 45) playerSamples.cold.push(value);
      else playerSamples.mild.push(value);
    }
    if (bucket.roof === "outdoor" && Number.isFinite(bucket.windMph)) {
      if (bucket.windMph >= 15) playerSamples.windy.push(value);
      else playerSamples.calm.push(value);
    }
    playerSamples.nflverseIds.add(nflverseId);
    playerSamples.matchMethods.add(matchMethod);
    samples.set(id, playerSamples);
  };

  for (const row of rows) {
    if (row.season_type !== "REG") continue;
    let player = wantedByGsis.get(row.player_id);
    let matchMethod = "gsis";
    if (!player) {
      const statsPosition = canonicalPosition(row.position);
      const statsName = optionalText(row.player_display_name || row.player_name, 120);
      if (statsPosition && statsName) player = wantedByIdentity.get(`${canonicalName(statsName)}|${statsPosition}`);
      matchMethod = "exact-name-position";
    }
    if (!player) continue;
    const season = Number(row.season);
    const week = Number(row.week);
    if (!Number.isInteger(season) || season < 2023 || season > 2025 || !Number.isInteger(week)) continue;
    const team = canonicalTeam(row.team || row.recent_team);
    const context = gameIndex.get(`${season}:${week}:${team}`);
    const points = Number(row.fantasy_points_ppr);
    if (!context || !Number.isFinite(points) || points < -20 || points > 100) continue;
    add(player.id, context, points, row.player_id, matchMethod);
  }

  const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  for (const player of players) {
    const sample = samples.get(player.id);
    if (!sample || sample.games < 6) continue;
    const domeAverage = sample.dome.length ? average(sample.dome) : null;
    const outdoorAverage = sample.outdoor.length ? average(sample.outdoor) : null;
    const artificialAverage = sample.artificial.length ? average(sample.artificial) : null;
    const naturalAverage = sample.natural.length ? average(sample.natural) : null;
    const coldAverage = sample.cold.length ? average(sample.cold) : null;
    const mildAverage = sample.mild.length ? average(sample.mild) : null;
    const windyAverage = sample.windy.length ? average(sample.windy) : null;
    const calmAverage = sample.calm.length ? average(sample.calm) : null;
    player.splits = refitHistoricalContext({
      seasons: availableSeasons,
      games: sample.games,
      guardrail: "At least six games are required on both sides of a roof, surface, temperature, or wind comparison; confidence is capped at 65%.",
      identityMatch: [...sample.matchMethods].sort().join("+"),
      nflversePlayerIds: [...sample.nflverseIds].sort(),
      buckets: {
        dome: { games: sample.dome.length, pprPerGame: domeAverage === null ? null : round(domeAverage, 2) },
        outdoor: { games: sample.outdoor.length, pprPerGame: outdoorAverage === null ? null : round(outdoorAverage, 2) },
        artificial: { games: sample.artificial.length, pprPerGame: artificialAverage === null ? null : round(artificialAverage, 2) },
        naturalOrHybrid: { games: sample.natural.length, pprPerGame: naturalAverage === null ? null : round(naturalAverage, 2) },
        cold: { games: sample.cold.length, pprPerGame: coldAverage === null ? null : round(coldAverage, 2), definition: "Outdoor game with recorded temperature below 45°F" },
        mild: { games: sample.mild.length, pprPerGame: mildAverage === null ? null : round(mildAverage, 2), definition: "Outdoor game with recorded temperature at least 45°F" },
        windy: { games: sample.windy.length, pprPerGame: windyAverage === null ? null : round(windyAverage, 2), definition: "Outdoor game with recorded wind at least 15 mph" },
        calm: { games: sample.calm.length, pprPerGame: calmAverage === null ? null : round(calmAverage, 2), definition: "Outdoor game with recorded wind below 15 mph" },
      },
      sourceId: "nflverse-player-stats",
    }, player.scheduleContext, player.team, environmentTeams[player.team]?.summary ?? null);
  }
  return {
    seasons: availableSeasons,
    rowsBySeason: Object.fromEntries(availableSeasons.map((season) => [season, rows.filter((row) => Number(row.season) === season && row.season_type === "REG").length])),
  };
}

function makeHistorySourceRecords(historySummary, historyMetadata) {
  return [
    sourceRecord({
      id: "nflverse-player-stats",
      name: "nflverse weekly player stats, 2023–25",
      url: STATS_RELEASE_URL,
      kind: "historical-observation",
      records: historySummary.playersWithSplits,
      attribution: "nflverse data",
      terms: "Creative Commons Attribution 4.0; observational splits are sample-guarded and non-causal",
      details: {
        seasons: historyMetadata.seasons,
        playersWithGuardedComparisons: historySummary.playersWithGuardedComparisons,
        seasonSourceIds: historyMetadata.seasons.map((season) => `nflverse-player-stats-${season}`),
      },
      maxAgeHours: 8760,
    }),
    ...STATS_URLS.map(({ season, url }) => sourceRecord({
      id: `nflverse-player-stats-${season}`,
      name: `nflverse ${season} weekly player stats`,
      url,
      kind: "historical-observation-season",
      records: historyMetadata.rowsBySeason[season],
      attribution: "nflverse data",
      terms: "Creative Commons Attribution 4.0; regular-season weekly observations",
      details: { season },
      maxAgeHours: 8760,
    })),
  ];
}

async function fetchFeeds(priorResearch) {
  const feeds = [...TEAM_FEEDS, { team: null, name: "ESPN NFL", domain: "espn.com", url: "https://www.espn.com/espn/rss/nfl/news", espn: true }];
  return fetchFeedSet(feeds, {
    priorResearch,
    observedAt: generatedAt,
    fetchText: (url) => retryOptional(() => fetchTextOnce(url, {
        timeoutMs: 20_000,
        maxBytes: 2_000_000,
        headers: { accept: "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5" },
      }), { attempts: 2, delayMs: 300 }),
  });
}

function safeSourceError(error) {
  return cleanUntrustedText(error instanceof Error ? error.message : String(error), 360) || "Unknown source error";
}

async function fetchCpcOutlooks() {
  const results = await Promise.all(CPC_OUTLOOK_FEEDS.map(async (feed) => {
    try {
      const response = await retryOptional(() => fetchTextOnce(feed.url, {
          timeoutMs: 30_000,
          maxBytes: 25_000_000,
          headers: { accept: "application/vnd.google-earth.kml+xml,application/xml,text/xml;q=0.9,*/*;q=0.5" },
        }), { attempts: 3, delayMs: 400 });
      return { feed, outlook: parseCpcOutlookKml(response.text, feed), error: null };
    } catch (error) {
      return { feed, outlook: null, error: safeSourceError(error) };
    }
  }));
  return { results, outlooks: results.flatMap((result) => result.outlook ? [result.outlook] : []), failures: results.filter((result) => result.error) };
}

function futureForecastTargets(scheduleRows, climateConfig) {
  const now = Date.parse(generatedAt);
  const venues = new Map(climateConfig.venues.map((venue) => [venue.stadiumId, venue]));
  return scheduleRows.filter((game) => game.season === SEASON && game.gameType === "REG" && game.roofBucket !== "dome")
    .flatMap((game) => {
      const kickoff = Date.parse(game.kickoffUtc);
      const venue = venues.get(game.stadiumId);
      if (!venue || !Number.isFinite(kickoff) || kickoff <= now) return [];
      const provider = countryCodeForStadium(game.stadiumId) === "US" ? "nws" : "met";
      const horizonDays = provider === "nws" ? 7 : 9;
      return kickoff - now <= horizonDays * 24 * 60 * 60 * 1_000 ? [{ game, venue, provider }] : [];
    });
}

async function fetchGameForecasts(scheduleRows, climateConfig) {
  const targets = futureForecastTargets(scheduleRows, climateConfig);
  const attempts = await Promise.all(targets.map(async ({ game, venue, provider }) => {
    try {
      if (provider === "nws") {
        const pointUrl = `https://api.weather.gov/points/${venue.latitude.toFixed(4)},${venue.longitude.toFixed(4)}`;
        const point = await fetchJsonOnce(pointUrl, {
          timeoutMs: 20_000,
          maxBytes: 1_000_000,
          headers: { "user-agent": "FantasyWarRoom2026/1.0 (github.com/tsmith4014/fantasy-war-room-2026; personal research)" },
        });
        const hourlyUrl = point.value?.properties?.forecastHourly;
        if (!hourlyUrl || new URL(hourlyUrl).hostname !== "api.weather.gov") throw new Error("NWS point response is missing a safe hourly forecast URL");
        const hourly = await fetchJsonOnce(hourlyUrl, {
          timeoutMs: 20_000,
          maxBytes: 3_000_000,
          headers: { "user-agent": "FantasyWarRoom2026/1.0 (github.com/tsmith4014/fantasy-war-room-2026; personal research)" },
        });
        const forecast = summarizeNwsHourly(hourly.value, { gameId: game.gameId, kickoff: game.kickoffUtc });
        if (!forecast) throw new Error("NWS hourly forecast does not yet cover the game window");
        return { gameId: game.gameId, provider, forecast, error: null };
      }
      const url = new URL("https://api.met.no/weatherapi/locationforecast/2.0/compact");
      url.searchParams.set("lat", venue.latitude.toFixed(4));
      url.searchParams.set("lon", venue.longitude.toFixed(4));
      const response = await fetchJsonOnce(url.toString(), {
        timeoutMs: 20_000,
        maxBytes: 5_000_000,
        headers: { "user-agent": "FantasyWarRoom2026/1.0 github.com/tsmith4014/fantasy-war-room-2026" },
      });
      const forecast = summarizeMetCompact(response.value, { gameId: game.gameId, kickoff: game.kickoffUtc });
      if (!forecast) throw new Error("MET Norway forecast does not yet cover the game window");
      return { gameId: game.gameId, provider, forecast, error: null };
    } catch (error) {
      return { gameId: game.gameId, provider, forecast: null, error: safeSourceError(error) };
    }
  }));
  return {
    targets,
    attempts,
    failures: attempts.filter((attempt) => attempt.error),
    forecastsByGame: new Map(attempts.flatMap((attempt) => attempt.forecast ? [[attempt.gameId, attempt.forecast]] : [])),
  };
}

function makeEnvironmentSourceRecords({ scheduleRows, climateConfig, cpcSet, forecastSet }) {
  const records = [
    sourceRecord({
      id: "nflverse-schedules",
      name: "nflverse schedules",
      url: SCHEDULE_URL,
      kind: "schedule-observation",
      records: scheduleRows.filter((game) => game.season === SEASON && game.gameType === "REG").length,
      attribution: "nflverse data",
      terms: "Creative Commons Attribution 4.0; venue overrides are separately attributed; line snapshots are market observations, not projections",
    }),
    sourceRecord({
      id: "nasa-power-climatology",
      name: "NASA POWER monthly climatology",
      url: climateConfig.source.documentationUrl,
      kind: "climate-normal",
      retrievedAt: climateConfig.retrievedAt,
      records: climateConfig.venues.length,
      attribution: climateConfig.source.attribution,
      terms: `NASA POWER data with required acknowledgement; referencing guide: ${climateConfig.source.referencingUrl}`,
      details: { baselinePeriod: climateConfig.baselinePeriod, parameters: Object.keys(climateConfig.parameters), note: climateConfig.source.note },
      maxAgeHours: 8_760,
    }),
    sourceRecord({
      id: "venue-coordinate-seed",
      name: "nflverse community stadium coordinate seed",
      url: climateConfig.coordinateSources["nflverse-community-stadiums"].url,
      kind: "venue-coordinate-reference",
      retrievedAt: climateConfig.retrievedAt,
      records: climateConfig.venues.length,
      attribution: "nflverse community stadium-data discussion; international additions manually reviewed",
      terms: "Factual coordinates used only to query source-attributed venue climate and forecast services",
      details: { note: climateConfig.coordinateSources["nflverse-community-stadiums"].note },
      maxAgeHours: 8_760,
    }),
  ];
  for (const result of cpcSet.results) {
    // A failed optional attempt contributed no observation, so it is logged
    // but not published as an attributed source. This keeps provenance honest
    // and prevents a transient DNS miss from becoming persistent app state.
    if (!result.outlook) continue;
    records.push(sourceRecord({
      id: result.feed.id,
      name: `NOAA Climate Prediction Center ${result.feed.horizon} ${result.feed.dimension} outlook`,
      url: result.feed.url,
      kind: "extended-climate-outlook",
      records: result.outlook.features.length,
      attribution: "NOAA Climate Prediction Center",
      terms: "U.S. government climate outlook; category and probability are preserved without converting them to exact weather",
      details: { issuedDate: result.outlook.issuedDate, validStart: result.outlook.validStart, validEnd: result.outlook.validEnd },
      maxAgeHours: 72,
    }));
  }
  for (const provider of ["nws", "met"]) {
    const attempts = forecastSet.attempts.filter((attempt) => attempt.provider === provider);
    if (!attempts.length) continue;
    const failures = attempts.filter((attempt) => attempt.error);
    const successfulAttempts = attempts.filter((attempt) => attempt.forecast);
    if (!successfulAttempts.length) continue;
    records.push(sourceRecord({
      id: provider === "nws" ? "nws-forecast" : "met-norway-forecast",
      name: provider === "nws" ? "National Weather Service hourly forecast" : "MET Norway Locationforecast",
      url: provider === "nws" ? "https://www.weather.gov/documentation/services-web-api" : "https://api.met.no/weatherapi/locationforecast/2.0/documentation",
      kind: "game-window-weather-forecast",
      records: successfulAttempts.length,
      attribution: provider === "nws" ? "NOAA National Weather Service" : "MET Norway",
      terms: provider === "nws" ? "U.S. government open data; identifying User-Agent and bounded caching used" : "Free worldwide forecast under MET Norway terms; identifying User-Agent and bounded caching used",
      details: {
        games: successfulAttempts.map((attempt) => attempt.gameId),
        ...(failures.length ? { unavailableGameCount: failures.length } : {}),
      },
      maxAgeHours: 12,
    }));
  }
  return records;
}

function stableHeadlineId(url) {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function headlinePayload(feedResults) {
  const seen = new Set();
  const items = [];
  for (const { feed, headlines } of feedResults) {
    for (const headline of headlines) {
      if (seen.has(headline.url)) continue;
      seen.add(headline.url);
      items.push({
        id: `headline:${stableHeadlineId(headline.url)}`,
        title: headline.title,
        url: headline.url,
        publishedAt: headline.publishedAt,
        source: feed.name,
        sourceId: feed.espn ? "rss-espn" : `rss-team-${feed.team.toLowerCase()}`,
        category: "headline",
        ...(feed.team ? { team: feed.team } : {}),
      });
    }
  }
  return items.sort((left, right) => right.publishedAt.localeCompare(left.publishedAt) || left.title.localeCompare(right.title));
}

function makeFeedSourceRecords(feedResults, priorManifest) {
  const priorSourcesById = new Map((priorManifest?.sources ?? []).map((source) => [source.id, source]));
  return feedResults.flatMap(({ feed, headlines, finalUrl, contentType, ignoredFutureItems = 0, usedFallback, error }) => {
    // Do not advertise a source that contributed no observation. The failed
    // attempt remains visible in workflow logs, while published provenance
    // stays limited to data that actually ships in the static bundle.
    if (error && headlines.length === 0) return [];
    const sourceId = feedSourceId(feed);
    const priorSource = priorSourcesById.get(sourceId);
    const priorSuccessfulAt = ["error", "stale"].includes(priorSource?.freshness?.state)
      ? priorSource?.details?.lastSuccessfulAt ?? null
      : priorSource?.retrievedAt ?? null;
    return [sourceRecord({
      id: sourceId,
      name: `${feed.name} RSS`,
      url: feed.url,
      kind: feed.espn ? "publisher-rss" : "official-club-rss",
      retrievedAt: error ? priorSuccessfulAt ?? generatedAt : generatedAt,
      records: headlines.length,
      attribution: feed.name,
      terms: "Linked feed titles, dates, and URLs only; no article bodies or automated ranking changes",
      freshnessState: error ? "stale" : "fresh",
      details: error
        ? {
          lastAttemptAt: generatedAt,
          lastSuccessfulAt: priorSuccessfulAt,
          usedLastKnownGood: usedFallback && headlines.length > 0,
          error,
        }
        : {
          finalUrl,
          contentType,
          ...(ignoredFutureItems ? { ignoredFutureItems } : {}),
        },
    })];
  });
}

function mapTrends(trends, sleeperIndex) {
  return trends.flatMap(({ playerId, count }) => {
    const player = sleeperIndex.byId.get(playerId);
    const position = canonicalPosition(player?.position);
    if (!position) return [];
    return [{
      sleeperId: playerId,
      name: player?.name ?? "Unknown player",
      team: player?.team ?? null,
      position,
      count,
    }];
  });
}

function markdownEscape(value) {
  return String(value).replace(/[\\`*_{}[\]()#+.!|<>-]/g, "\\$&").replace(/\r?\n/g, " ").slice(0, 500);
}

function safeMarkdownLink(title, url) {
  const parsed = new URL(url);
  if (!new Set(["https:", "http:"]).has(parsed.protocol)) throw new Error("Unsafe Markdown URL");
  return `[${markdownEscape(title)}](${parsed.toString().replace(/[()]/g, (character) => `%${character.charCodeAt(0).toString(16)}`)})`;
}

function buildContextMarkdown({ players, priorPlayers, research, manifest, environment, identityWarnings, historySummary = null }) {
  const priorById = new Map((priorPlayers ?? []).map((player) => [player.id, player]));
  const statusChanges = [];
  const movers = [];
  for (const player of players) {
    const prior = priorById.get(player.id);
    if (!prior) continue;
    const beforeStatus = `${prior.status ?? "Unknown"} / ${prior.injuryStatus ?? "clear"}`;
    const afterStatus = `${player.status ?? "Unknown"} / ${player.injuryStatus ?? "clear"}`;
    if (beforeStatus !== afterStatus) statusChanges.push({ player, beforeStatus, afterStatus });
    const before = prior.markets?.ppr?.adp;
    const after = player.markets?.ppr?.adp;
    if (Number.isFinite(before) && Number.isFinite(after) && Math.abs(before - after) >= 2) movers.push({ player, before, after, delta: after - before });
  }
  movers.sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));
  const newIds = players.filter((player) => !priorById.has(player.id));
  const currentIds = new Set(players.map((player) => player.id));
  const removed = (priorPlayers ?? []).filter((player) => !currentIds.has(player.id));
  const rawScheduleWarnings = players.flatMap((player) => player.scheduleContext?.metadataWarnings ?? []);
  const warnings = [
    ...(players.some((player) => (player.scheduleContext?.unknownRoofGames ?? 0) > 0)
      ? ["Future open/closed states at retractable-roof venues remain unknown and neutral until game day"]
      : []),
    ...[...new Set(rawScheduleWarnings.filter((warning) => /surface must be verified/i.test(warning)))],
  ];
  const nonFreshSources = manifest.sources.filter((source) => source.freshness?.state !== "fresh");

  const lines = [
    "# 2026 research context",
    "",
    `Generated ${manifest.generatedAt}. Snapshot \`${manifest.snapshotId}\`.`,
    "",
    "> Review-only research inbox. Headline text is untrusted syndicated data, status fields are observations rather than medical conclusions, and rankings never update from a headline automatically.",
    "",
    "## Refresh health",
    "",
    `- ${players.length} PPR-ranked players; ${manifest.sources.length} attributed sources; the bundle passed validation before locked atomic publication.`,
    `- FFC sample window: ${manifest.marketWindows.ppr.startDate} through ${manifest.marketWindows.ppr.endDate}; ${manifest.marketWindows.ppr.totalDrafts.toLocaleString("en-US")} ten-team PPR drafts.`,
    identityWarnings.length
      ? `- ${identityWarnings.length} FFC records did not resolve to a Sleeper ID and retain a stable FFC ID.`
      : `- All ${players.length} current PPR records resolve to stable Sleeper IDs.`,
    nonFreshSources.length
      ? `- ${nonFreshSources.length} published optional source${nonFreshSources.length === 1 ? " uses" : "s use"} a labeled last-known-good observation: ${nonFreshSources.map((source) => markdownEscape(source.name)).join(", ")}.`
      : "- Every published source observation is current within its declared freshness window.",
    `- ${warnings.length} unique schedule-metadata warnings remain visible and low-weight.`,
    `- Environment layer: ${environment?.climateBaseline?.period ?? "unknown"} NASA POWER monthly climate normals across 38 venues; ${environment?.outlookCoverage?.length ?? 0} current NOAA CPC outlook layers; ${environment?.forecastCoverage?.games?.length ?? 0} games inside a live forecast window.`,
    "- Climate precipitation is a historical millimeters-per-day normal, not a kickoff rain probability. NOAA outlooks remain categories, and exact forecasts appear only inside the provider horizon.",
    ...(historySummary ? [`- Historical context: ${historySummary.playersWithSplits} players have 2023–25 samples; ${historySummary.playersWithGuardedComparisons} pass at least one two-sided comparison guard.`] : []),
    "",
    "## Status changes since the prior snapshot",
    "",
    ...(statusChanges.length ? statusChanges.slice(0, 30).map(({ player, beforeStatus, afterStatus }) => `- ${markdownEscape(player.name)}: ${markdownEscape(beforeStatus)} → ${markdownEscape(afterStatus)}.`) : ["- Initial snapshot or no observed Sleeper status changes."]),
    "",
    "## PPR ADP movers since the prior snapshot",
    "",
    ...(movers.length ? movers.slice(0, 20).map(({ player, before, after, delta }) => `- ${markdownEscape(player.name)}: ${before.toFixed(1)} → ${after.toFixed(1)} (${delta > 0 ? "+" : ""}${delta.toFixed(1)}; a lower ADP means earlier selection).`) : ["- Initial snapshot or no moves of at least two picks."]),
    "",
    "## Player-pool changes",
    "",
    `- Added: ${newIds.length ? newIds.slice(0, 30).map((player) => markdownEscape(player.name)).join(", ") : "none"}.`,
    `- Removed: ${removed.length ? removed.slice(0, 30).map((player) => markdownEscape(player.name)).join(", ") : "none"}.`,
    "",
    "## Sleeper 24-hour trends",
    "",
    ...research.trends.add.slice(0, 10).map((trend) => `- Add: ${markdownEscape(trend.name)} (${trend.count.toLocaleString("en-US")} leagues).`),
    ...research.trends.drop.slice(0, 10).map((trend) => `- Drop: ${markdownEscape(trend.name)} (${trend.count.toLocaleString("en-US")} leagues).`),
    "",
    "## Linked headline inbox",
    "",
    ...research.items.slice(0, 30).map((item) => `- ${safeMarkdownLink(item.title, item.url)} — ${markdownEscape(item.source)}, ${item.publishedAt.slice(0, 10)}.`),
    "",
    "## Venue review queue",
    "",
    ...(warnings.length ? warnings.map((warning) => `- ${markdownEscape(warning)}.`) : ["- No venue metadata warnings."]),
    "",
    ...(historySummary ? [
      "## Historical split coverage",
      "",
      `- ${historySummary.playersWithSplits} of ${players.length} draft-pool players have matched 2023–25 nflverse weekly samples.`,
      `- ${historySummary.playersWithGuardedComparisons} players have at least six games on both sides of a roof, surface, temperature, or wind comparison; confidence remains capped at 65%.`,
      `- Coverage by position: ${Object.entries(historySummary.byPosition).map(([position, count]) => `${position} ${count}`).join(", ")}.`,
      "- These splits are observational, role- and team-confounded, schedule-fit adjusted, and never treated as causal.",
      "",
    ] : []),
    `Official international-game list: ${INTERNATIONAL_URL}`,
    "",
  ];
  return lines.join("\n");
}

function validateOutput({ manifest, playersPayload, research, environment, contextMarkdown }) {
  const errors = [];
  const players = playersPayload.players;
  if (manifest.schemaVersion !== 1 || !manifest.snapshotId || Number.isNaN(Date.parse(manifest.generatedAt))) errors.push("manifest metadata is invalid");
  if (playersPayload.snapshotId !== manifest.snapshotId || research.snapshotId !== manifest.snapshotId || environment.snapshotId !== manifest.snapshotId) errors.push("bundle snapshot IDs do not match");
  if (playersPayload.generatedAt !== manifest.generatedAt || research.generatedAt !== manifest.generatedAt || environment.generatedAt !== manifest.generatedAt) errors.push("bundle generatedAt timestamps do not match");
  if (Number.isNaN(Date.parse(research.observedAt)) || Date.parse(research.observedAt) > Date.parse(research.generatedAt)) errors.push("research observation time is invalid");
  const expectedSnapshotId = `${manifest.generatedAt.slice(0, 10).replaceAll("-", "")}-${computeSnapshotDigest(playersPayload, research, environment)}`;
  if (manifest.snapshotId !== expectedSnapshotId) errors.push("bundle snapshot digest does not match payloads");
  if (!Array.isArray(manifest.sources) || manifest.sources.length < 39) errors.push("manifest source attribution is incomplete");
  if (new Set(manifest.sources.map((source) => source.id)).size !== manifest.sources.length) errors.push("manifest source IDs are not unique");
  const sourceIds = new Set(manifest.sources.map((source) => source.id));
  for (const source of manifest.sources) {
    if (!source.id || !source.name || !source.url || !source.retrievedAt || !source.attribution || !source.terms || !source.freshness?.state) errors.push(`source ${source.id ?? "unknown"} is incomplete`);
    try { new URL(source.url); } catch { errors.push(`source ${source.id ?? "unknown"} has invalid URL`); }
  }
  for (const [key, value] of Object.entries(manifest.observationTimes ?? {})) {
    if (Number.isNaN(Date.parse(value)) || Date.parse(value) > Date.parse(manifest.generatedAt)) errors.push(`manifest observation time ${key} is invalid`);
  }
  if (research.observedAt !== manifest.observationTimes?.headlines) errors.push("headline observation times do not match");
  for (const trendSourceId of research.trends?.sourceIds ?? []) if (!sourceIds.has(trendSourceId)) errors.push(`trend source ${trendSourceId} is missing`);
  if (!Array.isArray(players) || players.length < 180 || players.length > 500) errors.push(`player count ${players?.length ?? 0} is outside 180..500`);
  if (environment.schemaVersion !== 1 || environment.season !== SEASON || Object.keys(environment.teams ?? {}).length !== 32) errors.push("environment payload is invalid");
  for (const [team, payload] of Object.entries(environment.teams ?? {})) {
    if (!TEAM_CODES.has(team) || payload?.summary?.games !== 17 || payload?.games?.length !== 17) errors.push(`environment schedule is invalid for ${team}`);
  }
  const ids = new Set();
  const ranks = new Set();
  for (const player of players ?? []) {
    if (!player.id || ids.has(player.id)) errors.push(`duplicate or missing player ID ${player.id}`);
    ids.add(player.id);
    if (!player.name || !canonicalPosition(player.position)) errors.push(`invalid identity for ${player.id}`);
    if (!player.sourceIds?.ffc || !/^(sleeper|ffc):/.test(player.id)) errors.push(`unstable source identity for ${player.id}`);
    if (!player.markets?.ppr || player.markets.ppr.adp <= 0 || ranks.has(player.markets.ppr.rank)) errors.push(`invalid PPR market for ${player.id}`);
    ranks.add(player.markets?.ppr?.rank);
    for (const market of Object.values(player.markets ?? {})) {
      if (!Number.isFinite(market.adp) || market.adp <= 0 || market.adp > 500 || !Number.isInteger(market.rank) || market.rank < 1 || !market.sample?.startDate || !market.sample?.endDate) errors.push(`invalid market observation for ${player.id}`);
      if (!sourceIds.has(market.sourceId)) errors.push(`market source ${market.sourceId} is missing for ${player.id}`);
    }
    if (player.team && !TEAM_CODES.has(player.team)) errors.push(`unknown team ${player.team} for ${player.id}`);
    if (player.scheduleContext && player.scheduleContext.games !== 17) errors.push(`invalid schedule context for ${player.id}`);
    if (player.scheduleContext && !sourceIds.has(player.scheduleContext.sourceId)) errors.push(`schedule source is missing for ${player.id}`);
    if (Number.isNaN(Date.parse(player.statusObservedAt)) || Date.parse(player.statusObservedAt) > Date.parse(manifest.generatedAt)) errors.push(`status observation time is invalid for ${player.id}`);
    if (player.splits) {
      if (!Number.isInteger(player.splits.games) || player.splits.games < 6 || player.splits.games > 80) errors.push(`invalid historical game count for ${player.id}`);
      if (!Number.isFinite(player.splits.contextScore) || player.splits.contextScore < 40 || player.splits.contextScore > 60) errors.push(`invalid historical context score for ${player.id}`);
      if (!Number.isFinite(player.splits.confidence) || player.splits.confidence < 0 || player.splits.confidence > 0.65) errors.push(`invalid historical confidence for ${player.id}`);
      if (player.splits.scheduleTeam !== player.team || player.splits.scheduleSeason !== SEASON) errors.push(`historical schedule fit is stale for ${player.id}`);
      if (!sourceIds.has(player.splits.sourceId)) errors.push(`historical source is missing for ${player.id}`);
    }
  }
  if (manifest.sources.filter((source) => source.kind === "official-club-rss").length < 24) errors.push("fewer than 24 official club feeds contributed usable observations");
  if (!Array.isArray(research.items) || research.items.length < 40) errors.push("research headline set is incomplete");
  for (const item of research.items ?? []) {
    const allowed = new Set(["id", "title", "url", "publishedAt", "source", "sourceId", "category", "team"]);
    if (Object.keys(item).some((key) => !allowed.has(key))) errors.push(`headline ${item.id} contains a disallowed field`);
    if (!item.title || item.title.length > 280 || /<[^>]+>|[\u0000-\u001f\u007f]/.test(item.title)) errors.push(`headline ${item.id} contains unsafe title text`);
    try { new URL(item.url); } catch { errors.push(`headline ${item.id} has invalid URL`); }
    if (Number.isNaN(Date.parse(item.publishedAt))) errors.push(`headline ${item.id} has invalid date`);
    if (Date.parse(item.publishedAt) > Date.parse(research.generatedAt) + 3_600_000) errors.push(`headline ${item.id} is more than one hour in the future`);
    if (!sourceIds.has(item.sourceId)) errors.push(`headline source ${item.sourceId} is missing`);
  }
  if (!contextMarkdown.startsWith("# 2026 research context") || contextMarkdown.includes("<script")) errors.push("research context is invalid");
  if (errors.length) throw new Error(`Generated snapshot failed validation:\n- ${[...new Set(errors)].join("\n- ")}`);
}

function sameUtcDay(left, right) {
  return typeof left === "string" && left.slice(0, 10) === right.slice(0, 10);
}

async function refreshEnvironmentOnly({ priorManifest, priorPlayersPayload, priorResearch, venueConfig, climateConfig }) {
  if (!priorManifest || !Array.isArray(priorPlayersPayload?.players) || !Array.isArray(priorResearch?.items)) {
    throw new Error("A complete existing core snapshot is required for an environment-only refresh");
  }
  console.log("Reusing today's ADP/Sleeper observations and rebuilding optional news, schedule, climate outlook, forecast, and line context...");
  const [scheduleResponse, cpcSet, feedSet] = await Promise.all([
    fetchTextOnce(SCHEDULE_URL, { timeoutMs: 30_000, maxBytes: 15_000_000 }),
    fetchCpcOutlooks(),
    fetchFeeds(priorResearch),
  ]);
  const { results: feedResults, failures: feedFailures } = feedSet;
  const scheduleRows = normalizeScheduleRows(scheduleResponse.text, venueConfig);
  const scheduleContexts = buildScheduleContexts(scheduleRows);
  const forecastSet = await fetchGameForecasts(scheduleRows, climateConfig);
  const environment = buildEnvironmentPayload({ scheduleRows, climateConfig, outlooks: cpcSet.outlooks, forecastsByGame: forecastSet.forecastsByGame, generatedAt, season: SEASON });
  const players = structuredClone(priorPlayersPayload.players);
  for (const player of players) {
    player.scheduleContext = player.team ? structuredClone(scheduleContexts.get(player.team) ?? null) : null;
    if (player.splits) player.splits = refitHistoricalContext(player.splits, player.scheduleContext, player.team, environment.teams[player.team]?.summary ?? null);
  }
  const environmentSourceIds = new Set([
    "nflverse-schedules",
    "nasa-power-climatology",
    "venue-coordinate-seed",
    "nws-forecast",
    "met-norway-forecast",
    ...CPC_OUTLOOK_FEEDS.map((feed) => feed.id),
  ]);
  const feedSourceIds = new Set([
    ...TEAM_FEEDS.map((feed) => feedSourceId(feed)),
    "rss-espn",
  ]);
  const sources = (priorManifest.sources ?? []).filter((source) => !environmentSourceIds.has(source.id) && !feedSourceIds.has(source.id));
  sources.push(...makeEnvironmentSourceRecords({ scheduleRows, climateConfig, cpcSet, forecastSet }));
  sources.push(...makeFeedSourceRecords(feedResults, priorManifest));
  sources.sort((left, right) => left.id.localeCompare(right.id));

  const playersPayload = { ...priorPlayersPayload, generatedAt, players };
  delete playersPayload.snapshotId;
  const headlineObservedAt = feedFailures.length === feedResults.length
    ? priorResearch.observedAt ?? generatedAt
    : generatedAt;
  const research = {
    ...priorResearch,
    generatedAt,
    observedAt: headlineObservedAt,
    items: headlinePayload(feedResults),
  };
  delete research.snapshotId;
  const digest = computeSnapshotDigest(playersPayload, research, environment);
  const snapshotId = `${generatedAt.slice(0, 10).replaceAll("-", "")}-${digest}`;
  playersPayload.snapshotId = snapshotId;
  research.snapshotId = snapshotId;
  environment.snapshotId = snapshotId;
  const retainedWarnings = (priorManifest.warnings ?? []).filter((warning) => !/headline feed|weather|climate|outlook|forecast/i.test(warning));
  const manifest = {
    ...priorManifest,
    snapshotId,
    generatedAt,
    files: { ...(priorManifest.files ?? {}), environment: "environment.json" },
    sources,
    observationTimes: {
      ...(priorManifest.observationTimes ?? {}),
      schedule: generatedAt,
      environment: generatedAt,
      climate: climateConfig.retrievedAt,
      outlooks: generatedAt,
      headlines: research.observedAt,
      ...(forecastSet.targets.length ? { forecasts: generatedAt } : {}),
    },
    warnings: [
      ...retainedWarnings,
      "NASA POWER temperature, precipitation, and wind values are 2001–2020 monthly climate normals, not game-day forecasts or precipitation probabilities.",
    ],
  };
  const splitPlayers = players.filter((player) => player.splits?.sourceId === "nflverse-player-stats");
  const historySummary = splitPlayers.length ? {
    playersWithSplits: splitPlayers.length,
    playersWithGuardedComparisons: splitPlayers.filter((player) => player.splits.confidence > 0).length,
    byPosition: Object.fromEntries(["QB", "RB", "WR", "TE", "D/ST", "K"].map((position) => [position, splitPlayers.filter((player) => player.position === position).length])),
  } : null;
  const contextMarkdown = buildContextMarkdown({
    players,
    priorPlayers: priorPlayersPayload.players,
    research,
    manifest,
    environment,
    identityWarnings: players.filter((player) => player.id.startsWith("ffc:")).map((player) => player.name),
    historySummary,
  });
  validateOutput({ manifest, playersPayload, research, environment, contextMarkdown });
  await writeAtomicBundle([
    [path.join(DATA_DIR, "players.json"), jsonText(playersPayload)],
    [path.join(DATA_DIR, "research.json"), jsonText(research)],
    [path.join(DATA_DIR, "environment.json"), jsonText(environment)],
    [path.join(DATA_DIR, "manifest.json"), jsonText(manifest)],
    [path.join(RESEARCH_DIR, "CONTEXT.md"), `${contextMarkdown.trim()}\n`],
  ], {
    expectedSnapshotPath: path.join(DATA_DIR, "manifest.json"),
    expectedSnapshotId: priorManifest.snapshotId,
    lockHeld: true,
  });
  console.log(`Published ${snapshotId}: optional context for ${Object.keys(environment.teams).length} teams and ${research.items.length} headlines; ADP and Sleeper endpoints were not requested.`);
  for (const failure of feedFailures) console.warn(`Headline feed skipped or carried forward: ${failure.feed.name}; ${failure.error}`);
  for (const failure of cpcSet.failures) console.warn(`NOAA CPC outlook unavailable after retries: ${failure.feed.name ?? failure.feed.id}; ${failure.error}`);
  for (const failure of forecastSet.failures) console.warn(`Game forecast unavailable: ${failure.gameId}; ${failure.error}`);
}

async function refreshHistoryOnly({ priorManifest, priorPlayersPayload, priorResearch, priorEnvironment, venueConfig }) {
  if (!priorManifest || !Array.isArray(priorPlayersPayload?.players) || !Array.isArray(priorResearch?.items) || Object.keys(priorEnvironment?.teams ?? {}).length !== 32) {
    throw new Error("A complete existing core snapshot is required for a history-only refresh");
  }
  console.log("Daily core cadence guard active; reusing ADP, Sleeper, and RSS observations and fetching nflverse history only...");
  const [scheduleResponse, statsResponses] = await Promise.all([
    fetchTextOnce(SCHEDULE_URL, { timeoutMs: 30_000, maxBytes: 15_000_000 }),
    Promise.all(STATS_URLS.map(({ url }) => fetchTextOnce(url, { timeoutMs: 60_000, maxBytes: 15_000_000 }))),
  ]);
  const scheduleRows = normalizeScheduleRows(scheduleResponse.text, venueConfig);
  const scheduleContexts = buildScheduleContexts(scheduleRows);
  // Clone before enrichment so the prior payload remains a meaningful baseline
  // for context generation and a thrown validation error cannot mutate it.
  const players = structuredClone(priorPlayersPayload.players);
  const statusObservedAt = priorManifest.sources.find((source) => source.id === "sleeper-players")?.retrievedAt ?? priorManifest.generatedAt;
  const marketObservedAt = priorManifest.sources.find((source) => source.id === "ffc-adp-ppr")?.retrievedAt ?? priorManifest.generatedAt;
  const trendsObservedAt = priorManifest.sources.find((source) => source.id === "sleeper-trends-add")?.retrievedAt ?? statusObservedAt;
  for (const player of players) {
    player.statusObservedAt ??= statusObservedAt;
    player.scheduleContext = player.team ? structuredClone(scheduleContexts.get(player.team) ?? null) : null;
    for (const [formatKey, market] of Object.entries(player.markets ?? {})) market.sourceId = `ffc-adp-${formatKey.toLowerCase()}`;
  }
  const historyMetadata = computeHistorySplits(statsResponses.map((response) => response.text), scheduleRows, players, priorEnvironment.teams);
  const withSplits = players.filter((player) => player.splits?.sourceId === "nflverse-player-stats");
  const historySummary = {
    playersWithSplits: withSplits.length,
    playersWithGuardedComparisons: withSplits.filter((player) => player.splits.confidence > 0).length,
    byPosition: Object.fromEntries(["QB", "RB", "WR", "TE", "D/ST", "K"].map((position) => [position, withSplits.filter((player) => player.position === position).length])),
  };
  if (historySummary.playersWithSplits < 50) throw new Error(`Historical identity coverage is implausibly low: ${historySummary.playersWithSplits} players`);

  const scheduleSource = sourceRecord({
    id: "nflverse-schedules",
    name: "nflverse schedules",
    url: SCHEDULE_URL,
    kind: "schedule-observation",
    records: scheduleRows.filter((game) => game.season === SEASON && game.gameType === "REG").length,
    attribution: "nflverse data",
    terms: "Creative Commons Attribution 4.0; venue overrides are separately attributed",
  });
  const historySources = makeHistorySourceRecords(historySummary, historyMetadata);
  const sources = priorManifest.sources
    .filter((source) => source.id !== "nflverse-schedules" && !source.id.startsWith("nflverse-player-stats"));
  sources.push(scheduleSource, ...historySources);
  sources.sort((left, right) => left.id.localeCompare(right.id));

  const playersPayload = { ...priorPlayersPayload, generatedAt, players };
  delete playersPayload.snapshotId;
  const research = {
    ...priorResearch,
    trends: {
      ...priorResearch.trends,
      sourceIds: ["sleeper-trends-add", "sleeper-trends-drop"],
    },
    observedAt: priorResearch.observedAt ?? priorResearch.generatedAt,
    generatedAt,
  };
  delete research.trends.sourceId;
  delete research.snapshotId;
  const environment = { ...structuredClone(priorEnvironment), generatedAt };
  delete environment.snapshotId;
  const digest = computeSnapshotDigest(playersPayload, research, environment);
  const snapshotId = `${generatedAt.slice(0, 10).replaceAll("-", "")}-${digest}`;
  playersPayload.snapshotId = snapshotId;
  research.snapshotId = snapshotId;
  environment.snapshotId = snapshotId;
  const manifest = {
    ...priorManifest,
    snapshotId,
    generatedAt,
    files: { ...(priorManifest.files ?? {}), environment: "environment.json" },
    sources,
    observationTimes: {
      ...(priorManifest.observationTimes ?? {}),
      markets: marketObservedAt,
      playerStatus: statusObservedAt,
      trends: trendsObservedAt,
      headlines: research.observedAt,
      schedule: generatedAt,
      history: generatedAt,
    },
  };
  const identityWarnings = players.filter((player) => player.id.startsWith("ffc:")).map((player) => player.name);
  const contextMarkdown = buildContextMarkdown({
    players,
    priorPlayers: priorPlayersPayload.players,
    research,
    manifest,
    environment,
    identityWarnings,
    historySummary,
  });
  validateOutput({ manifest, playersPayload, research, environment, contextMarkdown });
  await writeAtomicBundle([
    [path.join(DATA_DIR, "players.json"), jsonText(playersPayload)],
    [path.join(DATA_DIR, "research.json"), jsonText(research)],
    [path.join(DATA_DIR, "environment.json"), jsonText(environment)],
    [path.join(DATA_DIR, "manifest.json"), jsonText(manifest)],
    [path.join(RESEARCH_DIR, "CONTEXT.md"), `${contextMarkdown.trim()}\n`],
  ], {
    expectedSnapshotPath: path.join(DATA_DIR, "manifest.json"),
    expectedSnapshotId: priorManifest.snapshotId,
    lockHeld: true,
  });
  console.log(`Published ${manifest.snapshotId}: ${historySummary.playersWithSplits} historical samples, ${historySummary.playersWithGuardedComparisons} guarded comparisons; core endpoints were not requested.`);
}

async function main() {
  const [priorManifest, priorPlayersPayload, priorResearch, priorEnvironment, venueConfigRaw, climateConfigRaw] = await Promise.all([
    readJsonIfPresent(path.join(DATA_DIR, "manifest.json")),
    readJsonIfPresent(path.join(DATA_DIR, "players.json")),
    readJsonIfPresent(path.join(DATA_DIR, "research.json")),
    readJsonIfPresent(path.join(DATA_DIR, "environment.json")),
    readJsonIfPresent(OVERRIDE_PATH),
    readJsonIfPresent(CLIMATE_PATH),
  ]);
  const venueConfig = validateOverrides(venueConfigRaw);
  const climateConfig = validateVenueClimate(climateConfigRaw);
  if (environmentOnly) return refreshEnvironmentOnly({ priorManifest, priorPlayersPayload, priorResearch, venueConfig, climateConfig });
  if (priorManifest?.sources?.some((source) => source.id === "sleeper-players" && sameUtcDay(source.retrievedAt, generatedAt))) {
    if (!priorEnvironment) return refreshEnvironmentOnly({ priorManifest, priorPlayersPayload, priorResearch, venueConfig, climateConfig });
    if (includeHistory) return refreshHistoryOnly({ priorManifest, priorPlayersPayload, priorResearch, priorEnvironment, venueConfig, climateConfig });
    console.log(`Daily cadence guard: core ADP/Sleeper endpoints were already fetched on ${generatedAt.slice(0, 10)}; snapshot left unchanged.`);
    return;
  }

  const ffcRequests = FFC_FORMATS.map((format) => ({
    format,
    url: `https://fantasyfootballcalculator.com/api/v1/adp/${format.endpoint}?teams=${TEAMS}&year=${SEASON}`,
  }));
  const sleeperPlayersUrl = "https://api.sleeper.app/v1/players/nfl";
  const sleeperAddUrl = "https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=50";
  const sleeperDropUrl = "https://api.sleeper.app/v1/players/nfl/trending/drop?lookback_hours=24&limit=50";

  console.log("Fetching three ADP markets, Sleeper observations, schedule metadata, climate outlooks, and 33 headline feeds...");
  const [ffcResponses, sleeperPlayersResponse, sleeperAddResponse, sleeperDropResponse, scheduleResponse, feedSet, cpcSet] = await Promise.all([
    Promise.all(ffcRequests.map(async ({ format, url }) => ({ format, url, response: await fetchJsonOnce(url, { maxBytes: 5_000_000 }) }))),
    fetchJsonOnce(sleeperPlayersUrl, { timeoutMs: 30_000, maxBytes: 20_000_000 }),
    fetchJsonOnce(sleeperAddUrl, { maxBytes: 1_000_000 }),
    fetchJsonOnce(sleeperDropUrl, { maxBytes: 1_000_000 }),
    fetchTextOnce(SCHEDULE_URL, { timeoutMs: 30_000, maxBytes: 15_000_000 }),
    fetchFeeds(priorResearch),
    fetchCpcOutlooks(),
  ]);
  const { results: feedResults, failures: feedFailures } = feedSet;

  const ffc = Object.fromEntries(ffcResponses.map(({ format, response }) => [format.key, parseFfcPayload(response.value, format)]));
  const sleeperPlayers = validateSleeperPlayers(sleeperPlayersResponse.value);
  const sleeperIndex = buildSleeperIndex(sleeperPlayers);
  const addTrends = parseTrends(sleeperAddResponse.value, "add");
  const dropTrends = parseTrends(sleeperDropResponse.value, "drop");
  const addTrendMap = new Map(addTrends.map((trend) => [trend.playerId, trend.count]));
  const dropTrendMap = new Map(dropTrends.map((trend) => [trend.playerId, trend.count]));
  const scheduleRows = normalizeScheduleRows(scheduleResponse.text, venueConfig);
  const scheduleContexts = buildScheduleContexts(scheduleRows);
  const forecastSet = await fetchGameForecasts(scheduleRows, climateConfig);
  const environment = buildEnvironmentPayload({
    scheduleRows,
    climateConfig,
    outlooks: cpcSet.outlooks,
    forecastsByGame: forecastSet.forecastsByGame,
    generatedAt,
    season: SEASON,
  });
  const priorPlayers = priorPlayersPayload?.players ?? [];
  const priorById = new Map(priorPlayers.map((player) => [player.id, player]));
  const otherMarkets = new Map();
  for (const format of FFC_FORMATS.filter(({ key }) => key !== "ppr")) {
    otherMarkets.set(format.key, new Map(ffc[format.key].players.map((player) => [player.ffcId, player])));
  }

  const identityWarnings = [];
  const players = ffc.ppr.players.map((base) => {
    const sleeper = matchSleeper(base, sleeperIndex);
    if (!sleeper) identityWarnings.push(`${base.name} (${base.position}, ${base.team ?? "FA"}, FFC ${base.ffcId})`);
    const id = sleeper ? `sleeper:${sleeper.id}` : `ffc:${base.ffcId}`;
    const team = sleeper?.team ?? base.team;
    const markets = { ppr: makeMarket(base, ffc.ppr.meta, "ppr") };
    for (const format of FFC_FORMATS.filter(({ key }) => key !== "ppr")) {
      const observation = otherMarkets.get(format.key).get(base.ffcId);
      if (observation) markets[format.key] = makeMarket(observation, ffc[format.key].meta, format.key);
    }
    const player = {
      id,
      name: sleeper?.name ?? base.name,
      position: base.position,
      team: team ?? null,
      bye: base.bye,
      status: sleeper?.status ?? "Unknown",
      active: sleeper?.active ?? null,
      injuryStatus: sleeper?.injuryStatus ?? null,
      injuryBodyPart: sleeper?.injuryBodyPart ?? null,
      depthChartOrder: sleeper?.depthChartOrder ?? null,
      trends: {
        adds24h: sleeper ? addTrendMap.get(sleeper.id) ?? 0 : 0,
        drops24h: sleeper ? dropTrendMap.get(sleeper.id) ?? 0 : 0,
      },
      markets,
      scheduleContext: team ? scheduleContexts.get(team) ?? null : null,
      sourceIds: {
        ffc: base.ffcId,
        sleeper: sleeper?.id ?? null,
        gsis: sleeper?.gsisId ?? null,
      },
      statusObservedAt: generatedAt,
    };
    const preservedSplits = priorById.get(id)?.splits;
    if (preservedSplits) player.splits = refitHistoricalContext(preservedSplits, player.scheduleContext, player.team, environment.teams[player.team]?.summary ?? null);
    return player;
  });
  for (const format of FFC_FORMATS) assignMarketTiers(players, format.key);

  const sources = [];
  for (const { format, url } of ffcRequests) {
    const meta = ffc[format.key].meta;
    sources.push(sourceRecord({
      id: `ffc-adp-${format.key.toLowerCase()}`,
      name: `Fantasy Football Calculator ${format.label} ADP`,
      url,
      kind: "market",
      records: ffc[format.key].players.length,
      attribution: `FantasyFootballCalculator.com ${format.label} ADP, ${TEAMS}-team leagues`,
      terms: `Free ADP REST API; attribution requested. Documentation: ${FFC_HELP_URL}`,
      refreshPolicy: { maxRequestsPerDay: 1 },
      details: meta,
    }));
  }
  sources.push(sourceRecord({
    id: "ffc-adp",
    name: "Fantasy Football Calculator ADP market family",
    url: FFC_HELP_URL,
    kind: "market-provenance",
    records: players.length,
    attribution: "FantasyFootballCalculator.com ADP",
    terms: "Free ADP REST API; attribution requested; scoring-specific endpoint observations are listed separately",
    refreshPolicy: { maxRequestsPerDay: 1 },
    details: { formats: FFC_FORMATS.map(({ key }) => key) },
  }));
  sources.push(
    sourceRecord({ id: "sleeper-players", name: "Sleeper NFL players", url: sleeperPlayersUrl, kind: "player-observation", records: Object.keys(sleeperPlayers).length, attribution: "Sleeper API", terms: `Personal non-commercial use; documentation: ${SLEEPER_DOCS_URL}`, refreshPolicy: { maxRequestsPerDay: 1 } }),
    sourceRecord({ id: "sleeper-trends-add", name: "Sleeper NFL add trends", url: sleeperAddUrl, kind: "trend-observation", records: addTrends.length, attribution: "Sleeper API", terms: `Personal non-commercial use; documentation: ${SLEEPER_DOCS_URL}` }),
    sourceRecord({ id: "sleeper-trends-drop", name: "Sleeper NFL drop trends", url: sleeperDropUrl, kind: "trend-observation", records: dropTrends.length, attribution: "Sleeper API", terms: `Personal non-commercial use; documentation: ${SLEEPER_DOCS_URL}` }),
  );
  sources.push(...makeEnvironmentSourceRecords({ scheduleRows, climateConfig, cpcSet, forecastSet }));
  sources.push(...makeFeedSourceRecords(feedResults, priorManifest));
  const venueSources = [venueConfig.internationalVenueSource, ...venueConfig.overrides.map((override) => override.provenance)];
  for (const [index, source] of venueSources.entries()) {
    sources.push(sourceRecord({
      id: index === 0 ? "official-international-venues" : `venue-override-${venueConfig.overrides[index - 1].id}`,
      name: source.publisher,
      url: source.url,
      kind: "manual-venue-reference",
      retrievedAt: `${source.reviewedAt}T12:00:00.000Z`,
      records: index === 0 ? 9 : 1,
      attribution: source.publisher,
      terms: "Linked factual reference; manually reviewed and effective-dated in docs/venue-overrides.json",
      details: { note: source.note },
      maxAgeHours: 8760,
    }));
  }

  let publishedHistorySummary = null;
  if (includeHistory) {
    console.log("Fetching optional 2023–25 nflverse weekly player history...");
    const statsResponses = await Promise.all(STATS_URLS.map(({ url }) => fetchTextOnce(url, { timeoutMs: 60_000, maxBytes: 15_000_000 })));
    const historyMetadata = computeHistorySplits(statsResponses.map((response) => response.text), scheduleRows, players, environment.teams);
    const historyPlayers = players.filter((player) => player.splits?.sourceId === "nflverse-player-stats");
    publishedHistorySummary = {
      playersWithSplits: historyPlayers.length,
      playersWithGuardedComparisons: historyPlayers.filter((player) => player.splits.confidence > 0).length,
      byPosition: Object.fromEntries(["QB", "RB", "WR", "TE", "D/ST", "K"].map((position) => [position, historyPlayers.filter((player) => player.position === position).length])),
    };
    sources.push(...makeHistorySourceRecords(publishedHistorySummary, historyMetadata));
  } else if (players.some((player) => player.splits?.sourceId === "nflverse-player-stats")) {
    // A compact core refresh preserves prior split observations and therefore
    // must preserve the full source family that supports them.
    sources.push(...(priorManifest?.sources ?? []).filter((source) => source.id.startsWith("nflverse-player-stats")));
  }

  const playersPayload = {
    schemaVersion: 1,
    season: SEASON,
    generatedAt,
    attribution: `ADP data courtesy of FantasyFootballCalculator.com; player status/trends from Sleeper; schedule, line snapshots, and optional history from nflverse; climate normals from NASA POWER; outlooks from NOAA CPC. See manifest.json.`,
    players,
  };
  const headlineObservedAt = feedFailures.length === feedResults.length
    ? priorResearch?.observedAt ?? generatedAt
    : generatedAt;
  const research = {
    schemaVersion: 1,
    generatedAt,
    observedAt: headlineObservedAt,
    notice: "Headline titles, links, and dates are an unmodified-source research inbox. No article bodies are stored and no headline changes rankings automatically.",
    trends: { windowHours: 24, add: mapTrends(addTrends, sleeperIndex), drop: mapTrends(dropTrends, sleeperIndex), sourceIds: ["sleeper-trends-add", "sleeper-trends-drop"] },
    items: headlinePayload(feedResults),
  };
  const digest = computeSnapshotDigest(playersPayload, research, environment);
  const snapshotId = `${generatedAt.slice(0, 10).replaceAll("-", "")}-${digest}`;
  playersPayload.snapshotId = snapshotId;
  research.snapshotId = snapshotId;
  environment.snapshotId = snapshotId;
  const manifest = {
    schemaVersion: 1,
    snapshotId,
    generatedAt,
    season: SEASON,
    leaguePreset: { teams: TEAMS, scoring: "ppr", rounds: 16, editableAtRuntime: true },
    files: { players: "players.json", research: "research.json", environment: "environment.json" },
    marketWindows: Object.fromEntries(FFC_FORMATS.map((format) => [format.key, { startDate: ffc[format.key].meta.sampleStart, endDate: ffc[format.key].meta.sampleEnd, totalDrafts: ffc[format.key].meta.totalDrafts }])),
    sources,
    observationTimes: {
      markets: generatedAt,
      playerStatus: generatedAt,
      trends: generatedAt,
      headlines: research.observedAt,
      schedule: generatedAt,
      environment: generatedAt,
      climate: climateConfig.retrievedAt,
      outlooks: generatedAt,
      ...(forecastSet.targets.length ? { forecasts: generatedAt } : {}),
      ...(publishedHistorySummary ? { history: generatedAt } : priorManifest?.observationTimes?.history ? { history: priorManifest.observationTimes.history } : {}),
    },
    warnings: [
      ...(identityWarnings.length
        ? [`${identityWarnings.length} PPR players did not resolve to a Sleeper ID and use their stable FFC ID.`]
        : []),
      "Stade de France and Maracana NFL gameday surfaces remain unverified; their surface modifier stays neutral.",
      "NASA POWER temperature, precipitation, and wind values are 2001–2020 monthly climate normals, not game-day forecasts or precipitation probabilities.",
    ],
  };
  const contextMarkdown = buildContextMarkdown({ players, priorPlayers, research, manifest, environment, identityWarnings, historySummary: publishedHistorySummary });
  validateOutput({ manifest, playersPayload, research, environment, contextMarkdown });

  await writeAtomicBundle([
    [path.join(DATA_DIR, "players.json"), jsonText(playersPayload)],
    [path.join(DATA_DIR, "research.json"), jsonText(research)],
    [path.join(DATA_DIR, "environment.json"), jsonText(environment)],
    [path.join(DATA_DIR, "manifest.json"), jsonText(manifest)],
    [path.join(RESEARCH_DIR, "CONTEXT.md"), `${contextMarkdown.trim()}\n`],
  ], {
    expectedSnapshotPath: path.join(DATA_DIR, "manifest.json"),
    expectedSnapshotId: priorManifest?.snapshotId ?? null,
    lockHeld: true,
  });
  console.log(`Published ${snapshotId}: ${players.length} players, ${research.items.length} headlines, ${sources.length} attributed sources.`);
  if (identityWarnings.length) console.log(`Identity review: ${identityWarnings.length} records retain FFC IDs. See research/CONTEXT.md.`);
  for (const failure of feedFailures) {
    console.warn(`Headline feed degraded: ${failure.feed.name}; ${failure.error}; content-type ${failure.contentType || "unknown"}; final URL ${failure.finalUrl}`);
  }
  for (const failure of cpcSet.failures) console.warn(`NOAA CPC outlook unavailable after retries: ${failure.feed.id}; ${failure.error}`);
  for (const failure of forecastSet.failures) console.warn(`Game forecast unavailable: ${failure.gameId}; ${failure.error}`);
}

await withFileLock(RUN_LOCK_PATH, main);
