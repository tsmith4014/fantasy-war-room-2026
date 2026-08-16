# Working Agreement

## Product State

- `main` is the integration and GitHub Pages branch. Start non-trivial changes
  from an up-to-date `main` and use one focused branch per change.
- The production artifact is a static site built from `site/` into `dist/`.
  GitHub Pages cannot run a Python, Node, or other application server.
- All browser paths must be repository-relative so the site works at
  `/fantasy-war-room-2026/`, not only at a domain root.
- Draft sessions are local-first and versioned. Never send league settings,
  draft history, notes, or imports to a third party.
- The 2026 default is a 10-team, full-PPR, 16-round snake league. Preserve
  editable league settings and do not bake this preset into scoring logic.

## Required Checks

Run the complete local gate before merging application, data, or workflow
changes:

```sh
npm run check
```

Run a production build and serve `dist/` before UI-sensitive changes are
merged. Verify at minimum: loading, search/filter, draft/taken actions, undo,
roster assignment, settings, JSON export/import, keyboard navigation, offline
status messaging, mobile layout, and the repository subpath.

Data changes must pass schema, uniqueness, attribution, freshness, and bounds
checks. A failed upstream fetch must leave the last known-good snapshot intact.

## Deployment and Cost Rules

- Deploy only through the checked-in GitHub Pages workflow or an explicitly
  authorized manual equivalent.
- Use public GitHub Pages and standard GitHub-hosted runners only. Never select
  a larger runner, paid API, paid data feed, cloud service, billing change, or
  marketplace action that can incur cost without the user's explicit approval.
- Keep scheduled jobs bounded with concurrency and timeouts. Do not upload
  long-lived build artifacts or caches unless they are demonstrably needed.
- Automated research refreshes must propose a reviewable pull request. They may
  not silently overwrite rankings on `main`.
- Never deploy secrets to Pages. Browser-delivered files, build output, logs,
  and public repository history must be treated as public.

## Data and Research Rules

- Store source observations separately from derived scores. Every published
  snapshot needs a source URL, retrieval time, terms/attribution note, and
  freshness state.
- Prefer official NFL/team sources and explicitly reusable public APIs. Do not
  scrape or redistribute proprietary rankings, paywalled material, or full
  article text.
- Fantasy Football Calculator ADP may be refreshed at most once per day and
  must be attributed. Sleeper data is for this personal, non-commercial tool;
  request its all-player endpoint at most once per day.
- News digests may link to and briefly summarize sources. Do not copy article
  bodies. Keep feed content unmodified where a feed's terms require it.
- Injury, depth-chart, and transaction fields are observations, not medical or
  official roster guarantees. Display source and age prominently.
- Weather forecasts are only credible near game day. Do not fabricate future
  temperatures or winds, and do not substitute historical averages for a live
  forecast without labeling them.

## Model Constraints

- Keep recommendation components visible and user-adjustable. Projection/market
  value, roster need, positional scarcity, and next-pick availability should
  dominate small context modifiers.
- Weather, roof, surface, travel, rest, and historical splits are contextual
  signals with sample-size confidence. Cap their combined draft-score effect and
  never present correlation as causation.
- Never turn an injury label into a diagnosis or a guaranteed return date.
- Stable player IDs are authoritative; names are display data and may change.
- Preserve a deterministic audit trail for every draft action and score.

## Engineering and Safety Constraints

- Use DOM APIs and event delegation for external data. Do not interpolate player
  names or research text into inline JavaScript or unsanitized HTML.
- Validate imported JSON before replacing a draft session. Recover gracefully
  from malformed local storage and retain an undoable history.
- Avoid runtime dependencies unless they materially improve the product. Pin
  GitHub Actions to reviewed major versions and keep workflow permissions at
  least privilege.
- Use `apply_patch` for source and documentation edits. Do not discard unrelated
  user changes.
