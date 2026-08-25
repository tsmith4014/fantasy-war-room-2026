import {
  COMPONENT_META,
  DEFAULT_LEAGUE,
  DEFAULT_WEIGHTS,
  MAX_CONTEXT_SHARE,
  activeMarket,
  buildRecommendationShortlist,
  buildRoster,
  isManagerPick,
  nextManagerPick,
  normalizedWeights,
  overallToRoundPick,
  projectUpcomingTurns,
  rankPlayers,
} from "./modules/engine.js";
import {
  STORAGE_KEY,
  addPick,
  exportSession,
  importSession,
  loadState,
  resetState,
  saveState,
  toggleQueue,
  undoPick,
  updateSettings,
  validateState,
} from "./modules/state.js";
import {
  ageInHours,
  createElement,
  debounce,
  downloadJson,
  formatDateTime,
  normalizeName,
  round,
} from "./modules/utils.js";

const elements = Object.fromEntries(
  [
    "network-status", "freshness-status", "turn-summary", "current-pick", "round-pick", "next-pick", "picks-away",
    "undo-button", "export-button", "import-button", "reset-button", "import-file", "open-settings", "explain-model",
    "recommendations", "player-count", "search-input", "position-filter", "status-filter", "queue-only", "show-drafted", "player-rows",
    "empty-state", "clear-filters", "queue-count", "queue-list", "roster-count", "roster-slots", "roster-alert", "turn-plan", "research-list", "draft-log",
    "data-provenance", "settings-dialog", "settings-form", "setting-teams", "setting-slot", "setting-rounds", "setting-scoring",
    "weight-controls", "restore-settings", "player-dialog", "close-player-dialog", "player-dialog-title", "player-dialog-kicker",
    "player-dialog-content", "model-dialog", "close-model-dialog", "model-explanation", "data-alert", "toast", "live-region",
  ].map((id) => [id, document.getElementById(id)]),
);

const filters = { search: "", position: "ALL", status: "ALL", queueOnly: false, showDrafted: false };
let manifest;
let players = [];
let research = { items: [] };
let playersById = new Map();
let sessionPlayersById = new Map();
let state;
let ranked = [];
let scoreById = new Map();
let toastTimer;
let bundleReadFromOfflineCache = false;
let freshnessAlert = null;
let networkAlert = null;

const DATA_CACHE_PREFIX = "fantasy-war-room-2026-data-";

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  if (response.headers.has("X-War-Room-Snapshot")) bundleReadFromOfflineCache = true;
  return response.json();
}

function assertBundleConsistency(manifestPayload, playersPayload, researchPayload) {
  if (!manifestPayload?.snapshotId || manifestPayload.snapshotId !== playersPayload?.snapshotId || manifestPayload.snapshotId !== researchPayload?.snapshotId) {
    throw new Error("Published data bundle is inconsistent; reload after the deployment finishes.");
  }
  if (manifestPayload.generatedAt !== playersPayload.generatedAt || manifestPayload.generatedAt !== researchPayload.generatedAt) {
    throw new Error("Published data timestamps do not match; reload after the deployment finishes.");
  }
}

async function loadPublishedBundle() {
  bundleReadFromOfflineCache = false;
  const paths = ["./data/manifest.json", "./data/players.json", "./data/research.json"];
  let lastError;
  for (const suffix of ["", `?bundle=${encodeURIComponent(String(Date.now()))}`]) {
    try {
      const payloads = await Promise.all(paths.map((path) => loadJson(`${path}${suffix}`)));
      assertBundleConsistency(...payloads);
      await cacheVerifiedBundle(paths, payloads);
      return payloads;
    } catch (error) {
      lastError = error;
    }
  }
  const cached = await loadVerifiedBundleFromCache(paths);
  if (cached) return cached;
  throw lastError ?? new Error("Published data could not be loaded.");
}

async function cacheVerifiedBundle(paths, payloads) {
  if (!("caches" in globalThis)) return;
  const snapshotId = payloads[0]?.snapshotId;
  if (!snapshotId) return;
  const cacheName = `${DATA_CACHE_PREFIX}${snapshotId}`;
  try {
    const cache = await caches.open(cacheName);
    for (const [index, path] of paths.entries()) {
      const url = new URL(path, location.href);
      url.search = "";
      await cache.put(url.href, new Response(`${JSON.stringify(payloads[index])}\n`, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-War-Room-Snapshot": snapshotId,
        },
      }));
    }
    await cache.put(new URL("./data/__complete__", location.href).href, new Response(snapshotId));
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(DATA_CACHE_PREFIX) && key !== cacheName).map((key) => caches.delete(key)));
  } catch (error) {
    console.warn("Verified data could not be saved for offline use.", error);
  }
}

async function loadVerifiedBundleFromCache(paths) {
  if (!("caches" in globalThis)) return null;
  const markerUrl = new URL("./data/__complete__", location.href).href;
  const keys = (await caches.keys()).filter((key) => key.startsWith(DATA_CACHE_PREFIX));
  for (const key of keys) {
    try {
      const cache = await caches.open(key);
      if (!(await cache.match(markerUrl))) continue;
      const responses = await Promise.all(paths.map((path) => {
        const url = new URL(path, location.href);
        url.search = "";
        return cache.match(url.href);
      }));
      if (responses.some((response) => !response)) continue;
      const payloads = await Promise.all(responses.map((response) => response.json()));
      assertBundleConsistency(...payloads);
      bundleReadFromOfflineCache = true;
      return payloads;
    } catch {
      // Ignore incomplete or invalid older caches and continue looking.
    }
  }
  return null;
}

function summarizeStateWarnings(warnings = []) {
  const missing = warnings.filter((warning) => warning.startsWith("Player "));
  const other = warnings.filter((warning) => !warning.startsWith("Player "));
  const parts = [];
  if (missing.length) parts.push(`${missing.length} saved pick${missing.length === 1 ? "" : "s"} no longer appear in the current market; ${missing.length === 1 ? "it was" : "they were"} preserved.`);
  parts.push(...other);
  return parts.join(" ");
}

