import { cleanUntrustedText } from "./rss.mjs";

const TEAM_ALIASES = Object.freeze({
  LA: "LAR", STL: "LAR", OAK: "LV", SD: "LAC", JAC: "JAX", WSH: "WAS",
});

export function canonicalTeam(value) {
  const raw = cleanUntrustedText(value, 8).toUpperCase();
  const team = TEAM_ALIASES[raw] ?? raw;
  return !team || team === "FA" ? null : team;
}

export function canonicalBye(team, value, label = "player bye") {
  if (!team) return null;
  const bye = Number(value);
  if (!Number.isInteger(bye) || bye < 1 || bye > 18) throw new Error(`${label} is outside 1..18`);
  return bye;
}
