const MONTH_KEYS = Object.freeze(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]);
const INTERNATIONAL_COUNTRIES = Object.freeze({
  LON00: "GB",
  LON02: "GB",
  MAD01: "ES",
  MEL00: "AU",
  MEX00: "MX",
  MUN01: "DE",
  PAR00: "FR",
  RIO00: "BR",
});

export const CPC_OUTLOOK_FEEDS = Object.freeze([
  { id: "noaa-cpc-610-temperature", horizon: "6-10 day", dimension: "temperature", url: "https://www.cpc.ncep.noaa.gov/products/predictions/610day/610temp_latest.kml" },
  { id: "noaa-cpc-610-precipitation", horizon: "6-10 day", dimension: "precipitation", url: "https://www.cpc.ncep.noaa.gov/products/predictions/610day/610prcp_latest.kml" },
  { id: "noaa-cpc-814-temperature", horizon: "8-14 day", dimension: "temperature", url: "https://www.cpc.ncep.noaa.gov/products/predictions/814day/814temp_latest.kml" },
  { id: "noaa-cpc-814-precipitation", horizon: "8-14 day", dimension: "precipitation", url: "https://www.cpc.ncep.noaa.gov/products/predictions/814day/814prcp_latest.kml" },
  { id: "noaa-cpc-week34-temperature", horizon: "week 3-4", dimension: "temperature", url: "https://ftp.cpc.ncep.noaa.gov/GIS/us_tempprcpfcst/wk34temp_latest.kml" },
  { id: "noaa-cpc-week34-precipitation", horizon: "week 3-4", dimension: "precipitation", url: "https://ftp.cpc.ncep.noaa.gov/GIS/us_tempprcpfcst/wk34prcp_latest.kml" },
]);

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value, places = 1) {
  const multiplier = 10 ** places;
  return Math.round((Number(value) + Number.EPSILON) * multiplier) / multiplier;
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

function decodeXml(value) {
  return String(value ?? "")
    .replaceAll("&#37;", "%")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function usDateToIso(value) {
  const match = String(value ?? "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return null;
  const [, month, day, year] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function extractTableValue(block, label) {
  const expression = new RegExp(`<td[^>]*>\\s*${label}\\s*</td>\\s*<td[^>]*>\\s*([^<]+)\\s*</td>`, "i");
  return decodeXml(block.match(expression)?.[1]?.trim() ?? "");
}

function categoryName(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("above")) return "above-normal";
  if (normalized.includes("below")) return "below-normal";
  if (normalized.includes("normal")) return "near-normal";
  return "equal-chances";
}

export function pointInPolygon(longitude, latitude, polygon) {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const [currentLongitude, currentLatitude] = polygon[current];
    const [previousLongitude, previousLatitude] = polygon[previous];
    const crosses = (currentLatitude > latitude) !== (previousLatitude > latitude)
      && longitude < ((previousLongitude - currentLongitude) * (latitude - currentLatitude)) / (previousLatitude - currentLatitude) + currentLongitude;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function parseCpcOutlookKml(text, feed) {
  if (!feed?.id || !["temperature", "precipitation"].includes(feed.dimension)) throw new Error("CPC feed metadata is invalid");
  const documentName = decodeXml(text.match(/<Document\b[^>]*>[\s\S]*?<name>([^<]+)<\/name>/i)?.[1] ?? "");
  const dateMatch = documentName.match(/Created:\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*Valid:\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  const issuedDate = usDateToIso(dateMatch?.[1]);
  const validStart = usDateToIso(dateMatch?.[2]);
  const validEnd = usDateToIso(dateMatch?.[3]);
  if (!issuedDate || !validStart || !validEnd) throw new Error(`${feed.id} is missing created/valid dates`);

  const features = [];
  for (const match of text.matchAll(/<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi)) {
    const block = match[1];
    const probability = Number(extractTableValue(block, "Probability"));
    const category = categoryName(extractTableValue(block, "Category") || block.match(/<name>([^<]*)<\/name>/i)?.[1]);
    if (!Number.isFinite(probability) || probability < 0 || probability > 100) continue;
    const polygons = [...block.matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/gi)]
      .map((coordinateMatch) => coordinateMatch[1].trim().split(/\s+/).map((coordinate) => {
        const [longitude, latitude] = coordinate.split(",").map(Number);
        return [longitude, latitude];
      }).filter(([longitude, latitude]) => Number.isFinite(longitude) && Number.isFinite(latitude)))
      .filter((polygon) => polygon.length >= 3);
    if (polygons.length) features.push({ category, probability: round(probability, 1), polygons });
  }
  if (!features.length) throw new Error(`${feed.id} contains no usable outlook polygons`);
  return { sourceId: feed.id, horizon: feed.horizon, dimension: feed.dimension, issuedDate, validStart, validEnd, features };
}

function isConterminousUs(latitude, longitude) {
  return latitude >= 24 && latitude <= 50 && longitude >= -125 && longitude <= -66;
}

export function outlookAtPoint(outlook, latitude, longitude) {
  const matches = outlook.features.filter((feature) => feature.polygons.some((polygon) => pointInPolygon(longitude, latitude, polygon)));
  if (matches.length) {
    const best = matches.sort((left, right) => right.probability - left.probability)[0];
    return { category: best.category, probability: best.probability };
  }
  if (isConterminousUs(latitude, longitude)) return { category: "equal-chances", probability: 33.3 };
  return null;
}

export function validateVenueClimate(payload) {
  if (payload?.schemaVersion !== 1 || payload.baselinePeriod !== "2001-2020" || !Array.isArray(payload.venues)) throw new Error("venue-climate.json is invalid");
  if (payload.venues.length !== 38) throw new Error(`venue-climate.json must contain 38 venues; received ${payload.venues.length}`);
  const ids = new Set();
  for (const venue of payload.venues) {
    if (!venue.stadiumId || ids.has(venue.stadiumId) || !venue.name) throw new Error("Venue climate identity is missing or duplicated");
    ids.add(venue.stadiumId);
    if (!Number.isFinite(venue.latitude) || venue.latitude < -90 || venue.latitude > 90 || !Number.isFinite(venue.longitude) || venue.longitude < -180 || venue.longitude > 180) throw new Error(`${venue.stadiumId} has invalid coordinates`);
    for (const month of ["JAN", "SEP", "OCT", "NOV", "DEC"]) {
      const normal = venue.climate?.[month];
      if (!normal || !Number.isFinite(normal.temperatureF) || normal.temperatureF < -50 || normal.temperatureF > 130
        || !Number.isFinite(normal.precipitationMmPerDay) || normal.precipitationMmPerDay < 0 || normal.precipitationMmPerDay > 30
        || !Number.isFinite(normal.windMph) || normal.windMph < 0 || normal.windMph > 50) throw new Error(`${venue.stadiumId} ${month} climate normal is invalid`);
    }
  }
  return payload;
}

export function countryCodeForStadium(stadiumId) {
  return INTERNATIONAL_COUNTRIES[stadiumId] ?? "US";
}

export function kickoffUtc(gameday, gametime) {
  if (!validDate(gameday) || !/^\d{2}:\d{2}$/.test(gametime ?? "")) return null;
  const month = Number(gameday.slice(5, 7));
  const day = Number(gameday.slice(8, 10));
  // nflverse future schedule times are Eastern. The 2026 season is UTC-4
  // through Oct. 31 and UTC-5 from the Nov. 1 DST transition onward.
  const easternOffset = month < 11 || (month === 11 && day < 1) ? "-04:00" : "-05:00";
  const parsed = new Date(`${gameday}T${gametime}:00${easternOffset}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function maximumNumericText(value) {
  const values = String(value ?? "").match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  return values.length ? Math.max(...values) : null;
}

export function summarizeNwsHourly(payload, { gameId, kickoff, sourceId = "nws-forecast" } = {}) {
  const kickoffMs = Date.parse(kickoff);
  const periods = payload?.properties?.periods;
  if (!Number.isFinite(kickoffMs) || !Array.isArray(periods)) return null;
  const selected = periods.filter((period) => {
    const start = Date.parse(period.startTime);
    return Number.isFinite(start) && start >= kickoffMs - 60 * 60 * 1_000 && start <= kickoffMs + 4 * 60 * 60 * 1_000;
  });
  if (!selected.length) return null;
  const temperatures = selected.map((period) => {
    const value = Number(period.temperature);
    if (!Number.isFinite(value)) return null;
    return String(period.temperatureUnit).toUpperCase() === "C" ? value * 9 / 5 + 32 : value;
  }).filter(Number.isFinite);
  const winds = selected.map((period) => maximumNumericText(period.windSpeed)).filter(Number.isFinite);
  const precipitation = selected.map((period) => Number(period.probabilityOfPrecipitation?.value)).filter(Number.isFinite);
  return {
    gameId,
    kind: "game-window-forecast",
    provider: "National Weather Service",
    sourceId,
    issuedAt: payload.properties.updateTime ?? selected[0].startTime,
    windowStart: selected[0].startTime,
    windowEnd: selected.at(-1).endTime,
    temperatureF: temperatures.length ? round(temperatures.reduce((sum, value) => sum + value, 0) / temperatures.length, 1) : null,
    windMph: winds.length ? round(Math.max(...winds), 1) : null,
    precipitationProbability: precipitation.length ? round(Math.max(...precipitation), 1) : null,
    summary: [...new Set(selected.map((period) => String(period.shortForecast ?? "").trim()).filter(Boolean))].slice(0, 3).join(" / ") || null,
  };
}

export function summarizeMetCompact(payload, { gameId, kickoff, sourceId = "met-norway-forecast" } = {}) {
  const kickoffMs = Date.parse(kickoff);
  const series = payload?.properties?.timeseries;
  if (!Number.isFinite(kickoffMs) || !Array.isArray(series)) return null;
  const selected = series.filter((entry) => {
    const time = Date.parse(entry.time);
    return Number.isFinite(time) && time >= kickoffMs - 60 * 60 * 1_000 && time <= kickoffMs + 4 * 60 * 60 * 1_000;
  });
  if (!selected.length) return null;
  const values = (selector) => selected.map(selector).map(Number).filter(Number.isFinite);
  const temperatures = values((entry) => entry.data?.instant?.details?.air_temperature);
  const winds = values((entry) => entry.data?.instant?.details?.wind_speed);
  const precipitation = values((entry) => entry.data?.next_1_hours?.details?.precipitation_amount);
  const probabilities = values((entry) => entry.data?.next_1_hours?.details?.probability_of_precipitation);
  return {
    gameId,
    kind: "game-window-forecast",
    provider: "MET Norway",
    sourceId,
    issuedAt: payload.properties.meta?.updated_at ?? selected[0].time,
    windowStart: selected[0].time,
    windowEnd: selected.at(-1).time,
    temperatureF: temperatures.length ? round((temperatures.reduce((sum, value) => sum + value, 0) / temperatures.length) * 9 / 5 + 32, 1) : null,
    windMph: winds.length ? round(Math.max(...winds) * 2.236936, 1) : null,
    precipitationMm: precipitation.length ? round(precipitation.reduce((sum, value) => sum + value, 0), 2) : null,
    precipitationProbability: probabilities.length ? round(Math.max(...probabilities), 1) : null,
    summary: [...new Set(selected.map((entry) => entry.data?.next_1_hours?.summary?.symbol_code).filter(Boolean))].slice(0, 3).join(" / ") || null,
  };
}

function climateNormalForGame(game, venue) {
  const month = MONTH_KEYS[new Date(`${game.gameday}T12:00:00Z`).getUTCMonth()];
  const normal = venue?.climate?.[month];
  if (!normal) return null;
  return {
    baselinePeriod: "2001-2020",
    month,
    temperatureF: normal.temperatureF,
    precipitationMmPerDay: normal.precipitationMmPerDay,
    windMph: normal.windMph,
    sourceId: "nasa-power-climatology",
    label: "Climate normal — not a game forecast",
  };
}

function gameOutlook(game, venue, outlooks) {
  if (!venue || countryCodeForStadium(venue.stadiumId) !== "US") return null;
  const matching = outlooks.filter((outlook) => game.gameday >= outlook.validStart && game.gameday <= outlook.validEnd);
  if (!matching.length) return null;
  const values = {};
  const horizonPriority = { "6-10 day": 1, "8-14 day": 2, "week 3-4": 3 };
  const selected = ["temperature", "precipitation"].flatMap((dimension) => {
    const candidates = matching.filter((outlook) => outlook.dimension === dimension)
      .sort((left, right) => (horizonPriority[left.horizon] ?? 99) - (horizonPriority[right.horizon] ?? 99) || right.issuedDate.localeCompare(left.issuedDate));
    return candidates.length ? [candidates[0]] : [];
  });
  for (const outlook of selected) {
    const point = outlookAtPoint(outlook, venue.latitude, venue.longitude);
    if (!point) continue;
    values[outlook.dimension] = {
      ...point,
      horizon: outlook.horizon,
      issuedDate: outlook.issuedDate,
      validStart: outlook.validStart,
      validEnd: outlook.validEnd,
      sourceId: outlook.sourceId,
      label: "Extended outlook category — not an exact forecast",
    };
  }
  return Object.keys(values).length ? values : null;
}

function marketForTeam(game, team) {
  if (!Number.isFinite(game.totalLine) || !Number.isFinite(game.spreadLine)) return null;
  const homeImplied = (game.totalLine + game.spreadLine) / 2;
  const awayImplied = (game.totalLine - game.spreadLine) / 2;
  return {
    totalPoints: round(game.totalLine, 1),
    spread: round(game.spreadLine, 1),
    favoredTeam: game.spreadLine > 0 ? game.homeTeam : game.spreadLine < 0 ? game.awayTeam : null,
    teamImpliedPoints: round(team === game.homeTeam ? homeImplied : awayImplied, 1),
    observedAt: game.marketObservedAt,
    sourceId: "nflverse-schedules",
    label: "Market line snapshot — not a projection guarantee",
  };
}

function summarizeTeam(team, games) {
  const outdoor = games.filter((game) => game.roof !== "dome" && game.climateNormal);
  const averages = (key) => outdoor.length ? round(outdoor.reduce((sum, game) => sum + game.climateNormal[key], 0) / outdoor.length, key === "precipitationMmPerDay" ? 2 : 1) : null;
  const lined = games.filter((game) => Number.isFinite(game.market?.teamImpliedPoints));
  return {
    team,
    games: games.length,
    outdoorClimateGames: outdoor.length,
    averageOutdoorClimateTemperatureF: averages("temperatureF"),
    averageOutdoorClimatePrecipitationMmPerDay: averages("precipitationMmPerDay"),
    averageOutdoorClimateWindMph: averages("windMph"),
    coldClimateGames: outdoor.filter((game) => game.climateNormal.temperatureF < 45).length,
    hotClimateGames: outdoor.filter((game) => game.climateNormal.temperatureF > 80).length,
    wetClimateGames: outdoor.filter((game) => game.climateNormal.precipitationMmPerDay >= 4).length,
    windyClimateGames: outdoor.filter((game) => game.climateNormal.windMph >= 12).length,
    outlookGames: games.filter((game) => game.outlook).length,
    forecastGames: games.filter((game) => game.forecast).length,
    marketGames: lined.length,
    averageMarketImpliedPoints: lined.length ? round(lined.reduce((sum, game) => sum + game.market.teamImpliedPoints, 0) / lined.length, 1) : null,
    marketPulseScore: 50,
    sourceIds: [...new Set(games.flatMap((game) => [
      game.climateNormal?.sourceId,
      ...Object.values(game.outlook ?? {}).map((outlook) => outlook.sourceId),
      game.forecast?.sourceId,
      game.market?.sourceId,
    ]).filter(Boolean))].sort(),
  };
}

export function buildEnvironmentPayload({ scheduleRows, climateConfig, outlooks = [], forecastsByGame = new Map(), generatedAt, season = 2026 } = {}) {
  validateVenueClimate(climateConfig);
  if (!Array.isArray(scheduleRows) || !scheduleRows.length || Number.isNaN(Date.parse(generatedAt))) throw new Error("Environment build inputs are invalid");
  const venues = new Map(climateConfig.venues.map((venue) => [venue.stadiumId, venue]));
  const regularGames = scheduleRows.filter((game) => game.season === season && game.gameType === "REG");
  if (regularGames.length !== 272) throw new Error(`Environment expected 272 regular-season games; received ${regularGames.length}`);
  const teams = {};
  for (const game of regularGames) {
    const venue = venues.get(game.stadiumId);
    if (!venue) throw new Error(`Environment is missing venue ${game.stadiumId}`);
    const climateNormal = climateNormalForGame(game, venue);
    const outlook = gameOutlook(game, venue, outlooks);
    const forecast = forecastsByGame.get(game.gameId) ?? null;
    for (const team of [game.awayTeam, game.homeTeam]) {
      teams[team] ??= { summary: null, games: [] };
      teams[team].games.push({
        gameId: game.gameId,
        week: game.week,
        gameday: game.gameday,
        kickoffUtc: game.kickoffUtc,
        opponent: team === game.homeTeam ? game.awayTeam : game.homeTeam,
        home: team === game.homeTeam,
        stadiumId: game.stadiumId,
        stadium: game.stadium,
        countryCode: countryCodeForStadium(game.stadiumId),
        roof: game.roofBucket,
        surface: game.surfaceBucket,
        restDays: team === game.homeTeam ? game.homeRest : game.awayRest,
        international: game.international === true,
        climateNormal,
        outlook,
        forecast,
        market: marketForTeam(game, team),
      });
    }
  }
  for (const [team, payload] of Object.entries(teams)) {
    payload.games.sort((left, right) => left.week - right.week || left.gameday.localeCompare(right.gameday));
    if (payload.games.length !== 17) throw new Error(`${team} environment schedule contains ${payload.games.length} games`);
    payload.summary = summarizeTeam(team, payload.games);
  }
  const rankedMarketTeams = Object.values(teams).filter(({ summary }) => Number.isFinite(summary.averageMarketImpliedPoints))
    .sort((left, right) => left.summary.averageMarketImpliedPoints - right.summary.averageMarketImpliedPoints);
  rankedMarketTeams.forEach(({ summary }, index) => {
    summary.marketPulseScore = rankedMarketTeams.length === 1 ? 50 : round(40 + (index / (rankedMarketTeams.length - 1)) * 20, 1);
  });
  return {
    schemaVersion: 1,
    season,
    generatedAt,
    snapshotId: null,
    climateBaseline: {
      period: climateConfig.baselinePeriod,
      retrievedAt: climateConfig.retrievedAt,
      sourceId: "nasa-power-climatology",
      note: climateConfig.source.note,
    },
    outlookCoverage: outlooks.map(({ features, ...metadata }) => ({ ...metadata, featureCount: features.length })),
    forecastCoverage: {
      games: [...forecastsByGame.keys()].sort(),
      note: "Forecasts appear only inside the provider horizon and never inherit from climate normals or outlook categories.",
    },
    teams,
  };
}