async function bootstrap() {
  setNetworkStatus("loading", "Loading data…");
  try {
    const [manifestPayload, playersPayload, researchPayload] = await loadPublishedBundle();
    manifest = manifestPayload;
    players = playersPayload.players;
    research = researchPayload;
    playersById = new Map(players.map((player) => [player.id, player]));

    const loaded = loadState(buildMarketIdSets());
    state = loaded.state;
    if (loaded.recovered) toast(`A damaged saved session was ignored. ${loaded.error}`, "warn");
    else if (loaded.warnings.length) toast(summarizeStateWarnings(loaded.warnings), "warn");

    bindEvents();
    renderAll();
    updateOnlineStatus();
    registerServiceWorker();
  } catch (error) {
    console.error(error);
    setNetworkStatus("error", "Data failed to load");
    elements["turn-summary"].textContent = "The last published snapshot could not be loaded. Refresh the page or inspect the data workflow.";
    toast(error instanceof Error ? error.message : String(error), "error");
  }
}

function bindEvents() {
  elements["undo-button"].addEventListener("click", handleUndo);
  elements["export-button"].addEventListener("click", handleExport);
  elements["import-button"].addEventListener("click", () => elements["import-file"].click());
  elements["import-file"].addEventListener("change", handleImport);
  elements["reset-button"].addEventListener("click", handleReset);
  elements["open-settings"].addEventListener("click", openSettings);
  elements["explain-model"].addEventListener("click", openModel);
  elements["clear-filters"].addEventListener("click", clearFilters);
  elements["search-input"].addEventListener("input", debounce((event) => {
    filters.search = normalizeName(event.target.value);
    renderTable();
  }, 70));
  elements["position-filter"].addEventListener("change", (event) => { filters.position = event.target.value; renderTable(); });
  elements["status-filter"].addEventListener("change", (event) => { filters.status = event.target.value; renderTable(); });
  elements["queue-only"].addEventListener("change", (event) => { filters.queueOnly = event.target.checked; renderTable(); });
  elements["show-drafted"].addEventListener("change", (event) => { filters.showDrafted = event.target.checked; renderTable(); });
  elements["player-rows"].addEventListener("click", handleDelegatedAction);
  elements.recommendations.addEventListener("click", handleDelegatedAction);
  elements["queue-list"].addEventListener("click", handleDelegatedAction);
  elements["turn-plan"].addEventListener("click", handleDelegatedAction);
  elements["setting-teams"].addEventListener("input", syncDraftSlotBounds);
  elements["settings-form"].addEventListener("submit", handleSettingsSubmit);
  elements["restore-settings"].addEventListener("click", restoreSettingsForm);
  elements["close-player-dialog"].addEventListener("click", () => elements["player-dialog"].close());
  elements["close-model-dialog"].addEventListener("click", () => elements["model-dialog"].close());
  window.addEventListener("online", updateOnlineStatus);
  window.addEventListener("offline", updateOnlineStatus);
  window.addEventListener("storage", handleStorageUpdate);
  document.addEventListener("keydown", handleKeyboard);
}

function renderAll() {
  sessionPlayersById = buildSessionPlayerMap();
  const draftedIds = new Set(state.history.map((entry) => entry.playerId));
  const myHistory = state.history.filter((entry) => entry.owner === "mine");
  const currentPick = state.history.length + 1;
  ranked = rankPlayers({ players, draftedIds, myHistory, playersById: sessionPlayersById, league: state.league, weights: state.weights, currentPick });
  scoreById = new Map(ranked.map((entry) => [entry.player.id, entry]));
  renderDraftState();
  renderRecommendations();
  renderTable();
  renderQueue();
  renderRoster(myHistory);
  renderTurnPlan(draftedIds, myHistory);
  renderResearch();
  renderDraftLog();
  renderFreshness();
  renderModelExplanation();
}

function buildSessionPlayerMap() {
  const combined = new Map(playersById);
  for (const entry of state.history) {
    if (combined.has(entry.playerId)) continue;
    const snapshot = entry.playerSnapshot ?? {};
    combined.set(entry.playerId, {
      id: entry.playerId,
      name: snapshot.name ?? `Unavailable player (${entry.playerId})`,
      position: snapshot.position ?? "Unknown",
      team: snapshot.team ?? null,
      bye: snapshot.bye ?? null,
      status: "Not in current market snapshot",
      injuryStatus: null,
      markets: {},
      scheduleContext: null,
    });
  }
  for (const playerId of state.queue ?? []) {
    if (combined.has(playerId)) continue;
    combined.set(playerId, {
      id: playerId,
      name: `Unavailable target (${playerId})`,
      position: "Unknown",
      team: null,
      bye: null,
      status: "Not in selected market snapshot",
      injuryStatus: null,
      markets: {},
      scheduleContext: null,
    });
  }
  return combined;
}

function buildMarketIdSets() {
  return Object.fromEntries(["ppr", "half-ppr", "standard"].map((scoring) => [
    scoring,
    new Set(players.filter((player) => activeMarket(player, scoring)).map((player) => player.id)),
  ]));
}

function renderDraftState() {
  const currentPick = state.history.length + 1;
  const totalPicks = state.league.teams * state.league.rounds;
  const { round: draftRound, pickInRound } = overallToRoundPick(Math.min(currentPick, totalPicks), state.league.teams);
  const nextPick = nextManagerPick(currentPick, state.league);
  const onClock = currentPick <= totalPicks && isManagerPick(currentPick, state.league);
  elements["current-pick"].textContent = currentPick > totalPicks ? "—" : String(currentPick);
  elements["round-pick"].textContent = currentPick > totalPicks ? "Draft complete" : `Round ${draftRound} · Pick ${pickInRound}`;
  elements["next-pick"].textContent = nextPick ? String(nextPick) : "—";
  elements["picks-away"].textContent = nextPick === currentPick ? "You are on the clock" : nextPick ? `${nextPick - currentPick} picks away` : "No remaining turns";
  elements["turn-summary"].textContent = currentPick > totalPicks
    ? `All ${totalPicks} picks are recorded. Export this session for your archive.`
    : onClock
      ? `Your slot ${state.league.slot} turn. Choose Mine to add a player to your roster.`
      : `Opponent turn. Mark the selected player Taken to advance toward pick ${nextPick ?? "—"}.`;
  elements["undo-button"].disabled = state.history.length === 0;
}

