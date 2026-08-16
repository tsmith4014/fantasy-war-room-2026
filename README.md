# 2026 Fantasy Draft War Room

A local-first draft assistant built for a 10-team, full-PPR ESPN-style snake
draft and designed to run entirely on GitHub Pages. It combines current ADP,
player status, roster need, positional scarcity, next-pick availability, and
small, confidence-capped schedule/environment signals in an auditable score.

The supplied FastAPI/Excel prototype was used as product research. This repo is
a clean static rebuild: there is no paid backend, no browser secret, and no
redistributed proprietary top-300 dataset.

## What the war room does

- Recommends the best available players for the current pick and explains every
  score component.
- Tracks players drafted by you or opponents, assigns your roster, advances the
  board, and calculates the next snake pick.
- Filters by position and injury/status, with player/team search.
- Shows market confidence, ADP value, bye weeks, source freshness, venue/surface
  exposure, short-rest/international context, and historical split sample sizes.
- Supports undo, keyboard shortcuts, versioned local persistence, cross-tab
  updates, and JSON import/export.
- Includes an ongoing research digest and a review-first scheduled refresh.
- Works offline after the first successful visit.
- Publishes the enhanced, formula-driven Excel workbook as a direct download.

## Local development

Requires Node.js 20.11 or newer; there are no npm runtime dependencies.

```sh
npm run check
npm run serve
```

Open `http://localhost:4173/fantasy-war-room-2026/` after the server starts.

## Data refresh

```sh
npm run data:refresh
```

The refresh fetches Fantasy Football Calculator ADP once per scoring format,
Sleeper player/status metadata once, current Sleeper trends, the nflverse 2026
schedule, all 32 official club RSS feeds, and ESPN's NFL RSS feed. It validates
the result before atomically replacing the published snapshot.
`npm run data:refresh:history` additionally rebuilds three-season
roof/surface/rest split summaries from nflverse weekly stats.

See [data sources](docs/DATA_SOURCES.md), [model design](docs/MODEL.md),
[operations](docs/OPERATIONS.md), and the [source audit](docs/SOURCE_AUDIT.md).

## Cost boundary

The public Pages site and checked-in workflows use standard GitHub-hosted Linux
runners, which GitHub documents as free for public repositories. The workflows
use no paid APIs, larger runners, LLM calls, caches, or retained build artifacts.
Any future paid service requires explicit approval before it is added or used.

## Disclaimer

Fantasy recommendations are uncertain decision support, not guarantees. Injury
and depth-chart fields can lag official announcements. Weather forecasts are not
used outside a credible forecast horizon. Always check the linked source before
making a time-sensitive decision.
