// sw.js — app-shell caching so tasteoff boots and runs offline.
// Firestore handles its own offline data sync; this SW only caches the code/assets.
const VERSION = "tasteoff-v31";
const SHELL = [
  "./",
  "./index.html",
  "./volunteer.html",
  "./styles.css",
  "./app.js",
  "./samples/ballot.png",
  "./samples/results.png",
  "./samples/analytics.png",
  "./firebase.js",
  "./scoring.js",
  "./analytics.js",
  "./charts.js",
  "./report.js",
  "./import-sheet.js",
  "./sample-event.js",
  "./templates.js",
  "./vendor/qrcode.js",
  "./vendor/xlsx.full.min.js",
  "./vendor/jspdf.umd.min.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  // Firebase SDK (CDN) — cache so the app can start with no signal.
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) =>
      // Don't fail the whole install if one CDN file hiccups.
      Promise.allSettled(SHELL.map((u) => c.add(u)))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // never intercept Firestore writes
  const url = new URL(req.url);

  // Let Firestore/Auth network traffic (googleapis / firestore) pass straight through.
  if (
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("firestore") ||
    url.hostname.includes("firebaseio") ||
    url.hostname.includes("identitytoolkit")
  ) {
    return; // default network handling; Firestore manages offline itself
  }

  // Immutable CDN SDK: cache-first (never changes for a pinned version).
  if (url.origin === "https://www.gstatic.com") {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
            return res;
          })
      )
    );
    return;
  }

  // App shell (our own files): NETWORK-FIRST so online users always get the
  // latest deploy; fall back to cache only when offline. `cache: "reload"`
  // bypasses the browser's HTTP cache (iOS holds stale app.js otherwise).
  e.respondWith(
    fetch(req, { cache: "reload" })
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
  );
});