function renderRecommendations() {
  elements.recommendations.replaceChildren();
  const currentPick = state.history.length + 1;
  const totalPicks = state.league.teams * state.league.rounds;
  const draftComplete = currentPick > totalPicks;
  const managerTurn = currentPick <= totalPicks && isManagerPick(currentPick, state.league);
  const queue = state.queue ?? [];
  const queueSet = new Set(queue);
  const shortlist = buildRecommendationShortlist({ ranked, queue, limit: 5 });
  for (const [index, recommendation] of shortlist.entries()) {
    const { player, market, score, reason } = recommendation;
    const queued = queueSet.has(player.id);
    const requiredStarter = recommendation.requiredStarter;
    const card = createElement("article", { className: "recommendation-card", dataset: { position: player.position } });
    card.append(
      createElement("span", {
        className: `recommendation-rank${requiredStarter ? " required" : queued ? " queued" : ""}`,
        text: requiredStarter ? "Required starter" : queued ? "★ queued target" : `#${index + 1} option`,
      }),
      createElement("div", { className: "recommendation-player-line" }, [
        queueButton(player, queued),
        createElement("span", { className: "position-chip", text: player.position, dataset: { position: player.position } }),
        createElement("button", { className: "player-button", text: player.name, dataset: { action: "detail", playerId: player.id }, attributes: { type: "button" } }),
      ]),
      createElement("div", { className: "recommendation-meta" }, [
        createElement("span", { text: player.team ?? "FA" }),
        createElement("span", { text: "·" }),
        createElement("span", { text: `ADP ${round(market.adp, 1)}` }),
        createElement("span", { text: "·" }),
        createElement("span", { text: `Tier ${market.tier}` }),
        hasStatusConcern(player) ? statusBadge(player) : null,
      ]),
      createElement("div", { className: "recommendation-score" }, [
        createElement("strong", { text: score.toFixed(1) }),
        createElement("span", { text: "/ 100 war score" }),
      ]),
      createElement("p", { className: "recommendation-reason", text: sentenceCase(reason) }),
      createElement("div", { className: "recommendation-actions" }, [
        createElement("button", { className: "button primary", text: "Mine", disabled: !managerTurn, dataset: { action: "mine", playerId: player.id }, attributes: { type: "button", "aria-label": `Draft ${player.name} to my roster` } }),
        createElement("button", { className: "button secondary", text: "Taken", disabled: managerTurn || draftComplete, dataset: { action: "other", playerId: player.id }, attributes: { type: "button", "aria-label": `Mark ${player.name} drafted by an opponent` } }),
      ]),
    );
    elements.recommendations.append(card);
  }
  if (ranked.length === 0) elements.recommendations.append(createElement("p", { className: "muted", text: "No draftable players remain in this snapshot." }));
}

function renderTable() {
  const currentPick = state.history.length + 1;
  const totalPicks = state.league.teams * state.league.rounds;
  const draftComplete = currentPick > totalPicks;
  const managerTurn = currentPick <= totalPicks && isManagerPick(currentPick, state.league);
  const ownerById = new Map(state.history.map((entry) => [entry.playerId, entry.owner]));
  const queueSet = new Set(state.queue ?? []);
  const availableRows = ranked.map((entry) => entry.player);
  const draftedRows = filters.showDrafted
    ? state.history.slice().reverse().map((entry) => sessionPlayersById.get(entry.playerId)).filter(Boolean)
    : [];
  const seen = new Set();
  const rows = [...availableRows, ...draftedRows].filter((player) => {
    if (seen.has(player.id)) return false;
    seen.add(player.id);
    if (filters.position !== "ALL" && player.position !== filters.position) return false;
    const flagged = hasStatusConcern(player);
    if (filters.status === "CLEAR" && flagged) return false;
    if (filters.status === "FLAGGED" && !flagged) return false;
    if (filters.queueOnly && !queueSet.has(player.id)) return false;
    if (filters.search && !normalizeName(`${player.name} ${player.team} ${player.position}`).includes(filters.search)) return false;
    return true;
  });

  elements["player-rows"].replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const player of rows) {
    const scored = scoreById.get(player.id);
    const market = activeMarket(player, state.league.scoring);
    const owner = ownerById.get(player.id);
    const row = createElement("tr", { dataset: { position: player.position, ...(owner ? { owner } : {}) } });
    row.append(
      createElement("td", { className: "market-rank", text: market ? `#${market.rank}` : "—" }),
      createElement("td", { className: "player-cell" }, [
        queueButton(player, queueSet.has(player.id)),
        createElement("button", { className: "player-button player-name", text: player.name, dataset: { action: "detail", playerId: player.id }, attributes: { type: "button" } }),
        createElement("span", { className: "team-label", text: player.team ?? "FA" }),
      ]),
      createElement("td", {}, createElement("span", { className: "position-chip", text: player.position, dataset: { position: player.position } })),
      createElement("td", { text: player.bye ?? "—" }),
      createElement("td", { text: market ? round(market.adp, 1) : "—" }),
      createElement("td", { text: market?.tier ?? "—" }),
      createElement("td", {}, statusBadge(player)),
      createElement("td", {}, contextBadges(player)),
      createElement("td", { className: "score-cell" }, scoreCell(scored)),
      createElement("td", {}, owner
        ? createElement("span", { className: `tag ${owner === "mine" ? "good" : ""}`, text: owner === "mine" ? "My team" : "Drafted" })
        : createElement("div", { className: "row-actions" }, [
          createElement("button", { className: "row-action mine", text: "Mine", disabled: !managerTurn, dataset: { action: "mine", playerId: player.id }, attributes: { type: "button", title: managerTurn ? "Draft to my roster" : "Available on your scheduled turn", "aria-label": `Draft ${player.name} to my roster` } }),
          createElement("button", { className: "row-action", text: "Taken", disabled: managerTurn || draftComplete, dataset: { action: "other", playerId: player.id }, attributes: { type: "button", title: draftComplete ? "Draft is complete" : managerTurn ? "This is your scheduled turn" : "Mark drafted by an opponent", "aria-label": `Mark ${player.name} drafted by an opponent` } }),
        ])),
    );
    fragment.append(row);
  }
  elements["player-rows"].append(fragment);
  elements["player-count"].textContent = `${ranked.length} available`;
  elements["empty-state"].hidden = rows.length > 0;
}

