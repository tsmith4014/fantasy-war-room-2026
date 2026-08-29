const CACHE_PREFIX = "fantasy-war-room-2026-";
const CACHE_NAME = `${CACHE_PREFIX}v5`;
const DATA_CACHE_PREFIX = `${CACHE_PREFIX}data-`;
const CORE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./modules/engine.js",
  "./modules/state.js",
  "./modules/utils.js",
  "./manifest.webmanifest",
  "./icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && !key.startsWith(DATA_CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(event.request, isPublishedDataRequest(event.request)));
});

function isPublishedDataRequest(request) {
  return /\/data\/(manifest|players|research|environment)\.json$/.test(new URL(request.url).pathname);
}

async function matchVerifiedData(request) {
  const canonical = new URL(request.url);
  canonical.search = "";
  const completeMarker = new URL("./data/__complete__", self.registration.scope).href;
  const keys = (await caches.keys()).filter((key) => key.startsWith(DATA_CACHE_PREFIX));
  for (const key of keys) {
    const cache = await caches.open(key);
    if (!(await cache.match(completeMarker))) continue;
    const match = await cache.match(canonical.href);
    if (match) return match;
  }
  return null;
}

async function networkFirst(request, publishedData = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_500);
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (!response.ok) throw new Error(`Network returned ${response.status}`);
    if (response.status === 200 && !publishedData) {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      } catch (error) {
        console.warn("Response could not be cached; serving the network result.", error);
      }
    }
    return response;
  } catch {
    if (publishedData) {
      const verified = await matchVerifiedData(request);
      if (verified) return verified;
    }
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const fallback = await caches.match("./index.html");
      if (fallback) return fallback;
    }
    return new Response("Offline and no cached copy is available.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } finally {
    clearTimeout(timeout);
  }
}
