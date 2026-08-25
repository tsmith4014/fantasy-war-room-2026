# Recommendation model

The model answers a narrow question: **given the current pick, roster, available
pool, and next snake turn, who deserves attention now?** It is deterministic and
recalculates in the browser after every action.

## Default components

| Component | Default weight | Meaning |
| --- | ---: | --- |
| Market quality | 34 | Inverse ADP percentile among draftable players |
| Pick value | 16 | How far a player has fallen relative to the current pick |
| Roster need | 15 | Unfilled starters, flex pressure, and bench balance |
| Positional scarcity | 12 | Drop from this player to likely alternatives at the next turn |
| Next-pick urgency | 10 | Estimated chance the player is gone before your next pick |
| Role signal | 6 | Current team/depth/activity metadata, with conservative bounds |
| Availability risk | 4 | Status/injury penalty; never a diagnosis |
| Schedule context | 2 | Dome/outdoor stability, short weeks, and international exposure |
| Personal splits | 1 | Sample-capped roof/surface historical delta |

Weights are editable and normalized at runtime. Context is 3% by default and
hard-capped at 5%. A player should not jump tiers because of surface or a distant
weather hypothesis.

## Component behavior

- Scores are normalized to 0–100 before weighting.
- Pick value rewards a fall and penalizes a reach over roughly three rounds.
- Next-pick urgency uses ADP standard deviation and the user's next snake pick;
  it is an estimate, not a true probability model.
- Scarcity compares remaining players at the same position near the next pick.
- Roster need respects starter counts, FLEX eligibility, and a balanced bench.
- Third quarterbacks and tight ends receive no added need credit after the
  configured starter plus one reserve, while remaining available for unusual
  league strategies.
- Kicker and defense are delayed until late, duplicates are suppressed on the
  manager's turn, and every exact starter becomes mandatory at the last
  mathematically safe turns so supported league sizes finish with a complete roster.
- PUP, IR, Out, Doubtful, Inactive, NFI, and suspended players stay visible for
  deliberate review but do not lead the generic shortlist or turn projection
  while a safe alternative exists. Explicitly queueing one remains a user override.
- Three or more non-kicker/non-defense players sharing a bye week triggers a
  visible roster warning. It does not secretly change scores.
- Schedule context considers the team's published 2026 roof/surface/rest profile
  after effective-dated venue overrides. International games are detected from
  the official game list and venue identity, not the schedule `location` flag.
- Personal splits only activate with adequate samples on both sides and are
  shrunk toward neutral. Raw samples remain visible in player details.
- Venue surface is descriptive by default. The NFL's league-wide analysis does
  not justify a generic turf penalty, so any personal split remains tiny until
  walk-forward testing shows repeatable value.

## Auditability

Every recommendation exposes its component values, normalized weights, source
freshness, and a short explanation. Draft actions store the score breakdown that
was visible when the action happened, so a later data refresh does not rewrite
the historical decision.
The local target queue can move a personally starred player into the visible
shortlist, but it never changes that player's component values or war score and
cannot hide a starter that is mandatory on the current last-safe turn.