function renderQueue() {
  const queue = state.queue ?? [];
  const ownerById = new Map(state.history.map((entry) => [entry.playerId, entry.owner]));
  const currentPick = state.history.length + 1;
  const totalPicks = state.league.teams * state.league.rounds;
  const managerTurn = currentPick <= totalPicks && isManagerPick(currentPick, state.league);
  const activeCount = queue.filter((playerId) => scoreById.has(playerId)).length;
  elements["queue-count"].textContent = `${activeCount} active`;
  elements["queue-list"].replaceChildren();

  for (const [index, playerId] of queue.entries()) {
    const player = sessionPlayersById.get(playerId);
    const scored = scoreById.get(playerId);
    const owner = ownerById.get(playerId);
    const position = player?.position ?? "Unknown";
    elements["queue-list"].append(createElement("li", { dataset: { ...(position !== "Unknown" ? { position } : {}) } }, [
      createElement("span", { className: "queue-order", text: String(index + 1) }),
      createElement("div", { className: "queue-copy" }, [
        createElement("button", { className: "player-button", text: player?.name ?? playerId, dataset: { action: "detail", playerId }, attributes: { type: "button" } }),
        createElement("span", { text: scored ? `${position} · ${player?.team ?? "FA"} · ${scored.score.toFixed(1)} war score` : owner ? `${position} · ${owner === "mine" ? "My roster" : "Drafted"}` : "Unavailable in this scoring market" }),
      ]),
      createElement("div", { className: "queue-actions" }, owner
        ? [createElement("span", { className: `tag ${owner === "mine" ? "good" : ""}`, text: owner === "mine" ? "Mine" : "Taken" }), queueRemoveButton(playerId, player?.name ?? playerId)]
        : [
          createElement("button", { className: "row-action mine", text: "Mine", disabled: !managerTurn || !scored, dataset: { action: "mine", playerId }, attributes: { type: "button", title: managerTurn ? "Draft to my roster" : "Available on your scheduled turn", "aria-label": `Draft ${player?.name ?? playerId} to my roster` } }),
          createElement("button", { className: "row-action", text: "Taken", disabled: managerTurn || currentPick > totalPicks || !scored, dataset: { action: "other", playerId }, attributes: { type: "button", title: managerTurn ? "This is your scheduled turn" : "Mark drafted by an opponent", "aria-label": `Mark ${player?.name ?? playerId} drafted by an opponent` } }),
          queueRemoveButton(playerId, player?.name ?? playerId),
        ]),
    ]));
  }

  if (!queue.length) {
    elements["queue-list"].append(createElement("li", { className: "queue-empty" }, createElement("span", { className: "muted", text: "Star targets on the shortlist or board. Queued players lead your shortlist without changing their model score." })));
  }
}

