import { DEFAULT_LEAGUE, DEFAULT_WEIGHTS, MAX_CONTEXT_SHARE, isManagerPick } from "./engine.js";

export const STATE_VERSION = 2;
export const STORAGE_KEY = "fantasy-war-room-2026:v2";

const clone = (value) => JSON.parse(JSON.stringify(value));

export function defaultState() {
  const now = new Date().toISOString();
  return {
    schemaVersion: STATE_VERSION,
    createdAt: now,
    updatedAt: now,
    league: clone(DEFAULT_LEAGUE),
    weights: clone(DEFAULT_WEIGHTS),
    history: [],
    playerNotes: {},
  };
}

function validInteger(value, min, max) {
  return Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
}

const ROSTER_LIMITS = Object.freeze({
  QB: [1, 3],
  RB: [1, 6],
  WR: [1, 8],
  TE: [1, 3],
  FLEX: [0, 4],
  "D/ST": [0, 2],
  K: [0, 2],
  bench: [0, 20],
});

export function validateState(candidate, knownPlayerIds = null) {
  const errors = [];
  const warnings = [];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) errors.push("Session must be a JSON object.");
  if (candidate?.schemaVersion !== STATE_VERSION) errors.push(`Session schema must be version ${STATE_VERSION}.`);

  const league = candidate?.league;
  const marketSets = knownPlayerIds && !(knownPlayerIds instanceof Set) ? knownPlayerIds : null;
  const knownIds = marketSets?.[league?.scoring] instanceof Set ? marketSets[league.scoring] : knownPlayerIds instanceof Set ? knownPlayerIds : null;
  if (!validInteger(league?.teams, 8, 16)) errors.push("League teams must be an integer from 8 to 16.");
  if (!validInteger(league?.slot, 1, Number(league?.teams) || 16)) errors.push("Draft slot must be within the league team count.");
  if (!validInteger(league?.rounds, 10, 24)) errors.push("Rounds must be an integer from 10 to 24.");
  if (!new Set(["ppr", "half-ppr", "standard"]).has(league?.scoring)) errors.push("Reception scoring is invalid.");
  if (!league?.roster || typeof league.roster !== "object" || Array.isArray(league.roster)) errors.push("Roster settings are missing.");
  else {
    for (const [key, [min, max]] of Object.entries(ROSTER_LIMITS)) {
      if (!validInteger(league.roster[key], min, max)) errors.push(`Roster ${key} must be an integer from ${min} to ${max}.`);
    }
    const rosterSize = Object.keys(ROSTER_LIMITS).reduce((sum, key) => sum + (Number(league.roster[key]) || 0), 0);
    if (rosterSize < 1 || rosterSize > 32) errors.push("Roster size must contain 1 to 32 slots.");
    if (validInteger(league?.rounds, 10, 24) && rosterSize !== Number(league.rounds)) errors.push("Roster size must equal the configured draft rounds.");
  }

  if (!candidate?.weights || typeof candidate.weights !== "object" || Array.isArray(candidate.weights)) errors.push("Model weights must be a plain object.");
  else {
    const values = [];
    for (const key of Object.keys(DEFAULT_WEIGHTS)) {
      if (!Object.hasOwn(candidate.weights, key)) {
        errors.push(`Weight ${key} is missing.`);
        continue;
      }
      const candidateValue = candidate.weights[key];
      if (typeof candidateValue !== "number" || !Number.isFinite(candidateValue) || candidateValue < 0 || candidateValue > 100) errors.push(`Weight ${key} must be a number from 0 to 100.`);
      else values.push([key, candidateValue]);
    }
    const totalWeight = values.reduce((sum, [, value]) => sum + value, 0);
    if (values.length === Object.keys(DEFAULT_WEIGHTS).length && totalWeight <= 0) errors.push("At least one model weight must be greater than zero.");
    const contextWeight = values.filter(([key]) => ["schedule", "splits"].includes(key)).reduce((sum, [, value]) => sum + value, 0);
    if (totalWeight > 0 && contextWeight / totalWeight > MAX_CONTEXT_SHARE + Number.EPSILON) {
      errors.push(`Schedule and split weights may contribute at most ${MAX_CONTEXT_SHARE * 100}% combined.`);
    }
  }

  if (!Array.isArray(candidate?.history)) errors.push("Draft history must be an array.");
  else {
    const totalPicks = validInteger(league?.teams, 8, 16) && validInteger(league?.rounds, 10, 24)
      ? Number(league.teams) * Number(league.rounds)
      : 0;
    const ids = new Set();
    const picks = new Set();
    for (const [index, entry] of candidate.history.entries()) {
      if (!entry || typeof entry !== "object") { errors.push(`History row ${index + 1} is invalid.`); continue; }
      if (!Number.isInteger(entry.pick) || entry.pick < 1 || entry.pick > totalPicks) errors.push(`History row ${index + 1} has an invalid pick.`);
      if (!entry.playerId || typeof entry.playerId !== "string" || entry.playerId.length > 128) errors.push(`History row ${index + 1} has an invalid player ID.`);
      if (!new Set(["mine", "other"]).has(entry.owner)) errors.push(`History row ${index + 1} has an invalid owner.`);
      if (Number.isInteger(entry.pick) && entry.pick >= 1 && entry.pick <= totalPicks && new Set(["mine", "other"]).has(entry.owner)) {
        const expectedMine = isManagerPick(entry.pick, league);
        if ((entry.owner === "mine") !== expectedMine) errors.push(`History row ${index + 1} owner does not match the configured snake turn.`);
      }
      if (ids.has(entry.playerId)) errors.push(`Player ${entry.playerId} appears more than once.`);
      if (picks.has(entry.pick)) errors.push(`Pick ${entry.pick} appears more than once.`);
      if (knownIds && !knownIds.has(entry.playerId)) warnings.push(`Player ${entry.playerId} is no longer in the current market snapshot; its saved pick was preserved.`);
      ids.add(entry.playerId);
      picks.add(entry.pick);
    }
    const ordered = [...candidate.history].sort((a, b) => a.pick - b.pick);
    if (ordered.some((entry, index) => entry.pick !== index + 1)) errors.push("History picks must be contiguous from pick 1.");
    if (marketSets && totalPicks) {
      const preservedOutsideMarket = new Set(candidate.history.filter((entry) => !knownIds?.has(entry.playerId)).map((entry) => entry.playerId)).size;
      if (totalPicks > (knownIds?.size ?? 0) + preservedOutsideMarket) warnings.push("The selected scoring market currently has fewer players than this draft requires; the session was preserved, but settings may need adjustment.");
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function loadState(knownPlayerIds = null) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { state: defaultState(), recovered: false, error: null, warnings: [] };
    const parsed = JSON.parse(raw);
    const validation = validateState(parsed, knownPlayerIds);
    if (!validation.valid) throw new Error(validation.errors.join(" "));
    return { state: parsed, recovered: false, error: null, warnings: validation.warnings };
  } catch (error) {
    return { state: defaultState(), recovered: true, error: error instanceof Error ? error.message : String(error), warnings: [] };
  }
}

