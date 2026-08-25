const CORE_OBSERVATIONS = Object.freeze(["markets", "playerStatus", "trends"]);
const REQUIRED_MARKET_WINDOWS = Object.freeze(["ppr", "halfPpr", "standard"]);

export function assessDraftReadiness(manifest, { now = new Date(), maxCoreAgeHours = 36 } = {}) {
  const errors = [];
  const warnings = [];
  const ages = {};
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("Readiness clock is invalid");

  for (const key of CORE_OBSERVATIONS) {
    const observedAt = manifest?.observationTimes?.[key];
    const observedMs = Date.parse(observedAt);
    if (!Number.isFinite(observedMs)) {
      errors.push(`${key} observation time is missing or invalid`);
      continue;
    }
    const ageHours = (nowMs - observedMs) / 3_600_000;
    ages[key] = ageHours;
    if (ageHours < -1) errors.push(`${key} observation is unexpectedly in the future`);
    else if (ageHours > maxCoreAgeHours) errors.push(`${key} observation is ${ageHours.toFixed(1)} hours old (maximum ${maxCoreAgeHours})`);
  }

  for (const format of REQUIRED_MARKET_WINDOWS) {
    const window = manifest?.marketWindows?.[format];
    const marketEndMs = Date.parse(`${window?.endDate ?? ""}T23:59:59.999Z`);
    if (!Number.isFinite(marketEndMs)) {
      errors.push(`${format} market window end date is missing or invalid`);
      continue;
    }
    const lagHours = (nowMs - marketEndMs) / 3_600_000;
    ages[`marketWindow:${format}`] = Math.max(0, lagHours);
    if (lagHours < -25) errors.push(`${format} market window ends unexpectedly in the future`);
    else if (lagHours > 48) errors.push(`${format} market window ended ${lagHours.toFixed(1)} hours ago (maximum 48)`);
  }

  const degraded = (manifest?.sources ?? []).filter((source) => source?.freshness?.state === "error");
  if (degraded.length) warnings.push(`${degraded.length} source${degraded.length === 1 ? " is" : "s are"} degraded: ${degraded.map((source) => source.name).join(", ")}`);

  const stale = (manifest?.sources ?? []).filter((source) => source?.freshness?.state === "stale");
  if (stale.length) warnings.push(`${stale.length} source${stale.length === 1 ? " is" : "s are"} explicitly stale: ${stale.map((source) => source.name).join(", ")}`);

  const mislabeledFresh = (manifest?.sources ?? []).filter((source) => {
    if (source?.freshness?.state !== "fresh") return false;
    const retrievedMs = Date.parse(source.retrievedAt);
    const maxAgeHours = Number(source?.freshness?.maxAgeHours);
    return Number.isFinite(retrievedMs) && Number.isFinite(maxAgeHours) && (nowMs - retrievedMs) / 3_600_000 > maxAgeHours;
  });
  if (mislabeledFresh.length) warnings.push(`${mislabeledFresh.length} source${mislabeledFresh.length === 1 ? " has" : "s have"} exceeded declared freshness: ${mislabeledFresh.map((source) => source.name).join(", ")}`);

  return { ready: errors.length === 0, errors, warnings, ages };
}