function renderRoster(myHistory) {
  const roster = buildRoster(myHistory, sessionPlayersById, state.league);
  elements["roster-slots"].replaceChildren();
  for (const slot of roster) {
    elements["roster-slots"].append(createElement("div", { className: "roster-slot" }, [
      createElement("span", { className: "slot-label", text: slot.label }),
      createElement("span", { className: `slot-player${slot.player ? "" : " empty"}`, text: slot.player?.name ?? "Open slot" }),
      createElement("span", { className: "slot-meta", text: slot.player ? `${slot.player.position} · ${slot.player.team ?? "FA"}` : slot.eligible.join("/") }),
    ]));
  }
  elements["roster-count"].textContent = `${myHistory.length} / ${roster.length}`;
  const byeCounts = new Map();
  for (const entry of myHistory) {
    const player = sessionPlayersById.get(entry.playerId);
    if (!player?.bye || ["D/ST", "K"].includes(player.position)) continue;
    byeCounts.set(player.bye, (byeCounts.get(player.bye) ?? 0) + 1);
  }
  const clusters = [...byeCounts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((left, right) => right[1] - left[1] || left[0] - right[0]);
  elements["roster-alert"].hidden = clusters.length === 0;
  elements["roster-alert"].textContent = clusters.length
    ? `Bye-week load: ${clusters.map(([week, count]) => `Week ${week} has ${count}`).join(" · ")}. This is a visibility warning, not a score penalty.`
    : "";
}

function renderTurnPlan(draftedIds, myHistory) {
  const currentPick = state.history.length + 1;
  const plan = projectUpcomingTurns({ players, draftedIds, myHistory, playersById: sessionPlayersById, league: state.league, weights: state.weights, currentPick, count: 4 });
  elements["turn-plan"].replaceChildren();
  for (const item of plan) {
    elements["turn-plan"].append(createElement("li", {}, [
      createElement("span", { className: "turn-pick", text: `P${item.pick}` }),
      createElement("div", { className: "turn-copy" }, [
        createElement("button", { className: "player-button", text: item.player.name, dataset: { action: "detail", playerId: item.player.id }, attributes: { type: "button" } }),
        createElement("span", { text: `${item.player.position} · ADP ${round(item.market.adp, 1)} · ${sentenceCase(item.reason)}` }),
      ]),
    ]));
  }
  if (!plan.length) elements["turn-plan"].append(createElement("li", {}, createElement("span", { className: "muted", text: "No turns remain." })));
}

function renderResearch() {
  elements["research-list"].replaceChildren();
  const items = [...(research.items ?? [])]
    .sort((left, right) => researchImpactScore(right) - researchImpactScore(left) || right.publishedAt.localeCompare(left.publishedAt))
    .slice(0, 12);
  for (const item of items) {
    const link = createElement("a", { text: item.title, href: item.url, target: "_blank", rel: "noreferrer" });
    elements["research-list"].append(createElement("article", { className: "research-item" }, [
      link,
      item.summary ? createElement("p", { className: "muted compact", text: item.summary }) : null,
      createElement("div", { className: "research-meta" }, [
        createElement("span", { text: item.source }),
        createElement("span", { text: "·" }),
        createElement("span", { text: item.category }),
        item.publishedAt ? createElement("span", { text: `· ${formatDateTime(item.publishedAt)}` }) : null,
        item.confidence ? createElement("span", { text: `· ${item.confidence} confidence` }) : null,
      ]),
    ]));
  }
  if (!items.length) elements["research-list"].append(createElement("p", { className: "muted", text: "No research items are published." }));
}

function researchImpactScore(item) {
  const title = normalizeName(item.title);
  let score = item.team ? 2 : 0;
  const impactTerms = [
    "fantasy", "injur", "pup", "practice", "return", "week 1", "starter", "depth chart",
    "trade", "acquire", "release", "waiver", "roster", "target", "touch", "snap", "quarterback",
  ];
  for (const term of impactTerms) if (title.includes(term)) score += term === "fantasy" ? 8 : 3;
  if (["arrest", "police", "owner", "lawsuit"].some((term) => title.includes(term))) score -= 8;
  if (players.some((player) => {
    const normalized = normalizeName(player.name);
    const surname = normalized.split(" ").at(-1);
    return (normalized.length >= 7 && title.includes(normalized)) || (surname?.length >= 6 && title.includes(surname));
  })) score += 5;
  return score;
}

function renderDraftLog() {
  elements["draft-log"].replaceChildren();
  for (const entry of state.history.slice(-8).reverse()) {
    const player = sessionPlayersById.get(entry.playerId);
    if (!player) continue;
    elements["draft-log"].append(createElement("li", {}, [
      createElement("span", { className: "log-pick", text: `#${entry.pick}` }),
      createElement("div", { className: "log-copy" }, [
        createElement("strong", { text: player.name }),
        createElement("span", { text: `${entry.owner === "mine" ? "My roster" : "Opponent"} · ${player.position} ${player.team ?? "FA"}` }),
      ]),
    ]));
  }
  if (state.history.length === 0) elements["draft-log"].append(createElement("li", { className: "draft-log-empty" }, createElement("span", { className: "muted", text: "No picks recorded yet." })));
}

function renderFreshness() {
  const liveObservations = [
    manifest.observationTimes?.markets,
    manifest.observationTimes?.playerStatus,
    manifest.observationTimes?.headlines,
  ].filter(Boolean);
  const observedAt = liveObservations.sort((a, b) => new Date(a) - new Date(b))[0] ?? manifest.generatedAt;
  const hours = ageInHours(observedAt);
  const degradedSources = manifest.sources.filter((source) => source.freshness?.state === "error");
  const ageState = hours <= 36 ? "ok" : hours <= 72 ? "warn" : "error";
  const stateName = ageState === "ok" && degradedSources.length ? "warn" : ageState;
  const ageLabel = hours < 1 ? "under 1h old" : hours < 48 ? `${Math.round(hours)}h old` : `${Math.floor(hours / 24)}d old`;
  elements["freshness-status"].dataset.state = stateName;
  elements["freshness-status"].textContent = `Data ${ageLabel}`;
  elements["freshness-status"].title = `Oldest live input: ${formatDateTime(observedAt)}${degradedSources.length ? `; degraded: ${degradedSources.map((source) => source.name).join(", ")}` : ""}`;
  freshnessAlert = stateName === "ok" ? null : {
    state: stateName,
    text: ageState === "error"
      ? `Draft warning: core market or player-status inputs are ${ageLabel}. Refresh the research workflow before relying on this board.`
      : ageState === "warn"
        ? `Data check: the oldest live input is ${ageLabel}. Verify time-sensitive player news before drafting.`
        : `${degradedSources.length} headline source${degradedSources.length === 1 ? " is" : "s are"} temporarily degraded. Current ADP and player status still loaded; last-known-good links are labeled in provenance.`,
  };
  renderDataAlert();
  const degradedLabel = degradedSources.length ? ` · ${degradedSources.length} degraded source${degradedSources.length === 1 ? "" : "s"}` : "";
  elements["data-provenance"].textContent = `${manifest.snapshotId} · ${players.length} players · ${manifest.sources.length} attributed sources${degradedLabel} · core inputs ${ageLabel} · assembled ${formatDateTime(manifest.generatedAt)}`;
}

function renderModelExplanation() {
  elements["model-explanation"].replaceChildren();
  const weights = normalizedWeights(state?.weights ?? DEFAULT_WEIGHTS);
  for (const [key, meta] of Object.entries(COMPONENT_META)) {
    elements["model-explanation"].append(createElement("div", { className: "model-item" }, [
      createElement("strong", { text: meta.label }),
      createElement("span", { text: meta.description }),
      createElement("em", { text: `${round(weights[key] * 100, 1)}%` }),
    ]));
  }
}

function statusBadge(player) {
  const injury = player.injuryStatus;
  const status = player.status;
  if (injury) {
    const level = /out|ir|pup|doubt/i.test(injury) ? "bad" : "warn";
    return createElement("span", { className: `tag ${level}`, text: injury });
  }
  if (player.position === "D/ST" && String(status ?? "").toLowerCase() === "unknown") return createElement("span", { className: "tag", text: "Team unit" });
  if (status && String(status).toLowerCase() !== "active") return createElement("span", { className: "tag warn", text: status });
  return createElement("span", { className: "tag good", text: "Clear" });
}

function hasStatusConcern(player) {
  const status = String(player.status ?? "").toLowerCase();
  if (player.position === "D/ST" && status === "unknown" && !player.injuryStatus) return false;
  return Boolean(player.injuryStatus) || Boolean(status && status !== "active");
}

function contextBadges(player) {
  const context = player.scheduleContext;
  const wrapper = createElement("div", { className: "context-stack" });
  if (!context) return wrapper;
  if (context.domeGames) wrapper.append(createElement("span", { className: "tag", text: `${context.domeGames} dome` }));
  if (context.turfGames) wrapper.append(createElement("span", { className: "tag", text: `${context.turfGames} turf` }));
  if (context.shortWeeks) wrapper.append(createElement("span", { className: "tag warn", text: `${context.shortWeeks} short` }));
  if (context.internationalGames) wrapper.append(createElement("span", { className: "tag", text: `${context.internationalGames} intl` }));
  if (context.metadataWarnings?.length) wrapper.append(createElement("span", { className: "tag warn", text: "venue review" }));
  return wrapper;
}

function scoreCell(scored) {
  if (!scored) return createElement("span", { className: "muted", text: "—" });
  return createElement("div", { className: "score-line" }, [
    createElement("strong", { text: scored.score.toFixed(1) }),
    createElement("span", { className: "score-track" }, createElement("span", { className: "score-fill", style: `width:${scored.score}%` })),
  ]);
}

function queueButton(player, queued) {
  return createElement("button", {
    className: `queue-toggle${queued ? " active" : ""}`,
    text: queued ? "★" : "☆",
    dataset: { action: "queue", playerId: player.id },
    attributes: {
      type: "button",
      title: queued ? "Remove from target queue" : "Add to target queue",
      "aria-label": `${queued ? "Remove" : "Add"} ${player.name} ${queued ? "from" : "to"} target queue`,
      "aria-pressed": String(queued),
    },
  });
}

function queueRemoveButton(playerId, playerName) {
  return createElement("button", {
    className: "queue-remove",
    text: "×",
    dataset: { action: "queue", playerId },
    attributes: { type: "button", title: "Remove from target queue", "aria-label": `Remove ${playerName} from target queue` },
  });
}

function handleDelegatedAction(event) {
  const target = event.target.closest("[data-action][data-player-id]");
  if (!target) return;
  const { action, playerId } = target.dataset;
  if (action === "detail") openPlayer(playerId);
  else if (action === "mine" || action === "other") recordPick(playerId, action);
  else if (action === "queue") togglePlayerQueue(playerId);
}

function togglePlayerQueue(playerId) {
  const player = sessionPlayersById.get(playerId) ?? playersById.get(playerId);
  if (!player) return;
  const queued = (state.queue ?? []).includes(playerId);
  const next = toggleQueue(state, playerId);
  if (next === state) {
    toast("The target queue is full. Remove a player before adding another.", "warn");
    return;
  }
  state = next;
  renderAll();
  const message = `${player.name} ${queued ? "removed from" : "added to"} your target queue.`;
  toast(message, "ok");
  announce(message);
}

function recordPick(playerId, owner) {
  const player = playersById.get(playerId);
  if (!player) return;
  const currentPick = state.history.length + 1;
  const totalPicks = state.league.teams * state.league.rounds;
  if (currentPick > totalPicks) {
    toast("The draft is complete. Undo a pick before making another selection.", "warn");
    return;
  }
  const managerTurn = isManagerPick(currentPick, state.league);
  if ((owner === "mine") !== managerTurn) {
    toast(managerTurn ? "This is your scheduled turn; choose Mine." : "This is an opponent turn; choose Taken.", "warn");
    return;
  }
  const scored = scoreById.get(playerId);
  state = addPick(state, {
    playerId,
    owner,
    scoreSnapshot: scored ? { score: scored.score, components: scored.components, weights: state.weights, snapshotId: manifest.snapshotId } : null,
    playerSnapshot: { name: player.name, position: player.position, team: player.team ?? null, bye: player.bye ?? null },
  });
  renderAll();
  const message = `${player.name} marked ${owner === "mine" ? "for your roster" : "taken"} at pick ${currentPick}.`;
  toast(message, "ok");
  announce(message);
}

function handleUndo() {
  const entry = state.history.at(-1);
  if (!entry) return;
  const player = sessionPlayersById.get(entry.playerId);
  state = undoPick(state);
  renderAll();
  toast(`Undid pick ${entry.pick}: ${player?.name ?? entry.playerId}.`, "ok");
}

function handleExport() {
  const date = new Date().toISOString().slice(0, 10);
  downloadJson(`fantasy-war-room-session-${date}.json`, exportSession(state, manifest));
  toast("Draft session exported. It remains local unless you share the file.", "ok");
}

async function handleImport(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    if (file.size > 2_000_000) throw new Error("Import file is too large.");
    const payload = JSON.parse(await file.text());
    const candidate = importSession(payload, buildMarketIdSets());
    const warnings = validateState(candidate, buildMarketIdSets()).warnings;
    const warningSummary = summarizeStateWarnings(warnings);
    const confirmation = `Import ${candidate.history.length} picks and replace the current local session?${warningSummary ? `\n\nWarning: ${warningSummary}` : ""}`;
    if (!confirm(confirmation)) return;
    state = saveState(candidate);
    renderAll();
    toast(warnings.length ? `Draft session imported. ${warningSummary}` : "Draft session imported and validated.", warnings.length ? "warn" : "ok");
  } catch (error) {
    toast(`Import rejected: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

function handleReset() {
  if (!confirm("Reset the full local draft session? Export first if you may need it later.")) return;
  state = resetState();
  clearFilters();
  renderAll();
  toast("Draft session reset.", "ok");
}

function clearFilters() {
  Object.assign(filters, { search: "", position: "ALL", status: "ALL", queueOnly: false, showDrafted: false });
  elements["search-input"].value = "";
  elements["position-filter"].value = "ALL";
  elements["status-filter"].value = "ALL";
  elements["queue-only"].checked = false;
  elements["show-drafted"].checked = false;
  renderTable();
}

function openSettings() {
  fillSettingsForm(state.league, state.weights);
  elements["settings-dialog"].showModal();
}

function fillSettingsForm(league, weights) {
  elements["setting-teams"].value = league.teams;
  elements["setting-slot"].value = Math.min(league.slot, league.teams);
  syncDraftSlotBounds();
  elements["setting-rounds"].value = league.rounds;
  elements["setting-scoring"].value = league.scoring;
  elements["weight-controls"].replaceChildren();
  for (const [key, meta] of Object.entries(COMPONENT_META)) {
    const input = createElement("input", { type: "range", min: 0, max: ["schedule", "splits"].includes(key) ? 5 : 50, step: 1, value: weights[key], dataset: { weight: key }, attributes: { "aria-label": meta.label } });
    const output = createElement("output", { text: String(weights[key]), attributes: { for: `weight-${key}` } });
    input.id = `weight-${key}`;
    input.addEventListener("input", () => { output.textContent = input.value; });
    elements["weight-controls"].append(createElement("label", { className: "weight-control" }, [
      createElement("span", { className: "weight-label" }, [createElement("span", { text: meta.label }), output]),
      input,
    ]));
  }
}

function syncDraftSlotBounds() {
  const teams = Math.min(16, Math.max(8, Number(elements["setting-teams"].value) || 10));
  elements["setting-slot"].max = String(teams);
  if (Number(elements["setting-slot"].value) > teams) elements["setting-slot"].value = String(teams);
}

function restoreSettingsForm() {
  fillSettingsForm(DEFAULT_LEAGUE, DEFAULT_WEIGHTS);
}

function handleSettingsSubmit(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { elements["settings-dialog"].close(); return; }
  const teams = Number(elements["setting-teams"].value);
  const slot = Number(elements["setting-slot"].value);
  const rounds = Number(elements["setting-rounds"].value);
  const scoring = elements["setting-scoring"].value;
  if (!Number.isInteger(teams) || teams < 8 || teams > 16 || !Number.isInteger(slot) || slot < 1 || slot > teams || !Number.isInteger(rounds) || rounds < 10 || rounds > 24) {
    toast("League settings are outside the supported bounds.", "error");
    return;
  }
  if (state.history.length > teams * rounds) {
    toast("The new league would be shorter than the existing draft history.", "error");
    return;
  }
  const marketCount = players.filter((player) => activeMarket(player, scoring)).length;
  if (teams * rounds > marketCount) {
    toast(`${marketCount} players have ${scoring === "ppr" ? "full PPR" : scoring === "half-ppr" ? "half PPR" : "standard"} ADP; reduce teams or rounds to keep the draft completable.`, "error");
    return;
  }
  const structuralChange = teams !== state.league.teams || slot !== state.league.slot || rounds !== state.league.rounds;
  if (state.history.length && structuralChange && !confirm("Changing snake structure after picks are recorded can change which turns belong to you. Keep the history and continue?")) return;
  const weights = { ...DEFAULT_WEIGHTS };
  for (const input of elements["weight-controls"].querySelectorAll("[data-weight]")) weights[input.dataset.weight] = Number(input.value);
  const starterSlots = Object.entries(state.league.roster)
    .filter(([key]) => key !== "bench")
    .reduce((sum, [, value]) => sum + Number(value), 0);
  const roster = { ...state.league.roster, bench: Math.max(0, rounds - starterSlots) };
  const league = { ...state.league, teams, slot, rounds, scoring, roster };
  const proposed = { ...state, league, weights };
  const validation = validateState(proposed, buildMarketIdSets());
  if (!validation.valid) {
    toast(validation.errors[0], "error");
    return;
  }
  state = updateSettings(state, league, weights);
  elements["settings-dialog"].close();
  renderAll();
  toast(`League and model settings updated. ${marketCount} players have this scoring market; context is capped at ${MAX_CONTEXT_SHARE * 100}%.`, "ok");
}

function openPlayer(playerId) {
  const player = sessionPlayersById.get(playerId);
  if (!player) return;
  const scored = scoreById.get(playerId);
  const market = activeMarket(player, state.league.scoring);
  const historyEntry = state.history.find((entry) => entry.playerId === playerId);
  elements["player-dialog-kicker"].textContent = `${player.position} · ${player.team ?? "Free agent"} · Bye ${player.bye ?? "—"}`;
  elements["player-dialog-title"].textContent = player.name;
  elements["player-dialog-content"].replaceChildren();
  const content = elements["player-dialog-content"];
  content.append(createElement("div", { className: "player-summary-grid" }, [
    summaryTile("ADP", market ? round(market.adp, 1) : "—"),
    summaryTile("Market rank", market ? `#${market.rank}` : "—"),
    summaryTile("War score", scored ? scored.score.toFixed(1) : historyEntry?.scoreSnapshot?.score ?? "Drafted"),
    summaryTile("Market sample", market?.timesDrafted ? market.timesDrafted.toLocaleString() : "—"),
  ]));

  if (scored) {
    const list = createElement("div", { className: "component-list" });
    for (const [key, value] of Object.entries(scored.components)) {
      list.append(createElement("div", { className: "component-row" }, [
        createElement("span", { className: "component-label", text: COMPONENT_META[key].label }),
        createElement("span", { className: "component-track" }, createElement("span", { className: "component-fill", style: `width:${value}%` })),
        createElement("span", { className: "component-value", text: value.toFixed(1) }),
      ]));
    }
    content.append(createElement("section", { className: "detail-section" }, [createElement("h3", { text: "Live score breakdown" }), list]));
  } else if (historyEntry?.scoreSnapshot) {
    content.append(createElement("p", { className: "callout", text: `Drafted at pick ${historyEntry.pick} with a ${historyEntry.scoreSnapshot.score} score on snapshot ${historyEntry.scoreSnapshot.snapshotId}.` }));
  }

  const context = player.scheduleContext;
  content.append(createElement("section", { className: "detail-section" }, [
    createElement("h3", { text: "2026 schedule context" }),
    createElement("ul", { className: "detail-list" }, [
      createElement("li", { text: context ? `${context.domeGames} dome/closed-roof, ${context.outdoorGames} outdoor/open-roof, ${context.turfGames} artificial-surface games.` : "Schedule context unavailable." }),
      context ? createElement("li", { text: `${context.shortWeeks} short-rest and ${context.internationalGames} international games; ${context.metadataWarnings?.length ?? 0} venue metadata warnings.` }) : null,
      createElement("li", { text: "These are low-weight exposure signals. Game-day weather is not inferred months in advance." }),
    ]),
  ]));

  content.append(createElement("section", { className: "detail-section" }, [
    createElement("h3", { text: "Status and role signals" }),
    createElement("p", { text: `${player.status ?? "Unknown status"}; ${player.injuryStatus ? `${player.injuryStatus}${player.injuryBodyPart ? ` (${player.injuryBodyPart})` : ""}` : "no current injury flag in the Sleeper snapshot"}. ${player.depthChartOrder ? `Depth order ${player.depthChartOrder}.` : "Depth order unavailable."}` }),
    createElement("p", { className: "muted", text: `Sleeper metadata observed ${formatDateTime(player.statusObservedAt ?? manifest.observationTimes?.playerStatus)}. Verify important changes with an official team or NFL source.` }),
  ]));

  const relatedLinks = relatedResearch(player);
  if (relatedLinks.length) {
    content.append(createElement("section", { className: "detail-section" }, [
      createElement("h3", { text: "Related source links" }),
      createElement("ul", { className: "detail-list source-link-list" }, relatedLinks.map((item) => createElement("li", {}, [
        createElement("a", { text: item.title, href: item.url, target: "_blank", rel: "noreferrer" }),
        createElement("span", { className: "muted", text: ` — ${item.source}, ${formatDateTime(item.publishedAt)}` }),
      ]))),
    ]));
  }

  if (player.splits) {
    content.append(createElement("section", { className: "detail-section" }, [
      createElement("h3", { text: "Historical context sample" }),
      createElement("p", { text: `${player.splits.games ?? 0} games across the available 2023–25 sample. Roof/surface fit confidence: ${round((player.splits.confidence ?? 0) * 100, 0)}%. This is observational and heavily shrunk toward neutral.` }),
    ]));
  }
  elements["player-dialog"].showModal();
}

