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
| Schedule + market | 2 | Dome/outdoor stability, short weeks, international exposure, and a bounded team market pulse |
| Personal environment | 1 | Sample-capped roof/surface/cold/wind historical delta |

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
- On the manager's turn, quarterbacks and tight ends are capped at the
  configured starters plus one reserve. They remain visible on opponent turns,
  preventing accidental third-QB/third-TE builds without breaking Taken flow.
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
  Available nflverse spread/total observations add only a small 40–60 bounded
  market-pulse input inside this same context component.
- Personal environment only activates with adequate samples on both sides and
  is shrunk toward neutral. The available 2023–25 sample includes roof, surface,
  recorded cold/mild, and recorded windy/calm comparisons. Raw counts remain
  visible in player details.
- NASA average temperature/precipitation and NOAA outlooks are exposed as
  schedule evidence. They do not receive a standalone score. NASA precipitation
  is an average amount, not rain probability; game forecasts replace neither the
  normal nor the outlook and appear only inside provider horizons.
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

## Validation result

`npm run model:lab` performs a chronological 2022–25 nflverse experiment rather
than fitting on future information. On the 2025 holdout, adding recorded
temperature and wind to the structural ridge model improved MAE by only about
0.06% and RMSE by about 0.07%; a boosted residual-stump model did not materially
improve that result. Historical precipitation is not present in the nflverse
schedule sample, so it has zero direct model weight. This evidence supports
showing weather context while keeping its draft-score effect tiny.

The same lab runs 90 deterministic randomized draft scenarios across all 10
slots and PPR, half-PPR, and standard markets. The current model completed every
required starter set with no third quarterback/tight end, duplicate kicker or
defense, or severe-risk manager pick in that suite. These are regression checks,
not a claim that the model can predict the season.
