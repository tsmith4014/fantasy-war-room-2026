# Operations

## Workflows

- `ci.yml`: validates source/data/tests/build on pull requests and manual runs.
- `pages.yml`: validates freshness during draft season, builds, and deploys the
  static site from `main`. It is the single main-push validation/deploy job.
- `refresh-data.yml`: runs off the top of the hour, validates a compact refresh,
  and opens or updates `automation/data-refresh` for review. Because GitHub does
  not automatically run ordinary `pull_request` workflows for a pull request
  opened by `GITHUB_TOKEN`, the refresh workflow explicitly dispatches `ci.yml`
  against that branch after it pushes the candidate snapshot.

All jobs use the one-CPU standard `ubuntu-slim` runner, pin actions to reviewed
commit SHAs, have explicit timeouts, avoid caches and retained general-purpose
artifacts, and use least-privilege permissions. The repository is public, so
this standard runner is free; no premium/larger runner is configured.

## Refresh review

Before merging a refresh pull request:

1. Read `research/CONTEXT.md` for source failures, status changes, ADP movers,
   stale data, and new linked headlines.
2. Confirm player count and identity-match warnings are plausible.
3. Spot-check high-impact injury/team changes against the linked official source.
4. Run `npm run draft:ready` locally or wait for CI. This includes the complete
   source/data/test/build gate and rejects core observations older than 36 hours.
5. Merge only if the generated diff is coherent; the last good Pages snapshot
   remains live until then.

## Failure modes

- A core upstream fetch or schema failure exits non-zero before replacing data.
- Optional RSS and NOAA requests use bounded retries. A failed attempt that
  contributes no observation is logged but is not advertised as an active
  attributed source.
- A malformed/blocked RSS feed may carry forward only its own labeled
  last-known-good links. A publisher-scheduled headline more than one hour ahead
  is skipped individually, while valid current items from that feed remain
  usable. Source timestamps are never silently clamped or rewritten.
- A partial refresh is rejected; temporary files are not published.
- If Actions cannot open a pull request because repository settings deny it, the
  generated branch remains reviewable and the job fails before anything reaches
  `main`; restore the setting and rerun the workflow.
- Scheduled workflows can be delayed and may be disabled after prolonged public
  repository inactivity. `workflow_dispatch` is always available for a manual
  refresh.

For an optional news/schedule/weather update that must not spend the daily FFC/Sleeper
request budget, run:

```sh
npm run data:refresh:context
```

This reuses the last published player/status/ADP observations, then rebuilds the
linked headline inbox, schedule, climate, outlook, in-horizon forecast, and
market context atomically. `data:refresh:environment` is retained as an alias.

## Draft-season switch

The repository variable `DRAFT_REFRESH_ENABLED` controls scheduled refreshes and
the Pages freshness gate. Keep it `true` through the draft. Set it to `false`
after the draft to make scheduled events skip before a runner is allocated;
manual refresh dispatches remain available.

To fully disable the workflow after the draft, run:

```sh
gh workflow disable refresh-data.yml --repo tsmith4014/fantasy-war-room-2026
```

`gh workflow disable` turns off the named workflow. `--repo` selects this
repository explicitly, so the command is safe to run from another directory.
Re-enable it with the corresponding `gh workflow enable` command before any
future refresh period.