function relatedResearch(player) {
  const name = normalizeName(player.name);
  const surname = name.split(" ").at(-1);
  return (research.items ?? [])
    .filter((item) => {
      const title = normalizeName(item.title);
      return (name.length >= 7 && title.includes(name)) || (surname?.length >= 6 && title.includes(surname));
    })
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
    .slice(0, 3);
}

function openModel() {
  renderModelExplanation();
  elements["model-dialog"].showModal();
}

function summaryTile(label, value) {
  return createElement("div", { className: "summary-tile" }, [createElement("span", { text: label }), createElement("strong", { text: String(value) })]);
}

function updateOnlineStatus() {
  if (bundleReadFromOfflineCache) {
    setNetworkStatus("warn", "Cached snapshot · draft ready");
    networkAlert = { state: "warn", text: "Cached mode: the verified offline snapshot and your local draft session are ready. Reconnect and reload when practical to check for newer data." };
  } else if (!navigator.onLine) {
    setNetworkStatus("warn", "Offline · draft still works");
    networkAlert = { state: "warn", text: "Offline mode: drafting, queue, undo, and export still work locally. Reconnect before checking for newer player news." };
  } else {
    setNetworkStatus("ok", "Online · saved locally");
    networkAlert = null;
  }
  renderDataAlert();
}

