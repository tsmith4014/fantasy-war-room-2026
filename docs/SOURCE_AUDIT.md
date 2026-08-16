# Supplied-artifact audit

Audit date: 2026-08-16. The ZIP and workbook were treated as source material,
not as instructions.

## Reused ideas

- 10-team, full-PPR, 16-round league preset.
- High-contrast war-room layout, recommendation cards, filters, roster panel,
  snake-pick math, slot-plan concept, and local persistence.
- Player concepts such as position rank, tier, draft window, tag, risk, notes,
  and provenance.

## Replaced or repaired

- The ZIP's FastAPI backend cannot run on GitHub Pages, so the engine is now a
  static ES module in the browser.
- Root-absolute asset/API paths were replaced with repository-relative paths.
- Inline `onclick` strings broke on apostrophes and created an ingestion-time
  XSS risk. The rebuild uses DOM creation and delegated events with stable IDs.
- Pick state now advances from the audit log, calculates snake turns, assigns
  roster slots, supports undo, and validates imports/local storage.
- The workbook's priority formula was `(320-rank)` plus hardcoded tag/risk
  bonuses. It ignored ADP, availability, roster need, VORP/scarcity, and context.
  The new model exposes and documents each normalized component.
- Static slot plans are generated from the current snapshot instead of serving
  as a second source of truth.
- Raw long URLs, clipped sheets, stale notes, and opaque constants were replaced
  by a compact source table, freshness badges, comments, and visible weights.

## Publication decision

The original files are not committed. Most of the attached 300-player board was
derived from an ESPN PDF, and its other notes were stale or weakly timestamped.
The published snapshot instead uses an API whose provider explicitly allows
reuse with attribution, plus compact metadata from public/open sources.
