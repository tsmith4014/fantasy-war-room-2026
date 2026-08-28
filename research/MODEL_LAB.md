# Environment and draft model lab

Generated 2026-08-28T02:06:56.377Z from nflverse weekly player/schedule observations and the current published draft pool. This is a reproducible diagnostic, not a claim that weather causes fantasy outcomes.

## Walk-forward design

- Target: weekly full-PPR fantasy points for QB/RB/WR/TE.
- Baseline: each player's prior-season PPR/game, falling back to the prior-season position average.
- Training/selection: 2023 trains hyperparameters; 2024 selects them; 2023–24 refits; 2025 is untouched until final evaluation.
- Context features: roof, surface, rest, recorded outdoor temperature/wind, and position interactions. No future schedule field or 2025 target enters training.
- Precipitation is not fitted: nflverse does not supply historical game precipitation. NASA precipitation remains a clearly labeled venue climate normal with zero direct model weight.

## Held-out 2025 results

| Model | MAE | RMSE | MAE change vs baseline | RMSE change vs baseline |
| --- | ---: | ---: | ---: | ---: |
| Prior-season player baseline | 5.174 | 6.83 | — | — |
| Ridge roof/surface/rest only (lambda 1000) | 5.075 | 6.782 | 1.91% | 0.7% |
| Ridge plus recorded temperature/wind (lambda 1000) | 5.072 | 6.777 | 1.97% | 0.78% |
| Boosted-stump residual model (5 rounds) | 5.072 | 6.781 | 1.97% | 0.72% |

Recorded temperature/wind improved the ridge ablation by 0.06% MAE and 0.07% RMSE, while both context techniques beat the baseline. The app may retain a tiny, sample-guarded environment contribution.

Largest ridge context coefficients after the player baseline (directional, not causal):

- dome: 0.256
- wind centered at 10 mph: -0.2029
- short rest: 0.1998
- QB x wind: -0.1741
- WR x wind: 0.1371
- QB x temperature: 0.1309

Coverage: 17,702 modeled weekly rows; 11,665 train/refit rows; 6,037 held-out 2025 rows.

## Randomized mock-draft stress test

90 seeded drafts covered every slot in 10-team, 16-round PPR, half-PPR, and standard leagues. Opponent picks sample around ADP instead of following one deterministic script.

| Invariant / outcome | Result |
| --- | ---: |
| Complete starting rosters | 90 / 90 |
| Drafts with a third QB | 0 |
| Drafts with a third TE | 0 |
| Drafts with duplicate D/ST | 0 |
| Drafts with duplicate K | 0 |
| Severe-risk manager selections | 0 |
| Worst same-bye cluster | 6 |
| Mean pick-minus-ADP value | 5.59 picks |

## Guardrails retained

- NASA monthly temperature, precipitation, and wind are climate normals, never game forecasts.
- CPC categories are kept as issued; the model does not invent an exact temperature or rain chance from them.
- NWS/MET forecasts appear only inside their documented horizon and are not substituted when absent.
- Surface, weather, travel, rest, and personal splits share a maximum 5% score contribution.
- Market lines are sparse snapshots and remain low-weight context, not season projections or betting advice.