function renderDataAlert() {
  const alerts = [freshnessAlert, networkAlert].filter(Boolean);
  elements["data-alert"].hidden = alerts.length === 0;
  if (!alerts.length) return;
  elements["data-alert"].dataset.state = alerts.some((alert) => alert.state === "error") ? "error" : "warn";
  elements["data-alert"].textContent = alerts.map((alert) => alert.text).join(" ");
}

function setNetworkStatus(status, text) {
  elements["network-status"].dataset.state = status;
  elements["network-status"].textContent = text;
}

function handleStorageUpdate(event) {
  if (event.key !== STORAGE_KEY || !event.newValue) return;
  const loaded = loadState(buildMarketIdSets());
  state = loaded.state;
  renderAll();
  toast(loaded.warnings.length ? `Draft state updated. ${summarizeStateWarnings(loaded.warnings)}` : "Draft state updated from another tab.", loaded.warnings.length ? "warn" : "ok");
}

function handleKeyboard(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement || document.querySelector("dialog[open]")) return;
  if (event.key === "/") {
    event.preventDefault();
    elements["search-input"].focus();
  } else if (event.key.toLowerCase() === "u" && state.history.length) handleUndo();
  else if (event.key.toLowerCase() === "m" && ranked[0] && isManagerPick(state.history.length + 1, state.league)) recordPick(ranked[0].player.id, "mine");
  else if (event.key.toLowerCase() === "d" && ranked[0] && !isManagerPick(state.history.length + 1, state.league)) recordPick(ranked[0].player.id, "other");
}

function toast(message, status = "neutral") {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.visible = "true";
  elements.toast.dataset.status = status;
  toastTimer = setTimeout(() => { elements.toast.dataset.visible = "false"; }, 4200);
}

function announce(message) {
  elements["live-region"].textContent = "";
  requestAnimationFrame(() => { elements["live-region"].textContent = message; });
}

function sentenceCase(value) {
  const text = String(value ?? "");
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  try {
    await navigator.serviceWorker.register("./sw.js", { scope: "./" });
  } catch (error) {
    console.warn("Offline cache registration failed", error);
  }
}

bootstrap();
