# Draft-day checklist

Use one browser tab as the authoritative draft board. A second tab is useful for
read-only reference, but simultaneous edits can race because the session remains
private in browser storage.

## Before the room opens

1. Confirm the header says the core data is no more than 36 hours old. If it is
   older, run the manual refresh workflow and review its pull request.
2. Open Settings and match teams, draft slot, rounds, and reception scoring to
   the real league. Make this change before recording picks.
3. Star priority targets into **My target queue**. Queued targets lead the visible
   shortlist, but their displayed war scores remain unchanged.
4. Export an empty configured session as a backup, then keep the Pages tab open
   once so the offline bundle is warm.
5. Keep an official league draft window beside the war room. This app assists
   decisions; the league platform remains the authoritative pick record.

## During the draft

- Use **Mine** only when the turn indicator says you are on the clock; use
  **Taken** for every opponent pick. The app enforces snake ownership.
- If a pick is entered incorrectly, use **Undo** immediately. Keyboard shortcuts
  are `/` for search, `U` for undo, `M` for the top option on your turn, and `D`
  for the top option on an opponent turn.
- Export a checkpoint every few rounds. Draft history, target queue, and settings
  stay only in the browser unless you export the JSON file.
- Treat red/yellow status badges as alerts, not medical conclusions. Verify any
  consequential late news with an official team or NFL source.

## After the draft

1. Export the completed session for the audit trail.
2. Set the repository variable `DRAFT_REFRESH_ENABLED` to `false`, or disable the
   `refresh-data.yml` workflow, so scheduled work stops before allocating a runner.
3. Leave Pages enabled if you want the static draft recap; it has no backend or
   paid runtime.
