import { cleanUntrustedText, parseRssHeadlines } from "./rss.mjs";

export function feedSourceId(feed) {
  return feed.espn ? "rss-espn" : `rss-team-${String(feed.team).toLowerCase()}`;
}

function priorHeadlines(feed, priorResearch) {
  const sourceId = feedSourceId(feed);
  const limit = feed.espn ? 15 : 3;
  return (priorResearch?.items ?? [])
    .filter((item) => item?.sourceId === sourceId)
    .slice(0, limit)
    .map((item) => ({
      title: cleanUntrustedText(item.title, 280),
      url: item.url,
      publishedAt: item.publishedAt,
    }))
    .filter((item) => item.title && item.url && !Number.isNaN(Date.parse(item.publishedAt)));
}

function safeError(error) {
  return cleanUntrustedText(error instanceof Error ? error.message : String(error), 360) || "Unknown feed error";
}

/**
 * A publisher feed is useful context, but it must never block current ADP,
 * player-status, trend, or schedule observations. Each feed is isolated and a
 * failed source carries forward only its own last-known-good linked headlines.
 */
export async function fetchFeedSet(feeds, { fetchText, priorResearch = null } = {}) {
  if (typeof fetchText !== "function") throw new Error("fetchFeedSet requires a fetchText function");

  const results = await Promise.all(feeds.map(async (feed) => {
    let response;
    try {
      response = await fetchText(feed.url);
      const headlines = parseRssHeadlines(response.text, {
        expectedHosts: [feed.domain],
        limit: feed.espn ? 15 : 3,
      });
      return {
        feed,
        headlines,
        finalUrl: response.finalUrl ?? feed.url,
        contentType: cleanUntrustedText(response.contentType, 160),
        usedFallback: false,
        error: null,
      };
    } catch (error) {
      return {
        feed,
        headlines: priorHeadlines(feed, priorResearch),
        finalUrl: response?.finalUrl ?? feed.url,
        contentType: cleanUntrustedText(response?.contentType, 160),
        usedFallback: true,
        error: safeError(error),
      };
    }
  }));

  return {
    results,
    failures: results.filter((result) => result.error),
  };
}
