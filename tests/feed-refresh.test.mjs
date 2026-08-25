import test from "node:test";
import assert from "node:assert/strict";

import { feedSourceId, fetchFeedSet } from "../scripts/lib/feed-refresh.mjs";

const feeds = [
  { team: "SF", name: "San Francisco 49ers", domain: "49ers.com", url: "https://www.49ers.com/rss/news" },
  { team: null, name: "ESPN NFL", domain: "espn.com", url: "https://www.espn.com/espn/rss/nfl/news", espn: true },
];

const rss = (title, link) => `<?xml version="1.0"?><rss><channel><item><title>${title}</title><link>${link}</link><pubDate>Sun, 23 Aug 2026 12:00:00 GMT</pubDate></item></channel></rss>`;

test("feed source IDs are stable for club and publisher feeds", () => {
  assert.equal(feedSourceId(feeds[0]), "rss-team-sf");
  assert.equal(feedSourceId(feeds[1]), "rss-espn");
});

test("a malformed optional feed preserves its own last-known-good headlines without blocking healthy feeds", async () => {
  const priorResearch = {
    items: [{
      id: "headline:prior",
      title: "Prior ESPN headline",
      url: "https://www.espn.com/nfl/story/_/id/1/example",
      publishedAt: "2026-08-22T12:00:00.000Z",
      source: "ESPN NFL",
      sourceId: "rss-espn",
      category: "headline",
    }],
  };
  const { results, failures } = await fetchFeedSet(feeds, {
    priorResearch,
    fetchText: async (url) => url.includes("espn.com")
      ? { text: "Access denied", finalUrl: url, contentType: "text/html" }
      : { text: rss("Kittle activated", "https://www.49ers.com/news/kittle-activated"), finalUrl: url, contentType: "application/rss+xml" },
  });

  assert.equal(results[0].headlines[0].title, "Kittle activated");
  assert.equal(results[0].usedFallback, false);
  assert.equal(results[1].headlines[0].title, "Prior ESPN headline");
  assert.equal(results[1].usedFallback, true);
  assert.equal(results[1].contentType, "text/html");
  assert.match(results[1].error, /not an RSS\/Atom document/);
  assert.deepEqual(failures.map(({ feed }) => feed.name), ["ESPN NFL"]);
});

test("a failed feed with no prior snapshot is reported with an empty isolated result", async () => {
  const { results, failures } = await fetchFeedSet([feeds[1]], {
    fetchText: async () => { throw new Error("HTTP 403 <script>blocked</script>"); },
  });
  assert.equal(results[0].headlines.length, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].error.includes("<script>"), false);
});
