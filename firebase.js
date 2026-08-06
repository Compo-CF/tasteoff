// firebase.js — Firebase init, silent anonymous auth, and the Firestore data layer.
// Uses the modular v10 SDK from Google's CDN (no build step; works on GitHub Pages).
//
// Offline-first: we enable Firestore's IndexedDB persistent cache. Judges can score
// with no signal — writes queue on the device and sync automatically when the
// connection returns. No hand-rolled queue needed; Firestore handles it.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  collection,
  onSnapshot,
  query,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBJnKTOwlb7d-OuM2orGZx2Je0X_scJRQw",
  authDomain: "judging-app-dd929.firebaseapp.com",
  projectId: "judging-app-dd929",
  storageBucket: "judging-app-dd929.firebasestorage.app",
  messagingSenderId: "681684096241",
  appId: "1:681684096241:web:bf2d195ef62127ca320550",
  measurementId: "G-G6HRF7WRCN",
};

const app = initializeApp(firebaseConfig);

// Firestore with offline persistence (multi-tab safe).
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});

const auth = getAuth(app);

// Resolve once we have an anonymous user (judges never see this).
export const authReady = new Promise((resolve) => {
  onAuthStateChanged(auth, (user) => {
    if (user) resolve(user);
  });
  signInAnonymously(auth).catch((err) => {
    console.error("Anonymous sign-in failed:", err);
    // Surface a friendly hint if the toggle isn't on yet, but DON'T hang the app —
    // resolve so the UI still renders. Data ops will start working once the
    // Anonymous sign-in method is enabled in the Firebase console and the page reloads.
    if (err && String(err.code).includes("operation-not-allowed")) {
      console.warn(
        "Enable it: Firebase Console → Authentication → Sign-in method → Anonymous → Enable."
      );
    }
    resolve(null);
  });
});

// ---- Data model ---------------------------------------------------------
// events/{eventId}                         -> event config (criteria, judges, teams, schedule, passcodes)
// events/{eventId}/scores/{judgeId__code}  -> one judge's scores for one dish
//
// Score doc id is `${judgeId}__${teamCode}` so a re-submission overwrites cleanly
// (a judge can revise a dish; never creates duplicates).

// ---- Demo mode ----------------------------------------------------------
// eventId "demo" runs entirely in memory (no Firebase, no auth, no network).
// Lets anyone click through the full app with zero setup.
import { makeSampleEvent } from "./sample-event.js";
export const isDemo = (eventId) => eventId === "demo";
const demoScores = new Map(); // id -> score doc
const demoSubs = new Set();
function demoNotify() {
  const rows = [...demoScores.values()];
  demoSubs.forEach((cb) => cb(rows));
}

// Demo data for the judge database (in-memory demo scores + the sample event).
export function getDemoData() {
  if (!demoScores.size) return null;
  return {
    events: [makeSampleEvent("demo")],
    scoresByEvent: { demo: [...demoScores.values()] },
  };
}

export function eventRef(eventId) {
  return doc(db, "events", eventId);
}

function withTimeout(promise, ms, onTimeout) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(onTimeout), ms)),
  ]);
}

