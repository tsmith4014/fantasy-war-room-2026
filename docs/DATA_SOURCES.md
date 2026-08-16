# Data sources and provenance

Every published snapshot records retrieval time and source URL in
`site/data/manifest.json`. Upstream data is normalized and validated before use.

| Source | Use | Terms / cadence | Guardrail |
| --- | --- | --- | --- |
| [Fantasy Football Calculator ADP API](https://help.fantasyfootballcalculator.com/article/42-adp-rest-api) | Current ADP, mock sample, range, volatility, bye | Free for personal/commercial use; attribution requested; updates daily | Fetch at most daily; display attribution |
| [Sleeper API](https://docs.sleeper.com/) | Player IDs, active/team/depth/injury labels, trends | Public read-only API for this personal non-commercial tool | Fetch all players at most daily; label status as Sleeper-sourced |
| [nflverse](https://github.com/nflverse/nflverse-data) | 2026 schedule, roof, surface, rest; 2023-25 statistical splits | CC BY 4.0 | Attribute; preserve sample counts; no causal claims |
| [Official NFL club sites](https://support.nfl.com/hc/en-us/articles/40080288031380-What-are-the-official-websites-of-all-NFL-teams) | All 32 club RSS feeds for linked team news | Official domains; RSS path is documented by the [49ers](https://www.49ers.com/news/rss-feeds) | Validate status/type each run; store title/link/date only |
| [ESPN NFL RSS](https://www.espn.com/espn/news/story?page=rssinfo) | Linked headlines in the research inbox | Syndication terms require unmodified feed content, attribution, and links | Store titles/links only; no ads or article copying |
| [NFL schedules](https://www.nfl.com/schedules) | Official schedule cross-check | Official public reference | Prefer official fact over third-party disagreement |
| [NFL international games](https://operations.nfl.com/programs-initiatives/international-growth/nfl-international-games) | International/travel context | Official public reference | Treat exact travel as approximate without itineraries |
| [National Weather Service API](https://www.weather.gov/documentation/services-web-api) | Future US game forecasts inside 7 days | US government open data; User-Agent required | Never fabricate longer-range forecasts |
| [MET Norway](https://api.met.no/) | International weather fallback | Free worldwide use with attribution, identifying User-Agent, and respectful caching | Use only inside its forecast horizon; retain model time |

## Known limitations

- Sleeper injury and depth fields are useful alerts, not official medical advice.
- nflverse's dedicated injury feed is not current for 2025 onward; it is not used.
- Historical roof/surface splits are observational and confounded by role,
  opponent, team changes, and small samples.
- nflverse 2026 venue metadata contains inherited errors for international games
  and the new Buffalo stadium. Effective-dated overrides and warnings are part
  of the published schedule context; `location=Neutral` is not an international
  detector.
- Market ADP is not a projection. It represents how mock-draft participants
  selected players during the provider's stated sample window.
- RSS headlines are an inbox, not an automatically interpreted injury signal.
- FantasyPros is excluded from automation because its free API key is expressly
  non-production and paid access would violate this project's approval gate.