export function saveState(state) {
  const next = { ...state, updatedAt: new Date().toISOString() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function addPick(state, { playerId, owner, scoreSnapshot = null, playerSnapshot = null }) {
  const totalPicks = Number(state?.league?.teams) * Number(state?.league?.rounds);
  if (!Number.isInteger(totalPicks) || state.history.length >= totalPicks) return state;
  if (state.history.some((entry) => entry.playerId === playerId)) return state;
  const pick = state.history.length + 1;
  if (!new Set(["mine", "other"]).has(owner) || (owner === "mine") !== isManagerPick(pick, state.league)) return state;
  const entry = {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${pick}`,
    pick,
    playerId,
    owner,
    selectedAt: new Date().toISOString(),
    scoreSnapshot,
    playerSnapshot,
  };
  return saveState({ ...state, history: [...state.history, entry] });
}

export function undoPick(state) {
  if (state.history.length === 0) return state;
  return saveState({ ...state, history: state.history.slice(0, -1) });
}

export function resetState() {
  const state = defaultState();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  return state;
}

export function updateSettings(state, league, weights) {
  return saveState({ ...state, league: clone(league), weights: clone(weights) });
}

export function exportSession(state, manifest) {
  return {
    exportType: "fantasy-war-room-session",
    exportedAt: new Date().toISOString(),
    dataSnapshot: manifest?.snapshotId ?? null,
    session: state,
  };
}

export function importSession(payload, knownPlayerIds) {
  const candidate = payload?.exportType === "fantasy-war-room-session" ? payload.session : payload;
  const validation = validateState(candidate, knownPlayerIds);
  if (!validation.valid) throw new Error(validation.errors.join(" "));
  return clone(candidate);
}
