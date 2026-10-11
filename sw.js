/* The installable app's service worker for one view of the encrypted web copy (pfos/site.py publishes it as sw.js
   beside index.html; "owner" and "8120c813d43ae706" are filled in there).
   It keeps the unlock page, its icons and manifest, and the ENCRYPTED copy d.json - nothing else, and never anything
   decrypted (decryption happens in the page, in memory). d.json and the page come from the network first, so a new
   copy shows at once; without a network the last ones kept are used: the page opens locked, as always. A new version
   of this file (any change of the page, icons or manifest gives a new VERSION) replaces the old one and its cache, and
   takes effect the next time the app is opened. The owner's worker leaves the family view (family/) alone: that view has
   its own worker, keys and storage. Requests to the PC (the phone upload, /api/m/ on its Tailscale address) are never touched;
   a statement shared to the owner's app (Android) is kept in this worker's memory only, until the app is unlocked (shareIn). */
"use strict";
const VIEW = "owner", VERSION = "8120c813d43ae706", PREFIX = `pfos-${VIEW}-`, CACHE = PREFIX + VERSION;
const SCOPE = new URL(self.registration.scope);
const STATIC = ["manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png"];
const PAGE = "./", DATA = "d.json";
const at = (rel) => new URL(rel, SCOPE).href;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll([PAGE, ...STATIC].map((u) => new Request(at(u), { cache: "no-cache" }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  SHARED = [];                     // (a new worker starts with no shared file; an older version's share box is deleted)
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => (k.startsWith(PREFIX) && k !== CACHE) || k.startsWith("pfos-share-")).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// a response as kept: a plain copy (never a redirected one - a page answered with one is refused by Safari)
async function plain(r) {
  return r.redirected ? new Response(await r.blob(), { status: r.status, statusText: r.statusText, headers: r.headers }) : r;
}
async function networkFirst(rel, fetchUrl) {
  const cache = await caches.open(CACHE);
  try {
    const r = await fetch(fetchUrl, { cache: "no-store", credentials: "same-origin" });
    if (r.ok) {
      const p = await plain(r);
      await cache.put(at(rel), p.clone());
      return p;
    }
    const kept = await cache.match(at(rel));
    return kept || r;
  } catch (err) {                  // offline: the last copy kept (still encrypted / the locked page)
    const kept = await cache.match(at(rel));
    if (kept) return kept;
    throw err;
  }
}
// M-2: statements shared to the OWNER's app from another app (Android share sheet - the manifest's share_target, set
// once phone upload is set up). Taken only from the phone itself (a share has no page behind it: no initiating client,
// Origin absent or "null") or from this site - never from another site's form. Kept ONLY in this worker's memory -
// never written to any storage another page of the address could read - until the unlocked app takes them (message
// "share-take" from a window of this app); dropped after SHARE_TTL, when the worker restarts, or when the phone stops
// the idle worker (the app then says "share again"). At most SHARE_MAX files / SHARE_BYTES in all.
const SHARE_TTL = 30 * 60 * 1000, SHARE_MAX = 10, SHARE_BYTES = 60 * 1024 * 1024, SHARE_FILE = 20 * 1024 * 1024;
let SHARED = [];                   // [{file, at}]
const sharePurge = () => { const now = Date.now(); SHARED = SHARED.filter((x) => now - x.at < SHARE_TTL); };
function shareOk(e) {
  const o = e.request.headers.get("Origin");
  if (o === SCOPE.origin) return true;                                 // this site's own page
  return !e.clientId && (o === null || o === "null");                  // the phone's share sheet (no page behind it)
}
async function shareIn(e) {
  let n = 0;
  if (shareOk(e)) {
    try {
      const fd = await e.request.formData();
      sharePurge();
      let bytes = SHARED.reduce((a, x) => a + x.file.size, 0);
      for (const f of fd.getAll("files")) {
        if (typeof f === "string" || !f.size || f.size > SHARE_FILE || SHARED.length >= SHARE_MAX || bytes + f.size > SHARE_BYTES) continue;
        SHARED.push({ file: f, at: Date.now() });
        bytes += f.size; n++;
      }
      setTimeout(sharePurge, SHARE_TTL + 1000);
    } catch (err) { /* nothing kept: the app opens as usual */ }
  }
  return Response.redirect(at("./?share=" + n), 303);
}
// the app asks how many files wait ("share-count", also keeps this worker awake while the app is locked) and takes them
// once unlocked ("share-take"); only a window of this app (its own folder; the owner's, never the family view) is answered
self.addEventListener("message", (e) => {
  const t = e.data && e.data.pfos, port = e.ports && e.ports[0];
  if (!port || (t !== "share-count" && t !== "share-take")) return;
  let mine = false;
  try {
    const u = new URL((e.source && e.source.url) || "");
    mine = VIEW === "owner" && u.origin === SCOPE.origin && u.pathname.startsWith(SCOPE.pathname) && !u.pathname.slice(SCOPE.pathname.length).startsWith("family/");
  } catch (err) { mine = false; }
  if (!mine) { port.postMessage({ n: 0 }); return; }
  sharePurge();
  if (t === "share-count") { port.postMessage({ n: SHARED.length }); return; }
  const files = SHARED.map((x) => x.file);
  SHARED = [];
  port.postMessage({ n: files.length, files });
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/m/")) return;                  // the phone upload to the PC (M-2): never kept, never answered here
  if (req.method === "POST" && VIEW === "owner" && url.origin === SCOPE.origin && url.pathname === SCOPE.pathname + "share-target") {
    e.respondWith(shareIn(e));
    return;
  }
  if (req.method !== "GET") return;
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  const rel = url.pathname.slice(SCOPE.pathname.length);
  if (VIEW === "owner" && rel.startsWith("family/")) return;          // the family view's own worker and storage
  if (rel === DATA) {              // the encrypted copy: always the newest, the kept one only offline
    e.respondWith(networkFirst(DATA, at(DATA) + "?t=" + Date.now()));
    return;
  }
  if (rel === "" || rel === "index.html") {
    // the unlock page: the newest (past any CDN copy - a query makes it a new address), the kept one offline. Any other
    // address goes to the network as it is (e.g. "family" without its slash: the server sends it on to the family view)
    e.respondWith(networkFirst(PAGE, at(PAGE) + "?v=" + Date.now()));
    return;
  }
  if (STATIC.includes(rel)) e.respondWith(caches.match(at(rel)).then((kept) => kept || fetch(req)));
});
