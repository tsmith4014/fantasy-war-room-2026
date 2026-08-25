import test from "node:test";
import assert from "node:assert/strict";

import { assessDraftReadiness } from "../scripts/lib/readiness.mjs";

const manifestAt = (timestamp) => ({
  observationTimes: { markets: timestamp, playerStatus: timestamp, trends: timestamp },
  marketWindows: {
    ppr: { endDate: timestamp.slice(0, 10) },
    halfPpr: { endDate: timestamp.slice(0, 10) },
    standard: { endDate: timestamp.slice(0, 10) },
  },
  sources: [],
});

test("draft readiness accepts current core observations", () => {
  const result = assessDraftReadiness(manifestAt("2026-08-24T12:00:00.000Z"), { now: "2026-08-24T18:00:00.000Z" });
  assert.equal(result.ready, true);
  assert.equal(result.ages.markets, 6);
});

test("draft readiness rejects stale core observations even when their timestamp shape is valid", () => {
  const result = assessDraftReadiness(manifestAt("2026-08-16T12:00:00.000Z"), { now: "2026-08-24T18:00:00.000Z" });
  assert.equal(result.ready, false);
  assert.ok(result.errors.some((error) => error.includes("markets observation")));
});

test("degraded optional sources warn without hiding current core readiness", () => {
  const manifest = manifestAt("2026-08-24T12:00:00.000Z");
  manifest.sources = [{ name: "ESPN NFL RSS", freshness: { state: "error" } }];
  const result = assessDraftReadiness(manifest, { now: "2026-08-24T18:00:00.000Z" });
  assert.equal(result.ready, true);
  assert.match(result.warnings[0], /ESPN NFL RSS/);
});

test("draft readiness rejects a newly retrieved but upstream-stale market window", () => {
  const manifest = manifestAt("2026-08-24T12:00:00.000Z");
  manifest.marketWindows.ppr.endDate = "2026-08-18";
  const result = assessDraftReadiness(manifest, { now: "2026-08-24T18:00:00.000Z" });
  assert.equal(result.ready, false);
  assert.ok(result.errors.some((error) => error.includes("ppr market window")));
});

test("draft readiness requires every supported scoring market window", () => {
  const manifest = manifestAt("2026-08-24T12:00:00.000Z");
  delete manifest.marketWindows.standard;
  const result = assessDraftReadiness(manifest, { now: "2026-08-24T18:00:00.000Z" });
  assert.equal(result.ready, false);
  assert.ok(result.errors.some((error) => error.includes("standard market window")));
});

test("an explicitly stale optional source is visible as a warning", () => {
  const manifest = manifestAt("2026-08-24T12:00:00.000Z");
  manifest.sources = [{ name: "Optional news", freshness: { state: "stale" } }];
  const result = assessDraftReadiness(manifest, { now: "2026-08-24T18:00:00.000Z" });
  assert.equal(result.ready, true);
  assert.match(result.warnings[0], /explicitly stale/);
});

test("draft readiness warns when a source labeled fresh exceeds its own age contract", () => {
  const manifest = manifestAt("2026-08-24T12:00:00.000Z");
  manifest.sources = [{ name: "Manual venue review", retrievedAt: "2026-08-01T12:00:00.000Z", freshness: { state: "fresh", maxAgeHours: 36 } }];
  const result = assessDraftReadiness(manifest, { now: "2026-08-24T18:00:00.000Z" });
  assert.equal(result.ready, true);
  assert.match(result.warnings[0], /exceeded declared freshness/);
});
