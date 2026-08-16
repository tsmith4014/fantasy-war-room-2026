# Operations

## Workflows

- `ci.yml`: validates source/data/tests/build on pushes and pull requests.
- `pages.yml`: builds and deploys the static site from `main`.
- `refresh-data.yml`: runs off the top of the hour, validates a compact refresh,
  and opens or updates `automation/data-refresh` for review.

All jobs use standard `ubuntu-latest`, pin actions to reviewed commit SHAs, have
explicit timeouts, avoid caches and retained general-purpose artifacts, and use
least-privilege permissions.

## Refresh review

Before merging a refresh pull request:

1. Read `research/CONTEXT.md` for source failures, status changes, ADP movers,
   stale data, and new linked headlines.
2. Confirm player count and identity-match warnings are plausible.
3. Spot-check high-impact injury/team changes against the linked official source.
4. Run `npm run check` locally or wait for CI.
5. Merge only if the generated diff is coherent; the last good Pages snapshot
   remains live until then.

## Failure modes

- An upstream fetch or schema failure exits non-zero before replacing data.
- A partial refresh is rejected; temporary files are not published.
- If Actions cannot open a pull request because repository settings deny it, the
  generated branch remains reviewable and the job summary names the recovery
  command.
- Scheduled workflows can be delayed and may be disabled after prolonged public
  repository inactivity. `workflow_dispatch` is always available for a manual
  refresh.