export async function loadEvent(eventId) {
  if (isDemo(eventId)) return makeSampleEvent("demo");
  try {
    await withTimeout(authReady, 4000, null);
    // Don't let a stalled network hang the UI — cap the read.
    const snap = await withTimeout(getDoc(eventRef(eventId)), 4000, "__timeout__");
    if (snap === "__timeout__") {
      console.warn("loadEvent timed out (Firebase not reachable yet)");
      return null;
    }
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch (err) {
    // Offline or auth/rules not ready yet — let the UI render its empty shell.
    console.warn("loadEvent failed (rendering empty shell):", err?.code || err);
    return null;
  }
}

// Save that never hangs the UI: resolves {ok:true} on server ack, or
// {ok:false, queued:true} if it can't reach Firebase within `ms` (the write is
// held in the local cache and will sync once auth/Firestore are enabled).
export async function saveEventSafe(eventId, data, ms = 4000) {
  const p = saveEvent(eventId, data).then(
    () => ({ ok: true }),
    (err) => ({ ok: false, error: err?.code || String(err) })
  );
  return withTimeout(p, ms, { ok: false, queued: true });
}

export async function saveEvent(eventId, data) {
  await authReady;
  await setDoc(eventRef(eventId), { ...data, updatedAt: serverTimestamp() });
}

export function watchEvent(eventId, cb) {
  return onSnapshot(eventRef(eventId), (snap) => {
    cb(snap.exists() ? { id: snap.id, ...snap.data() } : null);
  });
}

function tsMs(ts) {
  return ts && ts.seconds ? ts.seconds * 1000 : 0;
}

// List saved events for the admin history (newest first). System docs (id
// starting with "_") are hidden. Returns [] if Firebase isn't reachable.
export async function listEvents() {
  try {
    await withTimeout(authReady, 4000, null);
    const snap = await withTimeout(getDocs(collection(db, "events")), 5000, null);
    if (!snap) return [];
    const rows = [];
    snap.forEach((d) => {
      if (d.id.startsWith("_")) return;
      const x = d.data();
      rows.push({
        id: d.id,
        name: x.name || d.id,
        teamCount: (x.teams || []).length,
        judgeCount: (x.judges || []).length,
        updatedAt: x.updatedAt || null,
      });
    });
    rows.sort((a, b) => tsMs(b.updatedAt) - tsMs(a.updatedAt));
    return rows;
  } catch (err) {
    console.warn("listEvents failed:", err?.code || err);
    return [];
  }
}

export async function deleteEvent(eventId) {
  await authReady;
  await deleteDoc(eventRef(eventId));
}

// ---- Master judge roster (top-level `judges` collection) ------------------
// Judge id is a stable slug of the name, so the same person links across events.
export async function upsertJudges(judges) {
  await authReady;
  await Promise.all(
    (judges || [])
      .filter((j) => j && j.id && j.name)
      .map((j) =>
        setDoc(doc(db, "judges", j.id), { name: j.name, updatedAt: serverTimestamp() }, { merge: true })
      )
  );
}

export async function listRoster() {
  try {
    await withTimeout(authReady, 4000, null);
    const snap = await withTimeout(getDocs(collection(db, "judges")), 5000, null);
    if (!snap) return [];
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  } catch (err) {
    console.warn("listRoster failed:", err?.code || err);
    return [];
  }
}

// ---- Event-type templates (top-level `templates` collection) --------------
export async function listTemplates() {
  try {
    await withTimeout(authReady, 4000, null);
    const snap = await withTimeout(getDocs(collection(db, "templates")), 5000, null);
    if (!snap) return [];
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data(), _user: true }));
    return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  } catch (err) {
    console.warn("listTemplates failed:", err?.code || err);
    return [];
  }
}

export async function saveTemplate(tpl) {
  await authReady;
  const id = tpl.id || "t_" + String(tpl.name || "type").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  await setDoc(doc(db, "templates", id), {
    name: tpl.name,
    category: tpl.category || "Custom",
    criteria: tpl.criteria || [],
    schedule: tpl.schedule || null,
    updatedAt: serverTimestamp(),
  });
  return id;
}

export async function deleteTemplate(id) {
  await authReady;
  await deleteDoc(doc(db, "templates", id));
}

export async function getEventScoresOnce(eventId) {
  await authReady;
  const snap = await getDocs(collection(db, "events", eventId, "scores"));
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

// Load every event (full config) + its scores — powers the judge database.
export async function loadAllEventsWithScores() {
  const list = await listEvents();
  const events = [];
  const scoresByEvent = {};
  for (const meta of list) {
    const full = await loadEvent(meta.id);
    if (!full) continue;
    events.push(full);
    try {
      scoresByEvent[meta.id] = await getEventScoresOnce(meta.id);
    } catch {
      scoresByEvent[meta.id] = [];
    }
  }
  return { events, scoresByEvent };
}

export function scoreId(judgeId, teamCode) {
  return `${judgeId}__${teamCode}`;
}

export async function submitScore(eventId, judgeId, judgeName, table, teamCode, criterionScores) {
  const id = scoreId(judgeId, teamCode);
  if (isDemo(eventId)) {
    demoScores.set(id, { id, judgeId, judgeName, table, teamCode, criterionScores, submittedAt: Date.now() });
    demoNotify();
    return id;
  }
  await authReady;
  const ref = doc(db, "events", eventId, "scores", id);
  // Do NOT await network — Firestore's offline cache resolves locally and syncs
  // later. We return immediately so the judge UI stays snappy on weak signal.
  setDoc(ref, {
    judgeId,
    judgeName,
    table,
    teamCode,
    criterionScores,
    submittedAt: serverTimestamp(),
  });
  return id;
}

export function watchScores(eventId, cb) {
  if (isDemo(eventId)) {
    demoSubs.add(cb);
    cb([...demoScores.values()]);
    return () => demoSubs.delete(cb);
  }
  const q = query(collection(db, "events", eventId, "scores"));
  return onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    cb(rows);
  });
}

// Local judge scores (also mirrored to localStorage) so a judge's in-progress
// selections survive a refresh even before submit.
export function watchMyScores(eventId, judgeId, cb) {
  return watchScores(eventId, (rows) => {
    cb(rows.filter((r) => r.judgeId === judgeId));
  });
}
