const NAMED_ENTITIES = Object.freeze({
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
});

function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const radix = entity[1]?.toLowerCase() === "x" ? 16 : 10;
      const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
      const codePoint = Number.parseInt(digits, radix);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function cleanUntrustedText(value, maxLength = 300) {
  return decodeEntities(String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim())
    .slice(0, maxLength);
}

function elementText(xml, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  return match?.[1] ?? "";
}

function safeHttpUrl(value, expectedHosts) {
  const cleaned = cleanUntrustedText(value, 2_000);
  try {
    const url = new URL(cleaned);
    if (!new Set(["http:", "https:"]).has(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (expectedHosts?.length && !expectedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Extract only headline title, canonical link, and publication time. RSS text is
 * untrusted input: markup, scripts, control characters, unexpected hosts, and
 * overlong values are discarded before the result reaches JSON or Markdown.
 */
export function parseRssHeadlines(xml, { expectedHosts = [], limit = 3 } = {}) {
  if (typeof xml !== "string" || !/<(?:rss|feed)\b/i.test(xml)) throw new Error("Response is not an RSS/Atom document");
  const entries = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  const headlines = [];

  for (const entry of entries) {
    const title = cleanUntrustedText(elementText(entry, "title"), 280);
    let rawLink = elementText(entry, "link");
    if (!rawLink) rawLink = entry.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)?.[1] ?? "";
    const url = safeHttpUrl(rawLink, expectedHosts);
    const rawDate = elementText(entry, "pubDate") || elementText(entry, "published") || elementText(entry, "updated") || elementText(entry, "dc:date");
    const timestamp = Date.parse(cleanUntrustedText(rawDate, 120));
    if (!title || !url || !Number.isFinite(timestamp)) continue;
    headlines.push({ title, url, publishedAt: new Date(timestamp).toISOString() });
    if (headlines.length >= limit) break;
  }

  if (!headlines.length) throw new Error("Feed has no valid titled, linked, dated entries");
  return headlines;
}
