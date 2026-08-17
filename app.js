// app.js — tasteoff SPA: router + Admin / Judge / Results views.
import {
  loadEvent,
  saveEvent,
  saveEventSafe,
  setJudgingOpen,
  listEvents,
  deleteEvent,
  watchScores,
  submitScore,
  watchPeoples,
  savePeoplesCount,
  upsertJudges,
  listRoster,
  loadAllEventsWithScores,
  getDemoData,
  listTemplates,
  saveTemplate,
  deleteTemplate,
} from "./firebase.js";
import { BUILTIN_TEMPLATES, templateCriteria } from "./templates.js";
import { computeLeaderboards, SCORE_STEPS } from "./scoring.js";
import { parseFile, parseGoogleSheet, workbookToTemplates } from "./import-sheet.js";
import { eventAnalytics, dishFacets, dishAnalytics, criterionInfluence, judgeProfiles, eventsOverview, restaurantHistory, participantProfile, explainWinner, panelAgreement, winnerRobustness, servingDrift, outlierBallots, integrityGrade, judgeGrade } from "./analytics.js";
import { barChart, divergingChart, histogram, radar } from "./charts.js";
import { exportReportPDF } from "./report.js";

// stable judge id from a name, so the same person links across events
function judgeKey(name) {
  return "j_" + String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);
}

// Match a name from a sheet to an existing roster judge, so imports/edits link
// to the SAME judge (and their history) whether you typed a last name or a full
// name. Tries: exact full-name → id/key → last-name. Returns {id,name} or null.
function matchRosterJudge(name, roster) {
  const s = String(name || "").trim();
  if (!s || !roster || !roster.length) return null;
  const low = s.toLowerCase();
  // 1) exact full-name match (e.g. sheet "Bao Ong" == roster "Bao Ong")
  let hit = roster.find((r) => String(r.name).trim().toLowerCase() === low);
  if (hit) return hit;
  // 2) key match (e.g. sheet "Ong" -> j_ong, the historical key)
  const k = judgeKey(s);
  hit = roster.find((r) => r.id === k);
  if (hit) return hit;
  // No fuzzy last-name fallback — avoids merging two different people who share
  // a surname. An unrecognized name becomes a new judge you can merge later.
  return null;
}

// Link a list of {name,table} judges to the roster where possible (tags matched).
function reconcileJudges(judges, roster) {
  const out = (judges || []).map((j) => {
    const m = matchRosterJudge(j.name, roster);
    if (m) return { id: m.id, name: m.name, table: j.table, matched: true };
    return { id: judgeKey(j.name), name: j.name, table: j.table, matched: false };
  });
  return { judges: out, matched: out.filter((j) => j.matched).length, added: out.filter((j) => !j.matched).length };
}

// Reconcile + ask the organizer to confirm each unmatched judge as new, or link
// it to an existing roster judge. Returns the final judges list (matched flag stripped).
async function linkJudges(judges, roster) {
  const rec = reconcileJudges(judges, roster);
  const news = rec.judges.filter((j) => !j.matched);
  if (news.length && roster.length) {
    const choices = await reconcileModal([...new Set(news.map((j) => j.name))], roster);
    rec.judges.forEach((j) => {
      if (j.matched) return;
      const c = choices[j.name];
      if (c && c !== "__new__") {
        const R = roster.find((r) => r.id === c);
        if (R) {
          j.id = R.id;
          j.name = R.name;
          j.matched = true;
        }
      }
    });
  }
  return { judges: rec.judges.map(({ matched, ...j }) => j), matched: rec.judges.filter((j) => j.matched).length, added: rec.judges.filter((j) => !j.matched).length };
}

// Modal: confirm each new judge name as new, or link to an existing roster judge.
function reconcileModal(newNames, roster) {
  return new Promise((resolve) => {
    const opts = roster.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
    const rows = newNames
      .map(
        (n, i) => `<div class="rec-row">
          <span class="rec-name">${esc(n)}</span>
          <select data-i="${i}"><option value="__new__" selected>➕ New judge</option>${opts}</select>
        </div>`
      )
      .join("");
    const ov = el(`<div class="modal-ov"><div class="modal">
      <h3>Confirm new judges</h3>
      <p class="sub">These names didn't match your roster. Mark each as a new judge, or link it to an existing one.</p>
      <div class="rec-list">${rows}</div>
      <div class="modal-actions"><button class="primary" id="recOk">Confirm</button></div>
    </div></div>`);
    $("#recOk", ov).onclick = () => {
      const choices = {};
      ov.querySelectorAll(".rec-row select").forEach((s) => (choices[newNames[+s.dataset.i]] = s.value));
      ov.remove();
      resolve(choices);
    };
    document.body.appendChild(ov);
  });
}

// ---------- tiny helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const app = () => document.getElementById("app");
const uid = (p = "") =>
  p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// Integrity grade badge (A–F) shown wherever result-integrity appears.
function gradeBadge(ig, label = "Integrity") {
  if (!ig) return "";
  return `<div class="grade g${ig.grade}"><span class="grade-l">${ig.grade}</span><span class="grade-m"><b>${esc(label)} ${ig.score}/100</b><span>${esc(ig.meaning)}</span></span></div>`;
}

// Describe winner robustness by flip distance (min judges to change the winner).
function robustnessLabel(wr, jname) {
  if (!wr) return { tag: "—", cls: "", detail: "" };
  const fd = wr.flipDistance;
  if (fd == null || fd >= 4) return { tag: "✓ robust", cls: "ok", detail: "the win holds unless 4+ judges change" };
  if (fd === 1) {
    const who = wr.pivotal.length ? " (" + wr.pivotal.slice(0, 3).map((p) => esc(jname(p.judgeId))).join(", ") + ")" : "";
    return { tag: "⚠ fragile", cls: "warn", detail: "one judge can flip the winner" + who };
  }
  if (fd === 2) return { tag: "⚠ fragile", cls: "warn", detail: "just 2 judges could change the winner" };
  return { tag: "△ modest", cls: "", detail: "it takes 3 judges to change the winner" };
}

// Shared sub-navigation tabs for the Event Admin and Analytics hubs.
function hubTabs(kind, active) {
  const tabs = kind === "admin"
    ? [["events", "My events", "#/events"], ["admin", "Set up event", "#/admin"], ["checklist", "Checklist", "#/checklist"]]
    : [["judges", "Judge Analytics", "#/judges"], ["events", "Event Analytics", "#/history"], ["participants", "Participant Analytics", "#/participants"]];
  return el(`<div class="hubtabs">${tabs.map(([k, l, h]) => `<a class="hubtab${k === active ? " on" : ""}" href="${h}">${esc(l)}</a>`).join("")}</div>`);
}

const DEFAULT_EVENT_ID = "houbbq-2026-sep";
const LS = {
  get judgeId() {
    return localStorage.getItem("tasteoff_judgeId");
  },
  set judgeId(v) {
    localStorage.setItem("tasteoff_judgeId", v);
  },
  activeEvent() {
    return localStorage.getItem("tasteoff_event") || DEFAULT_EVENT_ID;
  },
  setActiveEvent(v) {
    localStorage.setItem("tasteoff_event", v);
  },
};

// ---------- routing ----------
function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  const params = new URLSearchParams(qs || "");
  return { path: path || "/", params };
}
window.addEventListener("hashchange", render);
window.addEventListener("load", render);

// Render token: bumped on every (re)render so a slow async view that resolves
// late can detect it's stale and skip clobbering a newer one.
let renderToken = 0;
function beginRender() {
  return ++renderToken;
}
const isStale = (t) => t !== renderToken;

// App-level passcodes: gate the organizer surfaces so judges' phones can't
// reach them. Results = 8899; Setup / My events / Event checklist = 7731.
// Unlocked per session (resets on full reload); one prompt per area.
const APP_CODES = { results: "8899", admin: "7731" };
const appUnlocked = { results: false, admin: false };
function requireCode(kind, fn) {
  if (appUnlocked[kind]) return fn();
  const label = kind === "results" ? "Results passcode" : "Organizer passcode";
  return gate(label, (val) => {
    if (val === APP_CODES[kind]) {
      appUnlocked[kind] = true;
      // also satisfy the per-event gates so we don't double-prompt
      if (kind === "results") resultsUnlocked = true; else adminUnlocked = true;
      render();
    } else alert("Wrong passcode.");
  });
}

async function render() {
  beginRender();
  const { path, params } = parseRoute();
  if (params.get("event")) LS.setActiveEvent(params.get("event"));
  // Home renders instantly. Data views call loadEvent(), which awaits auth
  // internally for real events and returns instantly for demo mode.
  if (path === "/admin") return requireCode("admin", renderAdmin);
  if (path === "/judge") return renderJudge(params);
  if (path === "/results") return requireCode("results", renderResults);
  if (path === "/judges") return renderJudgesDB();
  if (path === "/history") return renderHistory("events");
  if (path === "/participants") return renderHistory("restaurants");
  if (path === "/runner") return renderRunner();
  if (path === "/instructions") return renderInstructions();
  if (path === "/judgecard") return renderJudgeCard();
  if (path === "/checklist") return requireCode("admin", renderChecklist);
  if (path === "/events") return requireCode("admin", renderEvents);
  if (path === "/new") return requireCode("admin", renderWizard);
  if (path === "/sample") return renderSample();
  if (path === "/menu") return renderHome();
  return renderLanding();
}

// Shared brand wordmark (clipboard scorecard + "tasteoff").
const BRAND_SVG = `<svg class="brandsvg" viewBox="0 0 350 128" role="img" aria-label="tasteoff — digital scorecards for food competitions">
        <rect x="8" y="20" width="76" height="92" rx="14" fill="var(--card)" stroke="var(--line)" stroke-width="2"/>
        <rect x="33" y="13" width="26" height="15" rx="7" fill="var(--brand)"/>
        <rect x="42" y="16" width="8" height="4" rx="2" fill="var(--card)" opacity="0.7"/>
        <path d="M18 44 l5 5 l10 -12" fill="none" stroke="var(--brand-2)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
        <rect x="44" y="40" width="30" height="6" rx="3" fill="var(--brand)"/>
        <path d="M18 64 l5 5 l10 -12" fill="none" stroke="var(--brand-2)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
        <rect x="44" y="60" width="21" height="6" rx="3" fill="var(--muted)"/>
        <path d="M18 84 l5 5 l10 -12" fill="none" stroke="var(--muted)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
        <rect x="44" y="80" width="14" height="6" rx="3" fill="var(--muted)" opacity="0.55"/>
        <text x="100" y="86" font-family="inherit" font-weight="800" font-size="56" letter-spacing="-2.5"><tspan fill="var(--ink)">taste</tspan><tspan fill="var(--brand)">off</tspan></text>
      </svg>`;

// ---------- LANDING (intro shown before the menu) ----------
function renderLanding() {
  const node = el(`
    <div class="wrap landing">
      ${BRAND_SVG}
      <p class="tag">Digital scorecards for food competitions — score live, from any device.</p>
      <h1 class="lhero">Run a competition people<br><span>actually trust.</span></h1>
      <p class="llead">tasteoff turns messy paper ballots into blind, weighted, tie-free scoring — with a live leaderboard and post-event analytics. Built for cook-offs, bake-offs, BBQ throwdowns and chef battles.</p>
      <div class="lsteps">
        <div class="lstep"><div class="ln">1</div><h3>Set up your event</h3><p>Criteria &amp; weights, judges, teams and blind codes — or import a spreadsheet.</p></div>
        <div class="lstep"><div class="ln">2</div><h3>Judges score blind</h3><p>A code on their phone, 1–5 on each criterion. No names, no bias, works offline.</p></div>
        <div class="lstep"><div class="ln">3</div><h3>Crown a champion</h3><p>Instant, tie-free results plus People's Choice and judge/dish analytics.</p></div>
      </div>
      <div class="lfeat">
        <span>🔒 Blind coding</span><span>⚖️ Weighted 1–5</span><span>🥇 No ties, ever</span><span>📊 Analytics</span>
      </div>
      <div class="lsamples">
        <h2 class="lsamplehead">See it in action</h2>
        <div class="lsamplegrid">
          <img src="samples/ballot.png" alt="Sample blind ballot — what each judge sees" loading="lazy">
          <img src="samples/results.png" alt="Sample results leaderboard" loading="lazy">
          <img src="samples/analytics.png" alt="Sample judge & dish analytics" loading="lazy">
        </div>
        <a class="samplelink" href="#/sample">▶ Try the interactive sample ballot →</a>
      </div>
      <div class="lservice">
        <div class="lservicetxt">
          <h3>Have an event? Let us coordinate the judging.</h3>
          <p>Blind panels, dream-team advice, live results — coordinated for you. Contact for details &amp; pricing.</p>
        </div>
        <a class="primary" href="mailto:anthony@subtlefoodie.com?subject=Food%20competition%20judging%20inquiry">Contact us →</a>
      </div>
      <p class="lcopy">© ${new Date().getFullYear()} tasteoff, a subtlefoodie project. All rights reserved.</p>
    </div>`);
  node.querySelectorAll(".lsamplegrid img").forEach((img) => {
    img.addEventListener("click", () => openLightbox(img.getAttribute("src"), img.getAttribute("alt")));
  });
  app().replaceChildren(node);
}

// Full-screen image viewer for the sample graphics.
function openLightbox(src, alt) {
  const ov = el(
    `<div class="lightbox"><button class="lbclose" aria-label="Close">✕</button><img src="${esc(src)}" alt="${esc(alt || "")}"></div>`
  );
  const close = () => {
    ov.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  ov.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(ov);
}

// ---------- HOME (menu hub) ----------
function renderHome() {
  app().replaceChildren(
    el(`
    <div class="wrap home">
      <a href="#/" class="brandlink" aria-label="tasteoff intro">${BRAND_SVG}</a>
      <p class="tag">Digital scorecards for food competitions — score live, from any device.</p>
      <div class="cards">
        <a class="card judge disabled" id="judgeCard" aria-disabled="true">
          <div class="ci">🔒</div><h3>I'm a Judge</h3>
          <p id="judgeSub">Judging hasn't started yet.</p>
        </a>
        <a class="card results" href="#/results">
          <div class="ci">🏆</div><h3>Results</h3>
          <p>Live leaderboard (organizer).</p>
        </a>
        <a class="card admin" href="#/events">
          <div class="ci">⚙️</div><h3>Event Admin</h3>
          <p>Set up, manage &amp; check your events.</p>
        </a>
        <a class="card judgesdb" href="#/judges">
          <div class="ci">📊</div><h3>Analytics</h3>
          <p>Judges, events &amp; participants over time.</p>
        </a>
      </div>
      <p class="foot">Add to Home Screen to use it like an app.</p>
      <a class="demo-link" href="#/sample">See a sample ballot →</a>
    </div>`)
  );
  // The Judge card stays locked until the organizer opens judging on the active event.
  loadEvent(LS.activeEvent()).then((ev) => {
    const card = document.getElementById("judgeCard");
    if (!card || !ev || ev.judgingOpen !== true) return;
    card.classList.remove("disabled");
    card.removeAttribute("aria-disabled");
    card.setAttribute("href", "#/judge");
    const ci = card.querySelector(".ci");
    if (ci) ci.textContent = "📝";
    const sub = card.querySelector("#judgeSub");
    if (sub) sub.textContent = "Score the dishes at your table.";
  });
}

// ---------- CHECKLIST (event readiness) ----------
// Reads the active event and reports, requirement by requirement, what's ready
// and what's still missing before you can run judging.
function renderChecklist() {
  const myToken = renderToken;
  const eventId = LS.activeEvent();
  app().replaceChildren(
    el(`<div class="wrap"><a class="back" href="#/menu">← home</a>
      <h2>Event checklist</h2><p class="sub">Loading “${esc(eventId)}”…</p></div>`)
  );
  loadEvent(eventId).then((ev) => {
    if (isStale(myToken)) return;
    app().replaceChildren(buildChecklistView(ev, eventId));
  });
}

function buildChecklistView(ev, eventId) {
  const crit = (ev && ev.criteria) || [];
  const teams = (ev && ev.teams) || [];
  const judges = (ev && ev.judges) || [];
  const wsum = Math.round(crit.reduce((a, c) => a + (c.weight || 0), 0) * 100);
  const unnamed = teams.filter((t) => !(t.name && t.name.trim())).length;
  const coded = teams.filter((t) => t.code && String(t.code).trim());
  const codeVals = coded.map((t) => String(t.code).trim());
  const dupes = codeVals.filter((c, i) => codeVals.indexOf(c) !== i);
  const tablesUsed = [...new Set(teams.map((t) => t.table || "A"))].sort();
  const jByTable = (t) => judges.filter((j) => (j.table || "A") === t).length;
  const thinTable = tablesUsed.filter((t) => jByTable(t) < 3);
  const withEmail = teams.filter((t) => t.contactEmail && String(t.contactEmail).trim()).length;
  const pc = ev && ev.awards && ev.awards.peoples && ev.awards.peoples.enabled;

  // status: "ok" | "warn" | "todo"; `req` marks items that gate readiness.
  const items = [
    {
      req: true,
      title: "Event name",
      status: ev && ev.name ? "ok" : "todo",
      detail: ev && ev.name ? esc(ev.name) : "Give the event a name in Set up event.",
    },
    {
      req: true,
      title: "Scoring criteria & weights",
      status: !crit.length ? "todo" : wsum === 100 ? "ok" : "warn",
      detail: !crit.length
        ? "Add the criteria dishes are judged on (e.g. Flavor, Texture, Appearance) — or load an event-type template."
        : `${crit.length} criteria · weights total ${wsum}%` + (wsum === 100 ? "" : " (should total 100%)"),
    },
    {
      req: true,
      title: "Restaurants / teams",
      status: teams.length < 2 ? (teams.length ? "warn" : "todo") : unnamed ? "warn" : "ok",
      detail: !teams.length
        ? "Add the competing restaurants/dishes (their names stay hidden from judges)."
        : `${teams.length} entered` + (unnamed ? ` · ${unnamed} missing a name` : "") + (teams.length < 2 ? " · add at least 2" : ""),
    },
    {
      req: true,
      title: "Blind codes",
      status: !teams.length ? "todo" : coded.length < teams.length || dupes.length ? "warn" : "ok",
      detail: !teams.length
        ? "Each team needs a unique code — judges score the code, never the name."
        : dupes.length
        ? `Duplicate codes: ${esc([...new Set(dupes)].join(", "))} — codes must be unique`
        : coded.length < teams.length
        ? `${teams.length - coded.length} team(s) still need a code — use “Auto-fill codes”.`
        : `All ${teams.length} teams coded & unique`,
    },
    {
      req: true,
      title: "Judges",
      status: !judges.length ? "todo" : thinTable.length ? "warn" : "ok",
      detail: !judges.length
        ? "Add your panel and assign each judge to a table."
        : `${judges.length} judge(s)` +
          (tablesUsed.length > 1 ? ` · ${tablesUsed.map((t) => `Table ${t}: ${jByTable(t)}`).join(" · ")}` : "") +
          (thinTable.length ? ` · 3+ per table recommended (Min-Max drops a high & low)` : ""),
    },
    {
      req: false,
      title: "Date & time",
      status: ev && ev.eventDate ? "ok" : "todo",
      detail:
        ev && ev.eventDate
          ? `${fmtDay(ev.eventDate)} · serving from ${(ev.schedule && ev.schedule.startTime) || "13:00"}`
          : "Set the event date and serving start in Set up event.",
    },
    {
      req: false,
      title: "Venue",
      status: ev && ev.venue ? "ok" : "todo",
      detail: ev && ev.venue ? esc(ev.venue) : "Add where the event is held.",
    },
    {
      req: false,
      title: "Restaurant menu contacts",
      status: !teams.length ? "todo" : withEmail === teams.length ? "ok" : withEmail ? "warn" : "todo",
      detail: !teams.length
        ? "Add restaurants first, then a contact email for each to request their menu items."
        : `${withEmail}/${teams.length} restaurants have a contact email` +
          (withEmail < teams.length ? " — add the rest to collect menus" : ""),
    },
    {
      req: false,
      title: "People's Choice (optional)",
      status: pc ? "ok" : "todo",
      detail: pc
        ? `On · “${esc((ev.awards.peoples.unit || "Coins"))}”, top ${ev.awards.peoples.topN || 2}`
        : "Off — turn on in Set up event if you want a crowd vote alongside the judges.",
    },
  ];

  const reqItems = items.filter((i) => i.req);
  const readyN = reqItems.filter((i) => i.status === "ok").length;
  const allReady = readyN === reqItems.length;
  const judgingOpen = ev && ev.judgingOpen === true;

  const c = el(`<div class="wrap checklist">
    <a class="back" href="#/menu">← home</a>
    <h2>Event checklist</h2>
    <p class="sub">What you need in place to run judging${ev && ev.name ? ` for <b>${esc(ev.name)}</b>` : ""}.</p>
    <div class="cksum ${allReady ? "ready" : "notready"}">
      <span class="ckbadge">${readyN}/${reqItems.length}</span>
      <span>${allReady ? "All essentials ready — you can open judging." : "requirements ready"}</span>
    </div>
    <div class="ckitems"></div>
    <div class="ckgo ${judgingOpen ? "live" : ""}">
      <div class="ci">${judgingOpen ? "🟢" : allReady ? "▶️" : "⏳"}</div>
      <div>
        <h3>${judgingOpen ? "Judging is OPEN" : "Open judging"}</h3>
        <p>${
          judgingOpen
            ? "Judges can score now. Close it from Set up event when you're done."
            : allReady
            ? "Everything's ready — hit “Start judging” in Set up event to let judges in."
            : "Finish the essentials above first, then start judging in Set up event."
        }</p>
      </div>
      <a class="switchlink" href="#/admin">Set up event →</a>
    </div>
    <p class="foot">Tip: import a spreadsheet in Set up event to fill teams, judges &amp; criteria at once.</p>
  </div>`);

  c.querySelector(".back").after(hubTabs("admin", "checklist"));
  const box = $(".ckitems", c);
  const icon = { ok: "✓", warn: "!", todo: "○" };
  items.forEach((it) => {
    const row = el(`<a class="ckrow ${it.status}" href="#/admin">
      <span class="ckmark ${it.status}">${icon[it.status]}</span>
      <span class="cktext"><b>${esc(it.title)}</b><span class="ckdetail">${it.detail}</span></span>
      <span class="ckedit">edit ›</span>
    </a>`);
    box.appendChild(row);
  });
  return c;
}

// ---------- MY EVENTS (drafts dashboard) ----------
// Manage a whole series of events by lifecycle status. Pick one to make it the
// active event, then work on it in Set up event / checklist.
function renderEvents() {
  const myToken = renderToken;
  app().replaceChildren(
    el(`<div class="wrap"><a class="back" href="#/menu">← home</a>
      <h2>My events</h2><p class="sub">Loading your events…</p></div>`)
  );
  listEvents().then((list) => {
    if (isStale(myToken)) return;
    app().replaceChildren(buildEventsView(list));
  });
}

function buildEventsView(list) {
  const active = LS.activeEvent();
  const c = el(`<div class="wrap events">
    <a class="back" href="#/menu">← home</a>
    <div class="evtophead">
      <h2>My events</h2>
      <button class="primary" id="evNew">+ New event</button>
    </div>
    <p class="sub">Keep a series of events in draft, then bring one live. Pick one to make it active.</p>
    <div class="evgroups"></div>
  </div>`);

  c.querySelector(".back").after(hubTabs("admin", "events"));
  $("#evNew", c).onclick = () => { location.hash = "#/new"; };

  const groups = $(".evgroups", c);
  const order = [
    ["draft", "Drafts", "In planning — not ready to score yet."],
    ["live", "Live", "Happening now or ready to go."],
    ["done", "Completed", "Finished events and their results."],
  ];
  const byStatus = { draft: [], live: [], done: [] };
  list.forEach((r) => (byStatus[STATUS_META[r.status] ? r.status : "draft"].push(r)));

  if (!list.length) {
    groups.appendChild(el(`<p class="hint">No events yet. Hit “+ New event” to start your first one.</p>`));
    return c;
  }

  order.forEach(([key, label, blurb]) => {
    const rows = byStatus[key];
    if (!rows.length) return;
    const sec = el(`<section class="evgroup">
      <div class="evgrouphead"><span class="stbadge ${key}">${STATUS_META[key].label}</span>
        <h3>${label}</h3><span class="evcount">${rows.length}</span></div>
      <p class="evblurb">${blurb}</p>
      <div class="evrows"></div>
    </section>`);
    const box = $(".evrows", sec);
    rows.forEach((r) => {
      const isCur = r.id === active;
      const bits = [
        r.eventDate ? fmtDay(r.eventDate) : null,
        r.venue || null,
        `${r.teamCount} teams · ${r.judgeCount} judges`,
      ].filter(Boolean);
      const row = el(`<div class="evcard${isCur ? " cur" : ""}">
        <div class="evcardmain">
          <div class="evcardtop"><span class="evtitle">${esc(r.name)}</span>${
        isCur ? `<span class="curtag">active</span>` : ""
      }</div>
          <div class="evcardmeta">${bits.map((b) => esc(b)).join("  ·  ")}</div>
        </div>
        <div class="evcardacts">
          <a class="mini" href="#/checklist">Checklist</a>
          <button class="mini go">Open →</button>
        </div>
      </div>`);
      row.querySelector(".go").onclick = () => {
        LS.setActiveEvent(r.id);
        location.hash = "#/admin";
      };
      row.querySelector('a[href="#/checklist"]').onclick = () => LS.setActiveEvent(r.id);
      box.appendChild(row);
    });
    groups.appendChild(sec);
  });
  return c;
}

// ---------- NEW-EVENT WIZARD ----------
async function renderWizard() {
  const myToken = renderToken;
  app().replaceChildren(
    el(`<div class="wrap"><a class="back" href="#/events">← my events</a><h2>New event</h2><p class="sub">Loading…</p></div>`)
  );
  const [events, saved] = await Promise.all([listEvents(), listTemplates().catch(() => [])]);
  if (isStale(myToken)) return;
  const templates = [...BUILTIN_TEMPLATES.map((t) => ({ ...t })), ...(saved || [])];
  const pastEvents = events.slice();
  const existingIds = new Set(pastEvents.map((e) => e.id));
  const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

  const W = {
    name: "", date: "", venue: "",
    start: "scratch", cloneId: "",
    critMode: "template", templateId: templates[0] ? templates[0].id : "generic-tasting",
    judges: 5, restaurants: 14, tables: 1,
    startTime: "13:00", interval: 5, delivery: "runner", method: "scaled",
    judgesTopN: 3, pcEnabled: false, pcUnit: "Coins", pcTopN: 3,
  };
  let cloneEv = null;
  let step = 0;
  const STEPS = ["Basics", "Criteria", "Scale & schedule", "Awards & review"];

  const host = el(`<div class="wrap wizard"><a class="back" href="#/events">← my events</a>
    <h2>New event</h2>
    <div class="wz-steps"></div>
    <div class="wz-body"></div>
    <div class="wz-nav"></div></div>`);
  app().replaceChildren(host);
  const body = $(".wz-body", host);

  const scaffoldTeams = (n, tables, startTime, interval) => {
    const out = []; const tbls = tables === 2 ? ["A", "B"] : ["A"];
    const per = tables === 2 ? [Math.ceil(n / 2), Math.floor(n / 2)] : [n];
    tbls.forEach((tbl, ti) => {
      for (let i = 0; i < per[ti]; i++) out.push({ code: `${tbl}${String(i + 1).padStart(2, "0")}`, name: "", table: tbl, dishNumber: i + 1, serveTime: addMinutes(startTime, i * interval), dishDescription: "", contactName: "", contactEmail: "" });
    });
    return out;
  };
  const scaffoldJudges = (n, tables, cloneJudges) => {
    const out = []; const tbls = tables === 2 ? ["A", "B"] : ["A"];
    const per = tables === 2 ? [Math.ceil(n / 2), Math.floor(n / 2)] : [n];
    let k = 0;
    tbls.forEach((tbl, ti) => {
      for (let i = 0; i < per[ti]; i++) {
        const nm = cloneJudges && cloneJudges[k] ? cloneJudges[k].name : "";
        out.push({ id: nm ? judgeKey(nm) : uid("j"), name: nm, table: tbl });
        k++;
      }
    });
    return out;
  };

  function readStep() {
    if (step === 0) {
      W.name = $("#wz_name", body).value.trim();
      W.date = $("#wz_date", body).value;
      W.venue = $("#wz_venue", body).value.trim();
      W.start = body.querySelector("input[name=wzstart]:checked").value;
      W.cloneId = $("#wz_clone", body).value;
    } else if (step === 1) {
      W.critMode = body.querySelector("input[name=wzcrit]:checked").value;
      W.templateId = $("#wz_tpl", body).value;
    } else if (step === 2) {
      W.judges = Math.max(1, parseInt($("#wz_judges", body).value) || W.judges);
      W.restaurants = Math.max(1, parseInt($("#wz_rest", body).value) || W.restaurants);
      W.tables = parseInt(body.querySelector("input[name=wztables]:checked").value) || 1;
      W.startTime = $("#wz_start", body).value || W.startTime;
      W.interval = Math.max(1, parseInt($("#wz_int", body).value) || W.interval);
      W.delivery = body.querySelector("input[name=wzdeliv]:checked").value;
      W.method = body.querySelector("input[name=wzmethod]:checked").value;
    } else if (step === 3) {
      W.judgesTopN = Math.max(1, parseInt($("#wz_jtop", body).value) || W.judgesTopN);
      W.pcEnabled = $("#wz_pc", body).checked;
      W.pcUnit = $("#wz_pcunit", body).value.trim() || "Coins";
      W.pcTopN = Math.max(1, parseInt($("#wz_pctop", body).value) || W.pcTopN);
    }
  }

  async function maybeLoadClone() {
    if (W.start === "clone" && W.cloneId) {
      if (!cloneEv || cloneEv.id !== W.cloneId) cloneEv = await loadEvent(W.cloneId);
      if (cloneEv) {
        W.judges = (cloneEv.judges || []).length || W.judges;
        W.restaurants = (cloneEv.teams || []).length || W.restaurants;
        W.tables = usedTables(cloneEv).length;
        W.startTime = (cloneEv.schedule && cloneEv.schedule.startTime) || W.startTime;
        W.interval = (cloneEv.schedule && cloneEv.schedule.intervalMin) || W.interval;
        W.delivery = cloneEv.deliveryMode || W.delivery;
        W.method = cloneEv.officialMethod || W.method;
        const aw = eventAwards(cloneEv);
        W.judgesTopN = aw.judgesTopN; W.pcEnabled = aw.peoples.enabled; W.pcUnit = aw.peoples.unit; W.pcTopN = aw.peoples.topN;
        W.critMode = "clone";
      }
    } else {
      cloneEv = null;
      if (W.critMode === "clone") W.critMode = "template";
    }
  }

  function drawSteps() {
    $(".wz-steps", host).innerHTML = STEPS.map((s, i) => `<span class="wz-step${i === step ? " on" : ""}${i < step ? " done" : ""}">${i + 1}. ${esc(s)}</span>`).join("");
  }

  function bodyBasics() {
    body.innerHTML = `
      <div class="wz-card">
        <label>Event name <input id="wz_name" value="${esc(W.name)}" placeholder="e.g. HouBBQ Throwdown 2026"></label>
        <div class="row">
          <label>Date <input id="wz_date" type="date" value="${esc(W.date)}"></label>
          <label>Venue <input id="wz_venue" value="${esc(W.venue)}" placeholder="optional"></label>
        </div>
      </div>
      <div class="wz-card">
        <h3>Start from…</h3>
        <label class="wz-opt"><input type="radio" name="wzstart" value="scratch"${W.start !== "clone" ? " checked" : ""}><span><b>A blank event</b><small>Choose criteria and set the numbers yourself.</small></span></label>
        <label class="wz-opt"><input type="radio" name="wzstart" value="clone"${W.start === "clone" ? " checked" : ""}${pastEvents.length ? "" : " disabled"}><span><b>Copy an existing event</b><small>Reuse its criteria, judges, schedule &amp; awards as a starting point.</small></span></label>
        <label class="wz-sub">Which event? <select id="wz_clone"${W.start === "clone" ? "" : " disabled"}>
          <option value="">Choose…</option>
          ${pastEvents.map((e) => `<option value="${esc(e.id)}"${W.cloneId === e.id ? " selected" : ""}>${esc(e.name)}</option>`).join("")}
        </select></label>
      </div>`;
    body.querySelectorAll("input[name=wzstart]").forEach((r) => (r.onchange = () => {
      $("#wz_clone", body).disabled = body.querySelector("input[name=wzstart]:checked").value !== "clone";
    }));
  }

  function bodyCriteria() {
    const cloneName = cloneEv ? cloneEv.name : "the copied event";
    const cloneList = cloneEv ? (cloneEv.criteria || []).map((c) => esc(c.name)).join(", ") : "";
    body.innerHTML = `
      <div class="wz-card">
        <h3>Scoring criteria</h3>
        ${W.start === "clone" ? `<label class="wz-opt"><input type="radio" name="wzcrit" value="clone"${W.critMode === "clone" ? " checked" : ""}><span><b>Keep ${esc(cloneName)}'s criteria</b><small>${cloneList}</small></span></label>` : ""}
        <label class="wz-opt"><input type="radio" name="wzcrit" value="template"${W.critMode === "template" ? " checked" : ""}><span><b>Use a saved type</b><small>Start from a preset rubric.</small></span></label>
        <label class="wz-sub">Type <select id="wz_tpl"${W.critMode === "template" ? "" : " disabled"}>
          ${templates.map((t) => `<option value="${esc(t.id)}"${W.templateId === t.id ? " selected" : ""}>${esc(t.name)}${t.category ? " · " + esc(t.category) : ""}</option>`).join("")}
        </select></label>
        <div class="wz-crlist" id="wz_tplprev"></div>
        <label class="wz-opt"><input type="radio" name="wzcrit" value="scratch"${W.critMode === "scratch" ? " checked" : ""}><span><b>Start from scratch</b><small>Add your own criteria later in Set up.</small></span></label>
      </div>`;
    const prev = () => {
      const t = templates.find((x) => x.id === ($("#wz_tpl", body).value || W.templateId));
      $("#wz_tplprev", body).innerHTML = t ? t.criteria.map((c) => `<span class="pcrit">${esc(c.shortName || c.name)} <b>${Math.round((c.weight || 0) * 100)}%</b></span>`).join("") : "";
    };
    body.querySelectorAll("input[name=wzcrit]").forEach((r) => (r.onchange = () => {
      $("#wz_tpl", body).disabled = body.querySelector("input[name=wzcrit]:checked").value !== "template";
    }));
    $("#wz_tpl", body).onchange = prev;
    prev();
  }

  function bodyScale() {
    body.innerHTML = `
      <div class="wz-card">
        <div class="row">
          <label>Judges <input id="wz_judges" type="number" min="1" value="${W.judges}"></label>
          <label>Restaurants / dishes <input id="wz_rest" type="number" min="1" value="${W.restaurants}"></label>
        </div>
        <h3>Tables</h3>
        <label class="wz-opt"><input type="radio" name="wztables" value="1"${W.tables !== 2 ? " checked" : ""}><span><b>One table</b><small>All judges score every dish.</small></span></label>
        <label class="wz-opt"><input type="radio" name="wztables" value="2"${W.tables === 2 ? " checked" : ""}><span><b>Two tables (A &amp; B)</b><small>Split judges &amp; dishes across two panels.</small></span></label>
      </div>
      <div class="wz-card">
        <div class="row">
          <label>First serving time <input id="wz_start" type="time" value="${esc(W.startTime)}"></label>
          <label>Minutes between dishes <input id="wz_int" type="number" min="1" value="${W.interval}"></label>
        </div>
        <h3>Dish delivery</h3>
        <label class="wz-opt"><input type="radio" name="wzdeliv" value="runner"${W.delivery !== "dropoff" ? " checked" : ""}><span>A runner picks up each dish at its time.</span></label>
        <label class="wz-opt"><input type="radio" name="wzdeliv" value="dropoff"${W.delivery === "dropoff" ? " checked" : ""}><span>Participants deliver to the judging area.</span></label>
        <h3>Official ranking method</h3>
        <label class="wz-opt"><input type="radio" name="wzmethod" value="scaled"${W.method !== "minmax" ? " checked" : ""}><span><b>Scaled</b> — sum of all weighted scores.</span></label>
        <label class="wz-opt"><input type="radio" name="wzmethod" value="minmax"${W.method === "minmax" ? " checked" : ""}><span><b>Min-Max</b> — drop each dish's high &amp; low first.</span></label>
      </div>`;
  }

  function bodyReview() {
    body.innerHTML = `
      <div class="wz-card">
        <h3>Awards</h3>
        <label>Judges' Choice — winners to name (top N) <input id="wz_jtop" type="number" min="1" value="${W.judgesTopN}"></label>
        <label class="wz-check"><input type="checkbox" id="wz_pc"${W.pcEnabled ? " checked" : ""}> <span>Enable People's Choice (crowd vote)</span></label>
        <div class="row">
          <label>Vote unit <input id="wz_pcunit" value="${esc(W.pcUnit)}" placeholder="Coins / Beans / Votes"></label>
          <label>People's Choice top N <input id="wz_pctop" type="number" min="1" value="${W.pcTopN}"></label>
        </div>
      </div>
      <div class="wz-card wz-review"><h3>Review</h3><div id="wz_reviewbody"></div></div>`;
    const review = () => {
      readStep();
      const critDesc = W.critMode === "clone" ? `${cloneEv ? cloneEv.name : "copied"} criteria`
        : W.critMode === "template" ? (templates.find((t) => t.id === W.templateId) || {}).name + " preset"
        : "added later (from scratch)";
      const rows = [
        ["Event", W.name || "—"],
        ["Date / venue", [W.date ? fmtDay(W.date) : "", W.venue].filter(Boolean).join(" · ") || "—"],
        ["Start point", W.start === "clone" ? `copy of ${cloneEv ? cloneEv.name : "an event"}` : "blank event"],
        ["Criteria", critDesc],
        ["Judges", `${W.judges}${W.tables === 2 ? " (split A/B)" : ""}`],
        ["Restaurants / dishes", `${W.restaurants}${W.tables === 2 ? " across 2 tables" : ""}`],
        ["Schedule", `first at ${fmt12(W.startTime)}, every ${W.interval} min`],
        ["Delivery", W.delivery === "dropoff" ? "participants deliver" : "runner pickup"],
        ["Official method", W.method === "minmax" ? "Min-Max" : "Scaled"],
        ["Judges' Choice", `top ${W.judgesTopN}`],
        ["People's Choice", W.pcEnabled ? `on — ${W.pcUnit}, top ${W.pcTopN}` : "off"],
      ];
      $("#wz_reviewbody", body).innerHTML = rows.map((r) => `<div class="wz-rev"><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`).join("");
    };
    body.querySelectorAll("input").forEach((i) => i.addEventListener("input", review));
    review();
  }

  function drawNav() {
    const nav = $(".wz-nav", host);
    const last = step === STEPS.length - 1;
    nav.innerHTML = `${step > 0 ? `<button class="mini" id="wzBack">← Back</button>` : "<span></span>"}<button class="primary" id="wzNext">${last ? "✓ Create event" : "Next →"}</button>`;
    if (step > 0) $("#wzBack", nav).onclick = () => { readStep(); step -= 1; draw(); };
    $("#wzNext", nav).onclick = async () => {
      readStep();
      if (step === 0) {
        if (!W.name) { alert("Give the event a name."); return; }
        if (W.start === "clone" && !W.cloneId) { alert("Choose an event to copy, or pick “A blank event”."); return; }
        await maybeLoadClone();
      }
      if (last) return create($("#wzNext", nav));
      step += 1; draw();
    };
  }

  async function create(btn) {
    let id = slug(W.name) || "event-" + uid().slice(0, 5);
    if (existingIds.has(id)) id = id + "-" + uid().slice(0, 4);
    const ev = blankEvent(id);
    ev.name = W.name; ev.eventDate = W.date; ev.venue = W.venue; ev.status = "draft";
    ev.schedule = { startTime: W.startTime, intervalMin: W.interval };
    ev.deliveryMode = W.delivery; ev.officialMethod = W.method;
    ev.awards = { judgesTopN: W.judgesTopN, peoples: { enabled: W.pcEnabled, unit: W.pcUnit || "Coins", topN: W.pcTopN } };
    if (W.critMode === "clone" && cloneEv) ev.criteria = (cloneEv.criteria || []).map((c) => ({ ...c, id: uid("c") }));
    else if (W.critMode === "template") { const t = templates.find((x) => x.id === W.templateId); ev.criteria = t ? templateCriteria(t, uid) : []; }
    else ev.criteria = [];
    ev.judges = scaffoldJudges(W.judges, W.tables, W.start === "clone" && cloneEv ? cloneEv.judges : null);
    ev.teams = scaffoldTeams(W.restaurants, W.tables, W.startTime, W.interval);
    btn.disabled = true; btn.textContent = "Creating…";
    try {
      await saveEvent(id, ev);
      LS.setActiveEvent(id);
      toast("✓ Event created — add names & details");
      location.hash = "#/admin";
    } catch (err) {
      btn.disabled = false; btn.textContent = "✓ Create event";
      alert("Couldn't create the event — check your connection and try again.");
    }
  }

  function draw() {
    drawSteps();
    if (step === 0) bodyBasics();
    else if (step === 1) bodyCriteria();
    else if (step === 2) bodyScale();
    else bodyReview();
    drawNav();
  }
  draw();
}

// ---------- SAMPLE BALLOT (inert demo — nothing saves or navigates) ----------
function renderSample() {
  const crits = [
    { name: "Flavor", low: "Bland", high: "Rich & varied" },
    { name: "Texture", low: "Tough", high: "Tender" },
    { name: "Appearance", low: "Messy", high: "Stunning" },
    { name: "Creativity", low: "Generic", high: "One of a kind" },
  ];
  const node = el(`<div class="wrap sample">
    <a class="back" href="#/menu">← home</a>
    <div class="samp-badge">SAMPLE · nothing is saved</div>
    <h2>Try a sample ballot</h2>
    <p class="sub">This is what a judge sees — tap 1–5 on each criterion. It's just a preview: scoring is visual only, and Submit doesn't save or send anything.</p>
    <div class="samp-card">
      <div class="samp-headrow"><span class="samp-dish">Dish A03</span><span class="samp-code">blind code · sample</span></div>
      <div class="samp-crits"></div>
      <button class="primary samp-submit" id="sampSubmit">Submit score</button>
      <p class="samp-note" id="sampNote"></p>
    </div>
  </div>`);
  const list = node.querySelector(".samp-crits");
  crits.forEach((c) => {
    const row = el(`<div class="samp-row">
      <div class="samp-cn"><b>${esc(c.name)}</b><span class="samp-scale">${esc(c.low)} → ${esc(c.high)}</span></div>
      <div class="samp-pills">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="samp-pill" data-n="${n}">${n}</button>`).join("")}</div>
    </div>`);
    row.querySelector(".samp-pills").addEventListener("click", (e) => {
      const b = e.target.closest(".samp-pill");
      if (!b) return;
      row.querySelectorAll(".samp-pill").forEach((p) => p.classList.remove("on"));
      b.classList.add("on");
    });
    list.appendChild(row);
  });
  node.querySelector("#sampSubmit").addEventListener("click", () => {
    const note = node.querySelector("#sampNote");
    note.textContent = "✓ That's the whole flow — quick, blind, tap-to-score. (Sample only; nothing was saved.)";
    note.classList.add("show");
  });
  app().replaceChildren(node);
}

// ---------- ADMIN ----------
let adminUnlocked = false;
async function renderAdmin(preloaded) {
  const myToken = renderToken;
  const eventId = preloaded ? preloaded.id : LS.activeEvent();
  // `preloaded` (from a spreadsheet import) renders instantly — no network.
  let ev = preloaded || (await loadEvent(eventId));
  if (isStale(myToken)) return; // a newer render started while we awaited

  // Fresh event scaffold if none exists yet.
  if (!ev) {
    ev = blankEvent(eventId);
  }

  // Passcode gate (only if one is set and not yet unlocked this session).
  if (ev.adminPasscode && !adminUnlocked) {
    return gate("Admin passcode", (val) => {
      if (val === ev.adminPasscode) {
        adminUnlocked = true;
        renderAdmin();
      } else alert("Wrong passcode.");
    });
  }

  const c = el(`<div class="wrap admin"></div>`);
  c.appendChild(el(`<a class="back" href="#/menu">← home</a>`));
  c.appendChild(hubTabs("admin", "admin"));
  c.appendChild(el(`<h2>Event setup</h2>`));

  // Load the master roster so imported/typed judges link to existing judges.
  let roster = [];
  listRoster().then((r) => (roster = r));

  // --- your events (history / switcher) ---
  const evListSec = el(`
    <section class="panel evlist">
      <div class="phead"><h3>Your events</h3><button class="mini" id="newEv">+ new event</button></div>
      <div id="evItems" class="evitems"><p class="hint">Loading…</p></div>
    </section>`);
  c.appendChild(evListSec);
  $("#newEv", evListSec).onclick = () => {
    beginRender();
    renderAdmin(blankEvent("event-" + uid().slice(0, 5)));
  };
  listEvents().then((list) => {
    const box = $("#evItems", evListSec);
    if (!document.body.contains(box)) return;
    box.replaceChildren();
    if (!list.length) {
      box.appendChild(el(`<p class="hint">No saved events yet. Import a spreadsheet below, or start a new one.</p>`));
      return;
    }
    list.forEach((r) => {
      const isCur = r.id === ev.id;
      const sk = STATUS_META[r.status] ? r.status : "draft";
      const row = el(`
        <div class="evrow${isCur ? " cur" : ""}">
          <button class="evopen">
            <span class="evname"><span class="stbadge sm ${sk}">${STATUS_META[sk].label}</span> ${esc(r.name)}${
        isCur ? " ·  current" : ""
      }</span>
            <span class="evmeta">${r.eventDate ? fmtDay(r.eventDate) + " · " : ""}${r.teamCount} teams · ${r.judgeCount} judges${
        r.updatedAt ? " · " + fmtDate(r.updatedAt) : ""
      }</span>
          </button>
          <button class="evdel" title="delete">✕</button>
        </div>`);
      row.querySelector(".evopen").onclick = () => {
        LS.setActiveEvent(r.id);
        beginRender();
        renderAdmin();
      };
      row.querySelector(".evdel").onclick = async () => {
        if (!confirm(`Delete "${r.name}"? This removes the event config (submitted scores stay in the database).`)) return;
        await deleteEvent(r.id);
        beginRender();
        renderAdmin(r.id === ev.id ? blankEvent("event-" + uid().slice(0, 5)) : undefined);
      };
      box.appendChild(row);
    });
  });

  // --- import from a spreadsheet (Google Sheet URL or uploaded file) ---
  const importSec = el(`
    <section class="panel import">
      <div class="phead"><h3>Import from a spreadsheet</h3></div>
      <p class="hint">Fill the <a href="TasteOff-Template.xlsx" download>template</a> (Event · Criteria · Judges · Teams tabs) in Google Sheets or Excel — then load it here. Beats typing it all in below.</p>
      <label>Paste a Google Sheet link
        <div class="row">
          <input id="gsUrl" placeholder="https://docs.google.com/spreadsheets/d/…" style="flex:1">
          <button class="mini" id="gsGo" style="white-space:nowrap">Import URL</button>
        </div>
      </label>
      <div class="or">— or —</div>
      <label>Upload a .xlsx / .csv file
        <input id="fileUp" type="file" accept=".xlsx,.xls,.csv">
      </label>
      <div id="importMsg" class="importmsg"></div>
    </section>`);
  c.appendChild(importSec);

  async function applyImported(imported) {
    // Link the sheet's judges to existing roster judges; confirm any new ones.
    const rr = roster.length ? roster : await listRoster();
    const rec = await linkJudges(imported.judges, rr);
    imported.judges = rec.judges;
    const merged = { ...blankEvent(imported.id), ...imported };
    LS.setActiveEvent(merged.id);
    adminUnlocked = true;
    // Bump the token so any in-flight renderAdmin (still awaiting loadEvent)
    // sees itself as stale and won't clobber this imported view.
    beginRender();
    // Populate the form instantly from the parsed file — no Firebase round-trip.
    // The organizer reviews, then clicks "Save event" to persist.
    renderAdmin(merged);
    toast(`Loaded ✓ — ${rec.matched} judge(s) matched to roster, ${rec.added} new`);
  }
  $("#gsGo", importSec).onclick = async () => {
    const msg = $("#importMsg", importSec);
    const url = $("#gsUrl", importSec).value.trim();
    if (!url) return;
    msg.textContent = "Reading Google Sheet…";
    msg.className = "importmsg";
    try {
      await applyImported(await parseGoogleSheet(url));
    } catch (err) {
      msg.textContent = err.message || String(err);
      msg.className = "importmsg err";
    }
  };
  $("#fileUp", importSec).onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const msg = $("#importMsg", importSec);
    msg.textContent = "Reading file…";
    msg.className = "importmsg";
    try {
      await applyImported(await parseFile(file));
    } catch (err) {
      msg.textContent = err.message || String(err);
      msg.className = "importmsg err";
    }
  };

  // --- identity + schedule ---
  const est = eventStatus(ev);
  const dm = ev.deliveryMode === "dropoff" ? "dropoff" : "runner";
  const meta = el(`
    <section class="panel">
      <label>Event ID (URL slug) <input id="a_id" value="${esc(ev.id)}"></label>
      <label>Event name <input id="a_name" value="${esc(ev.name)}"></label>
      <div class="row">
        <label>Status
          <select id="a_status">
            <option value="draft"${est === "draft" ? " selected" : ""}>Draft — planning</option>
            <option value="live"${est === "live" ? " selected" : ""}>Live — happening</option>
            <option value="done"${est === "done" ? " selected" : ""}>Done — completed</option>
          </select>
        </label>
        <label>Event date <input id="a_date" type="date" value="${esc(ev.eventDate || "")}"></label>
      </div>
      <label>Venue <input id="a_venue" placeholder="Venue / location" value="${esc(ev.venue || "")}"></label>
      <label>Dish delivery
        <select id="a_delivery">
          <option value="runner"${dm === "runner" ? " selected" : ""}>A runner picks up the dish at the serving time</option>
          <option value="dropoff"${dm === "dropoff" ? " selected" : ""}>Participant delivers the dish to the judging area</option>
        </select>
      </label>
      <label>Official ranking method <small class="lblhint">decides the winner &amp; drives the PDF report</small>
        <select id="a_official">
          <option value="scaled"${ev.officialMethod === "minmax" ? "" : " selected"}>Scaled — every judge's weighted scores summed</option>
          <option value="minmax"${ev.officialMethod === "minmax" ? " selected" : ""}>Min-Max — drop each dish's single high &amp; low first</option>
        </select>
      </label>
      <div class="row">
        <label>Serving start <input id="a_start" type="time" value="${esc(
          ev.schedule?.startTime || "13:00"
        )}"></label>
        <label>Interval (min) <input id="a_int" type="number" min="1" value="${
          ev.schedule?.intervalMin || 5
        }"></label>
      </div>
      <div class="row">
        <label>Admin passcode <input id="a_apass" value="${esc(ev.adminPasscode || "")}"></label>
        <label>Results passcode <input id="a_rpass" value="${esc(ev.resultsPasscode || "")}"></label>
      </div>
    </section>`);
  c.appendChild(meta);

  // --- awards (Judges' Choice + optional People's Choice) ---
  const aw = eventAwards(ev);
  const awardsSec = el(`
    <section class="panel awards">
      <div class="phead"><h3>Awards</h3></div>
      <label>Judges' Choice — top <input id="aw_jtop" type="number" min="1" value="${aw.judgesTopN}" style="width:64px"> place(s)</label>
      <label class="chk"><input type="checkbox" id="aw_pc"${aw.peoples.enabled ? " checked" : ""}> Add a <b>People's Choice</b> award (coin/vote count per team)</label>
      <div class="row" id="aw_pcopts">
        <label>Unit label <input id="aw_unit" value="${esc(aw.peoples.unit)}"></label>
        <label>Top <input id="aw_ptop" type="number" min="1" value="${aw.peoples.topN || 3}" style="width:64px"></label>
      </div>
    </section>`);
  c.appendChild(awardsSec);
  const syncPc = () => ($("#aw_pcopts", awardsSec).style.display = $("#aw_pc", awardsSec).checked ? "flex" : "none");
  $("#aw_pc", awardsSec).onchange = syncPc;
  syncPc();

  // --- event type / template ---
  const typeSec = el(`
    <section class="panel evtype">
      <div class="phead"><h3>Event type</h3></div>
      <p class="hint">Load a preset's criteria &amp; weights, or save your current criteria as a reusable type for next time.</p>
      <div class="row">
        <select id="tplSel" style="flex:1"></select>
        <button class="mini" id="tplApply">Load</button>
      </div>
      <div class="typeactions">
        <button class="mini" id="tplSave">Save current as type…</button>
        <button class="mini" id="tplDel">Delete selected</button>
      </div>
      <div id="tplNote" class="hint"></div>
      <div class="typeimport">
        <label>Bulk-import types <input id="tplFile" type="file" accept=".xlsx,.xls,.csv"></label>
        <a href="TasteOff-EventTypes-Template.xlsx" download>types template</a>
      </div>
      <div id="tplImportMsg" class="importmsg"></div>
    </section>`);
  c.appendChild(typeSec);

  let allTemplates = BUILTIN_TEMPLATES.map((t) => ({ ...t }));
  function fillTpl() {
    const sel = $("#tplSel", typeSec);
    sel.replaceChildren();
    const og1 = document.createElement("optgroup");
    og1.label = "Built-in";
    const og2 = document.createElement("optgroup");
    og2.label = "Your saved types";
    allTemplates.forEach((t, i) => {
      const o = el(`<option value="${i}">${esc(t.name)}${t.category ? " · " + esc(t.category) : ""}</option>`);
      (t._user ? og2 : og1).appendChild(o);
    });
    sel.appendChild(og1);
    if (og2.children.length) sel.appendChild(og2);
    const cur = allTemplates[+sel.value] || allTemplates[0];
    $("#tplNote", typeSec).textContent = cur ? cur.note || "" : "";
  }
  fillTpl();
  listTemplates().then((us) => {
    if (!document.body.contains(typeSec)) return;
    allTemplates = [...BUILTIN_TEMPLATES.map((t) => ({ ...t })), ...us];
    fillTpl();
  });
  $("#tplSel", typeSec).onchange = () => {
    const t = allTemplates[+$("#tplSel", typeSec).value];
    $("#tplNote", typeSec).textContent = t ? t.note || "" : "";
  };
  $("#tplApply", typeSec).onclick = () => {
    const t = allTemplates[+$("#tplSel", typeSec).value];
    if (!t) return;
    readCrit();
    if (ev.criteria.length && !confirm(`Replace the current ${ev.criteria.length} criteria with "${t.name}"?`)) return;
    ev.criteria = templateCriteria(t, uid);
    drawCrit();
    if (t.schedule && t.schedule.intervalMin) $("#a_int").value = t.schedule.intervalMin;
    toast(`Loaded "${t.name}"`);
  };
  $("#tplSave", typeSec).onclick = async () => {
    readCrit();
    if (!ev.criteria.length) {
      alert("Add or load criteria first.");
      return;
    }
    const name = prompt("Name this event type:", ev.name || "");
    if (!name) return;
    const crit = ev.criteria.map((c) => ({ name: c.name, shortName: c.shortName, weight: c.weight, low: c.low, high: c.high }));
    await saveTemplate({ name, category: "Custom", criteria: crit, schedule: { intervalMin: parseInt($("#a_int").value) || 5 } });
    const us = await listTemplates();
    allTemplates = [...BUILTIN_TEMPLATES.map((t) => ({ ...t })), ...us];
    fillTpl();
    toast("Saved event type ✓");
  };
  $("#tplDel", typeSec).onclick = async () => {
    const t = allTemplates[+$("#tplSel", typeSec).value];
    if (!t || !t._user) {
      alert("Only your saved types can be deleted (built-ins are permanent).");
      return;
    }
    if (!confirm(`Delete event type "${t.name}"?`)) return;
    await deleteTemplate(t.id);
    const us = await listTemplates();
    allTemplates = [...BUILTIN_TEMPLATES.map((x) => ({ ...x })), ...us];
    fillTpl();
    toast("Deleted");
  };
  $("#tplFile", typeSec).onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const msg = $("#tplImportMsg", typeSec);
    msg.textContent = "Reading types…";
    msg.className = "importmsg";
    try {
      const wb = window.XLSX.read(await file.arrayBuffer(), { type: "array" });
      const types = workbookToTemplates(wb).filter((t) => t.criteria.length);
      if (!types.length) throw new Error("No event types found — check the template format.");
      for (const t of types) await saveTemplate(t);
      const us = await listTemplates();
      allTemplates = [...BUILTIN_TEMPLATES.map((x) => ({ ...x })), ...us];
      fillTpl();
      msg.textContent = `Imported ${types.length} event type(s): ${types.map((t) => t.name).join(", ")}`;
      toast(`Imported ${types.length} type(s) ✓`);
    } catch (err) {
      msg.textContent = err.message || String(err);
      msg.className = "importmsg err";
    }
  };

  // --- criteria ---
  const critSec = el(`<section class="panel"><div class="phead"><h3>Criteria &amp; weights</h3><button class="mini" id="addCrit">+ add</button></div>
    <div class="crow crow-head"><span>Category</span><span>Weight</span><span>Low Note</span><span>High Note</span><span></span></div>
    <div id="critList"></div><div class="wtotal" id="wtotal"></div></section>`);
  c.appendChild(critSec);
  const critList = $("#critList", critSec);
  function drawCrit() {
    critList.replaceChildren();
    ev.criteria.forEach((cr, i) => {
      const row = el(`
        <div class="crow" data-i="${i}">
          <input class="cn" placeholder="Category (e.g. Flavor)" value="${esc(cr.name)}">
          <input class="cw" type="number" min="0" step="1" placeholder="%" value="${Math.round(
            (cr.weight || 0) * 100
          )}">
          <input class="cl" placeholder="Low Note" value="${esc(cr.low || "")}">
          <input class="ch" placeholder="High Note" value="${esc(cr.high || "")}">
          <button class="del" title="remove">✕</button>
        </div>`);
      row.querySelector(".del").onclick = () => {
        ev.criteria.splice(i, 1);
        drawCrit();
      };
      critList.appendChild(row);
    });
    updateWTotal();
  }
  function readCrit() {
    ev.criteria = [...critList.querySelectorAll(".crow")].map((r) => {
      const prev = ev.criteria[+r.dataset.i] || {};
      const name = r.querySelector(".cn").value.trim();
      // Short label is derived automatically now (no separate column). Keep an
      // existing short name (from a template/import) if it still fits the name,
      // otherwise fall back to the full name for chart labels.
      const shortName = prev.shortName && name.includes(prev.shortName) ? prev.shortName : name;
      return {
        id: prev.id || uid("c"),
        name,
        shortName,
        weight: (parseFloat(r.querySelector(".cw").value) || 0) / 100,
        low: r.querySelector(".cl").value.trim(),
        high: r.querySelector(".ch").value.trim(),
      };
    });
  }
  function updateWTotal() {
    const rows = [...critList.querySelectorAll(".cw")];
    const tot = rows.reduce((a, r) => a + (parseFloat(r.value) || 0), 0);
    const wt = $("#wtotal", critSec);
    wt.textContent = `Weights total: ${tot}%`;
    wt.className = "wtotal " + (tot === 100 ? "ok" : "warn");
  }
  critList.addEventListener("input", (e) => {
    if (e.target.classList.contains("cw")) updateWTotal();
  });
  // When a weight is committed, re-order criteria high → low weight.
  critList.addEventListener("change", (e) => {
    if (!e.target.classList.contains("cw")) return;
    readCrit();
    ev.criteria.sort((a, b) => (b.weight || 0) - (a.weight || 0));
    drawCrit();
  });
  $("#addCrit", critSec).onclick = () => {
    readCrit();
    ev.criteria.push({ id: uid("c"), name: "", shortName: "", weight: 0, low: "", high: "" });
    drawCrit();
  };
  drawCrit();

  // --- judges ---
  const jSec = el(`<section class="panel"><div class="phead"><h3>Judges</h3><button class="mini" id="addJ">+ add</button></div><div id="jList"></div></section>`);
  c.appendChild(jSec);
  const jList = $("#jList", jSec);
  function drawJudges() {
    jList.replaceChildren();
    ev.judges.forEach((j, i) => {
      const row = el(`
        <div class="jrow" data-i="${i}">
          <span class="jdrag" draggable="true" title="Drag to reorder">⠿</span>
          <input class="jn" placeholder="Judge name" value="${esc(j.name)}">
          <select class="jt">
            <option value="A"${j.table === "A" ? " selected" : ""}>Table A</option>
            <option value="B"${j.table === "B" ? " selected" : ""}>Table B</option>
          </select>
          <button class="del">✕</button>
        </div>`);
      row.querySelector(".del").onclick = () => {
        ev.judges.splice(i, 1);
        drawJudges();
      };
      jList.appendChild(row);
    });
  }
  // Sync any unsaved name/table edits back into ev.judges (keeps ids), no filtering.
  function syncJudgesFromDOM() {
    [...jList.querySelectorAll(".jrow")].forEach((r) => {
      const i = +r.dataset.i;
      if (ev.judges[i]) {
        ev.judges[i].name = r.querySelector(".jn").value;
        ev.judges[i].table = r.querySelector(".jt").value;
      }
    });
  }
  let jDragFrom = null;
  jList.addEventListener("dragstart", (e) => {
    const h = e.target.closest(".jdrag");
    if (!h) return;
    jDragFrom = +h.closest(".jrow").dataset.i;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", String(jDragFrom)); } catch (err) {}
  });
  jList.addEventListener("dragover", (e) => {
    if (jDragFrom === null) return;
    e.preventDefault();
    const row = e.target.closest(".jrow");
    jList.querySelectorAll(".jrow.dragover").forEach((r) => r.classList.remove("dragover"));
    if (row) row.classList.add("dragover");
  });
  jList.addEventListener("drop", (e) => {
    if (jDragFrom === null) return;
    e.preventDefault();
    const row = e.target.closest(".jrow");
    const to = row ? +row.dataset.i : ev.judges.length - 1;
    syncJudgesFromDOM();
    if (to !== jDragFrom && ev.judges[jDragFrom]) {
      const [moved] = ev.judges.splice(jDragFrom, 1);
      ev.judges.splice(to, 0, moved);
    }
    jDragFrom = null;
    drawJudges();
  });
  jList.addEventListener("dragend", () => {
    jDragFrom = null;
    jList.querySelectorAll(".jrow.dragover").forEach((r) => r.classList.remove("dragover"));
  });
  function readJudges() {
    ev.judges = [...jList.querySelectorAll(".jrow")]
      .map((r) => {
        const name = r.querySelector(".jn").value.trim();
        return { id: judgeKey(name), name, table: r.querySelector(".jt").value };
      })
      .filter((j) => j.name);
  }
  $("#addJ", jSec).onclick = () => {
    readJudges();
    ev.judges.push({ id: uid("j"), name: "", table: "A" });
    drawJudges();
  };
  drawJudges();

  // --- teams / dishes ---
  const tSec = el(`<section class="panel"><div class="phead"><h3>Teams &amp; blind codes</h3><button class="mini" id="addT">+ add</button></div>
    <p class="hint">Judges see the <b>code</b> only — team names stay hidden until results.</p>
    <div id="tList"></div>
    <div class="trow-actions"><button class="mini" id="autoCode">Auto-fill codes &amp; serve times</button><button class="mini" id="shuffleT">🔀 Shuffle dish order</button></div></section>`);
  c.appendChild(tSec);
  const tList = $("#tList", tSec);
  function drawTeams() {
    tList.replaceChildren();
    ev.teams.forEach((t, i) => {
      const row = el(`
        <div class="trow" data-i="${i}">
          <input class="tc" placeholder="Code" value="${esc(t.code)}">
          <input class="tn" placeholder="Team name (hidden)" value="${esc(t.name)}">
          <select class="tt">
            <option value="A"${t.table === "A" ? " selected" : ""}>A</option>
            <option value="B"${t.table === "B" ? " selected" : ""}>B</option>
          </select>
          <input class="td" type="number" placeholder="#" value="${t.dishNumber || ""}" title="dish order">
          <input class="ts" type="time" value="${esc(t.serveTime || "")}" title="serve time">
          <button class="del">✕</button>
          <input class="tdd" placeholder="Dish description (shown on ballot)" value="${esc(t.dishDescription || "")}">
          <input class="tcn" placeholder="Contact name" value="${esc(t.contactName || "")}">
          <input class="tce" type="email" placeholder="Contact email (for menu)" value="${esc(t.contactEmail || "")}">
        </div>`);
      row.querySelector(".del").onclick = () => {
        ev.teams.splice(i, 1);
        drawTeams();
      };
      tList.appendChild(row);
    });
  }
  function readTeams() {
    ev.teams = [...tList.querySelectorAll(".trow")].map((r) => ({
      code: r.querySelector(".tc").value.trim(),
      name: r.querySelector(".tn").value.trim(),
      table: r.querySelector(".tt").value,
      dishNumber: parseInt(r.querySelector(".td").value) || null,
      serveTime: r.querySelector(".ts").value,
      dishDescription: r.querySelector(".tdd").value.trim(),
      contactName: r.querySelector(".tcn").value.trim(),
      contactEmail: r.querySelector(".tce").value.trim(),
    }));
  }
  $("#addT", tSec).onclick = () => {
    readTeams();
    ev.teams.push({ code: "", name: "", table: "A", dishNumber: null, serveTime: "", dishDescription: "", contactName: "", contactEmail: "" });
    drawTeams();
  };
  $("#autoCode", tSec).onclick = () => {
    readTeams();
    readMeta();
    ["A", "B"].forEach((tbl) => {
      const list = ev.teams.filter((t) => t.table === tbl);
      list.forEach((t, idx) => {
        if (!t.dishNumber) t.dishNumber = idx + 1;
      });
      list.sort((a, b) => (a.dishNumber || 0) - (b.dishNumber || 0));
      list.forEach((t, idx) => {
        if (!t.code) t.code = `${tbl}${String(idx + 1).padStart(2, "0")}`;
        t.serveTime = addMinutes(ev.schedule.startTime, idx * ev.schedule.intervalMin);
      });
    });
    drawTeams();
  };
  $("#shuffleT", tSec).onclick = () => {
    readTeams();
    readMeta();
    if (!ev.teams.length) { alert("Add teams first."); return; }
    if (!confirm("Shuffle the dish order? This randomizes each table's dish #, blind code and serve time.")) return;
    ["A", "B"].forEach((tbl) => {
      const list = ev.teams.filter((t) => (t.table || "A") === tbl);
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      list.forEach((t, idx) => {
        t.dishNumber = idx + 1;
        t.code = `${tbl}${String(idx + 1).padStart(2, "0")}`;
        t.serveTime = addMinutes(ev.schedule.startTime, idx * ev.schedule.intervalMin);
      });
    });
    ev.teams.sort((a, b) => String(a.table || "A").localeCompare(String(b.table || "A")) || (a.dishNumber || 0) - (b.dishNumber || 0));
    drawTeams();
    toast("🔀 Dish order shuffled — codes & times reassigned. Save to keep it.");
  };
  drawTeams();

  function readMeta() {
    ev.id = $("#a_id").value.trim() || DEFAULT_EVENT_ID;
    ev.name = $("#a_name").value.trim();
    ev.status = $("#a_status").value || "draft";
    ev.eventDate = $("#a_date").value || "";
    ev.venue = $("#a_venue").value.trim();
    ev.deliveryMode = $("#a_delivery").value === "dropoff" ? "dropoff" : "runner";
    ev.officialMethod = $("#a_official").value === "minmax" ? "minmax" : "scaled";
    ev.schedule = {
      startTime: $("#a_start").value || "13:00",
      intervalMin: parseInt($("#a_int").value) || 5,
    };
    ev.adminPasscode = $("#a_apass").value.trim();
    ev.resultsPasscode = $("#a_rpass").value.trim();
    ev.awards = {
      judgesTopN: parseInt($("#aw_jtop").value) || 3,
      peoples: {
        enabled: $("#aw_pc").checked,
        unit: $("#aw_unit").value.trim() || "Coins",
        topN: parseInt($("#aw_ptop").value) || 2,
      },
    };
  }

  // --- save + links ---
  const actions = el(`<div class="actions">
      <button class="primary" id="save">Save event</button>
      <button id="links">Judge links &amp; QR</button>
      <button id="judgetoggle"></button>
    </div>`);
  const linkbox = el(`<div id="linkbox"></div>`);
  c.appendChild(actions);
  c.appendChild(linkbox);

  $("#save", c).onclick = async () => {
    readMeta();
    readCrit();
    readJudges();
    readTeams();
    if (!ev.criteria.length || !ev.teams.length) {
      alert("Add at least one criterion and one team first.");
      return;
    }
    // Link judges to the roster (and confirm any new ones) so they keep history + full names.
    const rr = roster.length ? roster : await listRoster();
    ev.judges = (await linkJudges(ev.judges, rr)).judges;
    LS.setActiveEvent(ev.id);
    const btn = $("#save", c);
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Saving…";
    const { id, ...data } = ev;
    const res = await saveEventSafe(ev.id, { ...data, id: ev.id });
    upsertJudges(ev.judges); // add/update judges in the master roster (fire-and-forget)
    btn.disabled = false;
    btn.textContent = label;
    if (res.ok) {
      toast("Saved ✓");
    } else if (res.queued) {
      alert(
        "Your event is saved on this device, but couldn't reach Firebase yet.\n\n" +
          "Enable Anonymous sign-in and create Firestore in the Firebase console, then " +
          "click Save again — it will sync. (Your entries stay here meanwhile.)"
      );
    } else {
      alert("Save failed: " + res.error);
    }
  };
  $("#links", c).onclick = () => showLinks(ev, $("#linkbox", c));

  // Start/close judging — the switch that unlocks the "I'm a Judge" flow for judges.
  const jt = $("#judgetoggle", c);
  const paintToggle = () => {
    const open = ev.judgingOpen === true;
    jt.textContent = open ? "■ Close judging" : "▶ Start judging";
    jt.classList.toggle("live", open);
    jt.title = open ? "Judging is OPEN — judges can score now" : "Judging is closed — judges are locked out";
  };
  paintToggle();
  jt.onclick = async () => {
    const next = !(ev.judgingOpen === true);
    if (next && !(await loadEvent(ev.id))) {
      alert("Save the event first, then start judging.");
      return;
    }
    jt.disabled = true;
    await setJudgingOpen(ev.id, next);
    ev.judgingOpen = next;
    jt.disabled = false;
    paintToggle();
    toast(next ? "Judging is OPEN ✓ — judges can score" : "Judging closed");
  };

  app().replaceChildren(c);
}

// Tables actually in use (from team/judge assignments). Defaults to just "A"
// so single-table events don't print an empty Table B.
function usedTables(ev) {
  const s = [...new Set([...(ev.teams || []).map((t) => t.table), ...(ev.judges || []).map((j) => j.table)].filter(Boolean))].sort();
  return s.length ? s : ["A"];
}

function showLinks(ev, box) {
  const base = location.origin + location.pathname;
  box.replaceChildren();
  usedTables(ev).forEach((tbl) => {
    const url = `${base}#/judge?event=${encodeURIComponent(ev.id)}&table=${tbl}`;
    const card = el(`<div class="linkcard"><h4>Table ${tbl}</h4>
      <div class="qr" id="qr${tbl}"></div>
      <input readonly value="${esc(url)}" onclick="this.select()">
    </div>`);
    box.appendChild(card);
    makeQR($("#qr" + tbl, card), url);
  });
  const rurl = `${base}#/results?event=${encodeURIComponent(ev.id)}`;
  box.appendChild(
    el(`<div class="linkcard"><h4>Results dashboard</h4><input readonly value="${esc(
      rurl
    )}" onclick="this.select()"></div>`)
  );
  const runurl = `${base}#/runner?event=${encodeURIComponent(ev.id)}`;
  box.appendChild(
    el(`<div class="linkcard"><h4>Runner sheet / pickup schedule</h4><input readonly value="${esc(
      runurl
    )}" onclick="this.select()"><a class="mini" href="#/runner?event=${encodeURIComponent(ev.id)}">Open &amp; print →</a></div>`)
  );
  const insturl = `${base}#/instructions?event=${encodeURIComponent(ev.id)}`;
  box.appendChild(
    el(`<div class="linkcard"><h4>Participant instructions</h4><input readonly value="${esc(
      insturl
    )}" onclick="this.select()"><a class="mini" href="#/instructions?event=${encodeURIComponent(ev.id)}">Open &amp; print →</a></div>`)
  );
  const jcurl = `${base}#/judgecard?event=${encodeURIComponent(ev.id)}`;
  box.appendChild(
    el(`<div class="linkcard"><h4>Judge cards (QR + rubric)</h4><input readonly value="${esc(
      jcurl
    )}" onclick="this.select()"><a class="mini" href="#/judgecard?event=${encodeURIComponent(ev.id)}">Open &amp; print →</a></div>`)
  );
}

function makeQR(container, text) {
  container.replaceChildren();
  if (window.qrcode) {
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    container.innerHTML = qr.createSvgTag({ scalable: true, margin: 1 });
    const svg = container.querySelector("svg");
    if (svg) {
      svg.setAttribute("width", "160");
      svg.setAttribute("height", "160");
    }
  } else {
    container.textContent = "(QR unavailable offline)";
  }
}

// ---------- JUDGE ----------
async function renderJudge(params) {
  const myToken = renderToken;
  const eventId = params.get("event") || LS.activeEvent();
  const tableHint = params.get("table");
  const ev = await loadEvent(eventId);
  if (isStale(myToken)) return;
  if (!ev) {
    const w = el(`<div class="wrap"><a class="back" href="#/menu">← home</a>
      <h2>Couldn't load the event</h2>
      <p class="empty">This can happen on a slow connection. Check your signal and try again — if it keeps failing, ask the organizer for the link.</p>
      <button class="primary" id="retry">Try again</button></div>`);
    $("#retry", w).onclick = () => renderJudge(params);
    app().replaceChildren(w);
    return;
  }
  // Judging must be explicitly opened by the organizer before judges can score.
  if (eventId !== "demo" && ev.judgingOpen !== true) {
    const w = el(`<div class="wrap"><a class="back" href="#/menu">← home</a>
      <h2>${esc(ev.name || "Judging")}</h2>
      <p class="empty">⏳ Judging hasn't opened yet.<br>The organizer will start it when the event begins.</p>
      <button class="primary" id="reload">Reload now</button>
      <p class="sub" style="text-align:center">Tap once the organizer says it's open.</p></div>`);
    $("#reload", w).onclick = () => renderJudge(params);
    app().replaceChildren(w);
    return;
  }
  LS.setActiveEvent(eventId);

  // A per-judge QR carries &judge=<id>; adopt it so scanning your own card
  // opens your ballot directly (overrides any prior judge on a shared phone).
  const judgeHint = params.get("judge");
  if (judgeHint && ev.judges.some((j) => j.id === judgeHint)) LS.judgeId = judgeHint;

  // Identify the judge.
  let judge = ev.judges.find((j) => j.id === LS.judgeId);
  if (!judge) {
    return pickJudge(ev, tableHint);
  }

  // State first (declared before the score subscription, which can fire sync).
  const submitted = {}; // teamCode -> criterionScores
  let stop = null;

  const myTeams = ev.teams
    .filter((t) => t.table === judge.table)
    .sort((a, b) => (a.dishNumber || 0) - (b.dishNumber || 0));

  let currentIdx = suggestedIndex(myTeams, ev.schedule);
  let currentTeamCode = myTeams[currentIdx]?.code || null;

  const c = el(`<div class="wrap judge"></div>`);
  c.appendChild(
    el(`<div class="jbar"><a class="back" href="#/menu">←</a>
      <div class="who"><div class="evname">${esc(ev.name || "")}</div><div class="whoj">${esc(
      judge.name
    )} · Table ${judge.table}</div></div>
      <button class="mini switch">switch</button></div>`)
  );
  c.querySelector(".switch").onclick = () => {
    localStorage.removeItem("tasteoff_judgeId");
    stop && stop();
    pickJudge(ev, tableHint);
  };

  const nav = el(`<div class="dishnav" id="dishnav"></div>`);
  c.appendChild(nav);
  const cardHost = el(`<div id="cardHost"></div>`);
  c.appendChild(cardHost);
  app().replaceChildren(c);

  function drawDishNav() {
    if (!document.body.contains(nav)) return;
    nav.replaceChildren();
    myTeams.forEach((t, i) => {
      const done = !!submitted[t.code];
      const chip = el(
        `<button class="dchip${i === currentIdx ? " cur" : ""}${
          done ? " done" : ""
        }">${done ? "✓ " : ""}${esc(t.code)}</button>`
      );
      chip.onclick = () => {
        currentIdx = i;
        currentTeamCode = t.code;
        drawDishNav();
        drawScoreCard();
      };
      nav.appendChild(chip);
    });
  }

  function drawScoreCard() {
    const team = myTeams[currentIdx];
    if (!team) return;
    currentTeamCode = team.code;
    const existing = submitted[team.code] || {};
    const pending = { ...existing };

    const card = el(`<div class="scorecard"></div>`);
    card.appendChild(
      el(`<div class="dishhead">
        <div class="dnum">Dish ${team.dishNumber ?? currentIdx + 1}</div>
        <div class="dcode">Team #${esc(team.code)}</div>
        ${team.serveTime ? `<div class="dtime">served ~${esc(team.serveTime)}</div>` : ""}
      </div>`)
    );
    if (team.dishDescription) {
      card.appendChild(el(`<div class="dishdesc">${esc(team.dishDescription)}</div>`));
    }

    ev.criteria.forEach((cr) => {
      const block = el(`<div class="critblock">
          <div class="critname">${esc(cr.name)} <span class="cw">${Math.round(
        cr.weight * 100
      )}%</span></div>
          <div class="descs"><span>${esc(cr.low || "")}</span><span>${esc(
        cr.high || ""
      )}</span></div>
          <div class="steps"></div>
        </div>`);
      const steps = block.querySelector(".steps");
      SCORE_STEPS.forEach((v) => {
        const b = el(`<button class="step${existing[cr.id] === v ? " sel" : ""}">${v}</button>`);
        b.onclick = () => {
          pending[cr.id] = v;
          [...steps.children].forEach((x) => x.classList.remove("sel"));
          b.classList.add("sel");
          updateSubmit();
        };
        steps.appendChild(b);
      });
      card.appendChild(block);
    });

    const submitBtn = el(`<button class="primary submit" disabled>Submit score</button>`);
    const status = el(`<div class="sstatus"></div>`);
    function updateSubmit() {
      const all = ev.criteria.every((cr) => typeof pending[cr.id] === "number");
      submitBtn.disabled = !all;
      submitBtn.textContent = submitted[team.code] ? "Update score" : "Submit score";
    }
    submitBtn.onclick = async () => {
      submitBtn.disabled = true;
      await submitScore(eventId, judge.id, judge.name, judge.table, team.code, pending);
      submitted[team.code] = { ...pending };
      status.textContent = "Saved ✓ (syncs automatically)";
      drawDishNav();
      // auto-advance to next unscored dish
      const next = myTeams.findIndex((t, i) => i > currentIdx && !submitted[t.code]);
      if (next >= 0) {
        setTimeout(() => {
          currentIdx = next;
          drawDishNav();
          drawScoreCard();
        }, 600);
      }
    };
    updateSubmit();
    card.appendChild(submitBtn);
    card.appendChild(status);

    const nvg = el(`<div class="prevnext">
      <button class="prev"${currentIdx === 0 ? " disabled" : ""}>← prev</button>
      <button class="next"${currentIdx >= myTeams.length - 1 ? " disabled" : ""}>next →</button>
    </div>`);
    nvg.querySelector(".prev").onclick = () => {
      if (currentIdx > 0) {
        currentIdx--;
        drawDishNav();
        drawScoreCard();
      }
    };
    nvg.querySelector(".next").onclick = () => {
      if (currentIdx < myTeams.length - 1) {
        currentIdx++;
        drawDishNav();
        drawScoreCard();
      }
    };
    card.appendChild(nvg);

    cardHost.replaceChildren(card);
  }

  drawDishNav();
  drawScoreCard();

  // Now that DOM + state exist, subscribe to this judge's submitted scores.
  // (In demo mode this callback fires synchronously, so it must come last.)
  stop = watchScores(eventId, (rows) => {
    rows
      .filter((r) => r.judgeId === judge.id)
      .forEach((r) => (submitted[r.teamCode] = r.criterionScores));
    if (!document.body.contains(c)) {
      stop && stop();
      return;
    }
    drawDishNav();
  });
}

function pickJudge(ev, tableHint) {
  const judges = tableHint ? ev.judges.filter((j) => j.table === tableHint) : ev.judges;
  const c = el(`<div class="wrap"><a class="back" href="#/menu">← home</a>
    <h2>${esc(ev.name || "Judging")}</h2>
    <p class="sub">Tap your name to start${tableHint ? ` (Table ${tableHint})` : ""}.</p>
    <div class="picklist"></div></div>`);
  const list = c.querySelector(".picklist");
  if (!judges.length) list.appendChild(el(`<p class="empty">No judges set up yet.</p>`));
  judges.forEach((j) => {
    const b = el(`<button class="pick">${esc(j.name)} <span>Table ${j.table}</span></button>`);
    b.onclick = () => {
      LS.judgeId = j.id;
      renderJudge(new URLSearchParams({ event: ev.id, table: j.table }));
    };
    list.appendChild(b);
  });
  app().replaceChildren(c);
}

function suggestedIndex(teams, schedule) {
  if (!teams.length || !schedule?.startTime) return 0;
  const now = new Date();
  const [h, m] = schedule.startTime.split(":").map(Number);
  const start = new Date();
  start.setHours(h, m, 0, 0);
  const elapsed = (now - start) / 60000;
  if (elapsed < 0) return 0;
  const idx = Math.floor(elapsed / (schedule.intervalMin || 5));
  return Math.max(0, Math.min(idx, teams.length - 1));
}

// ---------- RESULTS ----------
let resultsUnlocked = false;
async function renderResults() {
  const myToken = renderToken;
  const eventId = LS.activeEvent();
  const ev = await loadEvent(eventId);
  if (isStale(myToken)) return;
  if (!ev) {
    app().replaceChildren(
      el(`<div class="wrap"><a class="back" href="#/menu">← home</a><p class="empty">No event found.</p></div>`)
    );
    return;
  }
  if (ev.resultsPasscode && !resultsUnlocked) {
    return gate("Results passcode", (val) => {
      if (val === ev.resultsPasscode) {
        resultsUnlocked = true;
        renderResults();
      } else alert("Wrong passcode.");
    });
  }

  const c = el(`<div class="wrap results"></div>`);
  c.appendChild(el(`<div class="jbar"><a class="back" href="#/menu">←</a><div class="who">${esc(
    ev.name || "Results"
  )}</div><a class="mini" href="#/runner?event=${encodeURIComponent(ev.id)}">Runner sheet</a><a class="mini" href="#/instructions?event=${encodeURIComponent(ev.id)}">Participant instructions</a><button class="mini primary" id="pdf">⬇ Report (PDF)</button><button class="mini" id="xlsx">Excel</button><button class="mini" id="csv">CSV</button></div>`));
  const aw = eventAwards(ev);
  const pcTab = aw.peoples.enabled
    ? `<button class="tab" data-tab="peoples">People's Choice</button>`
    : "";
  const controls = el(`<div class="rcontrols">
      <div class="tabs"><button class="tab active" data-tab="board">Leaderboard</button><button class="tab" data-tab="analytics">Analytics</button>${pcTab}</div>
      <label class="reveal"><input type="checkbox" id="reveal"> reveal team names</label>
      <span class="prog" id="prog"></span>
    </div>`);
  c.appendChild(controls);
  const host = el(`<div id="rhost"></div>`);
  c.appendChild(host);
  app().replaceChildren(c);

  let reveal = false;
  let tab = "board";
  $("#reveal", c).onchange = (e) => {
    reveal = e.target.checked;
    draw();
  };
  controls.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => {
      tab = t.dataset.tab;
      controls.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
      draw();
    };
  });

  let latestScores = [];
  let latestPeoples = {};
  watchScores(eventId, (rows) => {
    latestScores = rows;
    draw();
  });
  if (aw.peoples.enabled) {
    watchPeoples(eventId, (counts) => {
      latestPeoples = counts || {};
      // Only re-render live if we're not the one typing (peoples tab handles its own inputs)
      if (tab !== "peoples") draw();
      else updatePeoplesRanking();
    });
  }

  let updatePeoplesRanking = () => {};

  function draw() {
    $("#prog", c).textContent = `${latestScores.length} score sheets in · ${ev.teams.length} dishes`;
    if (tab === "board") {
      const { scaled, minmax } = computeLeaderboards(ev.criteria, ev.teams, latestScores);
      const pcRanked = peoplesRanking(ev.teams, latestPeoples);
      const node = el(`<div>
        ${winnersSummary(ev, scaled, minmax, latestPeoples, aw, reveal)}
        <div class="boardpick">
          <label>Full standings
            <select id="boardSel">
              <option value="scaled">Judges — Scaled (all judges)</option>
              <option value="minmax">Judges — Min-Max (drop hi/low)</option>
              ${aw.peoples.enabled ? `<option value="peoples">People's Choice (${esc(aw.peoples.unit)})</option>` : ""}
            </select>
          </label>
        </div>
        <div id="fullBoard"></div>
        <p class="tienote">△ = position decided by tiebreaker (equal totals, broken by criterion priority).</p>
      </div>`);
      const drawBoard = () => {
        const v = $("#boardSel", node).value;
        $("#fullBoard", node).innerHTML =
          v === "peoples"
            ? peoplesBoard(pcRanked, aw, reveal)
            : board(v === "scaled" ? "Scaled (all judges)" : "Min-Max (drop hi/low)", v === "scaled" ? scaled : minmax, reveal);
        $(".tienote", node).style.display = v === "peoples" ? "none" : "block";
      };
      $("#boardSel", node).onchange = drawBoard;
      host.replaceChildren(node);
      drawBoard();
    } else if (tab === "analytics") {
      host.replaceChildren(renderAnalytics(ev, latestScores, reveal));
    } else if (tab === "peoples") {
      const node = renderPeoples(ev, latestPeoples, aw, reveal, (code, n) => {
        latestPeoples[code] = n;
        savePeoplesCount(eventId, code, n);
      });
      updatePeoplesRanking = node._update;
      host.replaceChildren(node);
    }
  }

  $("#csv", c).onclick = () => exportCSV(ev, latestScores, latestPeoples, aw);
  $("#xlsx", c).onclick = () => exportXLSX(ev, latestScores, latestPeoples, aw);
  $("#pdf", c).onclick = () => exportReportPDF(ev, latestScores, latestPeoples, aw);
}

// Winners banner: Judges' Choice top N (both methods) + People's Choice top N.
function winnersSummary(ev, scaled, minmax, counts, aw, reveal) {
  const nm = (r) => (reveal ? r.name || r.code : "Team #" + r.code);
  const list = (rows, key) =>
    rows
      .filter((r) => r.place)
      .slice(0, aw.judgesTopN)
      .map((r) => `<li><span class="pl">${ordinal(r.place)} Place</span> ${esc(nm(r))} <span class="sc">${r[key]}</span></li>`)
      .join("") || `<li class="none">no scores yet</li>`;

  const pcRanked = peoplesRanking(ev.teams, counts);
  const pcHasData = pcRanked.some((r) => r.count > 0);
  const pcBlock = aw.peoples.enabled
    ? `<div class="wcard peoples"><h4>People's Choice — top ${aw.peoples.topN}</h4><ol>${
        pcHasData
          ? pcRanked
              .slice(0, aw.peoples.topN)
              .map((r) => `<li><span class="pl">${ordinal(r.place)} Place</span> ${esc(reveal ? r.name || r.code : "Team #" + r.code)} <span class="sc">${r.count} ${esc(aw.peoples.unit.toLowerCase())}</span></li>`)
              .join("")
          : `<li class="none">no ${esc(aw.peoples.unit.toLowerCase())} counted yet</li>`
      }</ol></div>`
    : "";

  return `<div class="winners">
    <div class="wcard"><h4>Judges' Choice — top ${aw.judgesTopN} <small>(Scaled)</small></h4><ol>${list(scaled, "scaled")}</ol></div>
    <div class="wcard"><h4>Judges' Choice — top ${aw.judgesTopN} <small>(Min-Max)</small></h4><ol>${list(minmax, "minmax")}</ol></div>
    ${pcBlock}
  </div>`;
}

// Rank teams by People's Choice count (desc), unique places (ties broken by code).
function peoplesRanking(teams, counts) {
  const rows = teams.map((t) => ({ code: t.code, name: t.name, table: t.table, count: Number(counts[t.code]) || 0 }));
  rows.sort((a, b) => b.count - a.count || String(a.code).localeCompare(String(b.code)));
  let place = 0;
  rows.forEach((r, i) => {
    r.place = r.count > 0 ? i + 1 : null;
  });
  return rows;
}

// People's Choice entry + live ranking.
function renderPeoples(ev, counts, aw, reveal, onSave) {
  const node = el(`<div class="pc">
    <div class="pc-head"><h3>People's Choice — ${esc(aw.peoples.unit)} count</h3>
      <p class="hint">Enter the ${esc(aw.peoples.unit.toLowerCase())} counted at each team's box. Saves as you type; top ${aw.peoples.topN} win.</p></div>
    <div class="pc-rank" id="pcRank"></div>
    <div class="pc-grid" id="pcGrid"></div>
  </div>`);
  const grid = $("#pcGrid", node);
  const teams = [...ev.teams].sort((a, b) => (a.dishNumber || 0) - (b.dishNumber || 0));
  teams.forEach((t) => {
    const row = el(`<div class="pc-row">
      <span class="pc-code">${esc(t.code)}</span>
      <span class="pc-name">${reveal ? esc(t.name || "") : "<i>hidden</i>"}</span>
      <input class="pc-in" type="number" min="0" inputmode="numeric" value="${Number(counts[t.code]) || 0}">
    </div>`);
    const input = row.querySelector(".pc-in");
    input.onchange = () => {
      const n = Math.max(0, parseInt(input.value) || 0);
      input.value = n;
      onSave(t.code, n);
      counts[t.code] = n;
      update();
    };
    grid.appendChild(row);
  });

  function update() {
    const ranked = peoplesRanking(ev.teams, counts);
    const total = ranked.reduce((a, r) => a + r.count, 0);
    const top = ranked.filter((r) => r.count > 0).slice(0, aw.peoples.topN);
    $("#pcRank", node).innerHTML = `
      <div class="pc-total">${total} ${esc(aw.peoples.unit.toLowerCase())} total</div>
      <ol class="pc-winners">${
        top.length
          ? top.map((r) => `<li><span class="pl">${r.place}</span> ${esc(reveal ? r.name || r.code : "Team #" + r.code)} <b>${r.count}</b></li>`).join("")
          : `<li class="none">no ${esc(aw.peoples.unit.toLowerCase())} yet</li>`
      }</ol>`;
  }
  update();
  node._update = update;
  return node;
}

function board(title, rows, reveal) {
  const body = rows
    .map(
      (r) => `<tr class="${r.place === 1 ? "first" : ""}">
        <td class="pl">${r.place ?? "–"}${r.tieBroken ? '<span class="tie" title="tiebreak">△</span>' : ""}</td>
        <td>${reveal ? esc(r.name || r.code) : esc(r.code)}</td>
        <td class="tb">${esc(r.table)}</td>
        <td class="sc">${title.startsWith("Scaled") ? r.scaled : r.minmax}</td>
        <td class="jc">${r.judgeCount}</td>
      </tr>`
    )
    .join("");
  return `<div class="board"><h3>${esc(title)}</h3>
    <table><thead><tr><th>#</th><th>${reveal ? "Team" : "Code"}</th><th>Tbl</th><th>Score</th><th>Judges</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

// Full People's Choice standings table.
function peoplesBoard(rows, aw, reveal) {
  const body = rows
    .map(
      (r) => `<tr class="${r.place === 1 ? "first" : ""}">
        <td class="pl">${r.place ?? "–"}</td>
        <td>${reveal ? esc(r.name || r.code) : esc(r.code)}</td>
        <td class="tb">${esc(r.table)}</td>
        <td class="sc">${r.count}</td>
      </tr>`
    )
    .join("");
  return `<div class="board"><h3>People's Choice — ${esc(aw.peoples.unit)}</h3>
    <table><thead><tr><th>#</th><th>${reveal ? "Team" : "Code"}</th><th>Tbl</th><th>${esc(aw.peoples.unit)}</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

// Analytics tab content
function renderAnalytics(ev, scores, reveal) {
  if (!scores.length) return el(`<p class="empty">No scores yet — analytics appear as judges submit.</p>`);
  const a = eventAnalytics(ev.criteria, ev.teams, scores);
  const infl = criterionInfluence(ev.criteria, ev.teams, scores);
  const { scaled } = computeLeaderboards(ev.criteria, ev.teams, scores);
  const winner = scaled.find((r) => r.place === 1);
  const judgeName = Object.fromEntries((ev.judges || []).map((j) => [j.id, j.name]));

  const critBars = barChart(a.perCriterion.map((c) => ({ label: c.short, value: c.avg })), { max: 5, unit: "" });
  const disto = histogram(a.distribution);
  const genBars = divergingChart(
    a.judges.map((j) => ({ label: judgeName[j.judgeId] || j.judgeId, value: j.generosity })),
    { max: Math.max(0.5, ...a.judges.map((j) => Math.abs(j.generosity))) }
  );
  const consBars = barChart(
    a.judges.map((j) => ({ label: judgeName[j.judgeId] || j.judgeId, value: j.spread })),
    { max: Math.max(0.5, ...a.judges.map((j) => j.spread)), color: "#3b6ea5" }
  );
  const inflBars = divergingChart(infl.map((c) => ({ label: c.short, value: c.r })), { max: 1 });

  const card = (title, sub, body) =>
    `<div class="acard"><h4>${esc(title)}</h4>${sub ? `<p class="asub">${esc(sub)}</p>` : ""}${body}</div>`;

  // ---- result-integrity block ----
  const pa = panelAgreement(ev.criteria, ev.teams, scores);
  const wr = winnerRobustness(ev, scores);
  const dr = servingDrift(ev.criteria, ev.teams, scores);
  const outs = outlierBallots(ev.criteria, ev.teams, scores);
  const ig = integrityGrade(ev, scores, { pa, wr, dr, outs });
  const jn = (jid, fallback) => judgeName[jid] || fallback || jid; // judge names aren't blind
  const dishLbl = (code, name) => (reveal ? (name || "#" + code) : "Team #" + code);
  const integ = `<div class="acard integ">
    <h4>Result integrity</h4>
    <p class="asub">How much the panel agreed, how decisive the win was, and any scoring quirks.</p>
    ${gradeBadge(ig)}
    <div class="integ-grid">
      <div class="integ-item"><span class="integ-k">Panel agreement</span><b>${pa.r == null ? "—" : pa.r}</b><span class="integ-v">${esc(pa.label)}${pa.pairs ? ` · ${pa.pairs} pairs` : ""}</span></div>
      <div class="integ-item"><span class="integ-k">Winner margin</span><b>${wr ? wr.margin : "—"}</b><span class="integ-v">${wr ? `${wr.marginPct}% over 2nd${wr.tieBroken ? " · tiebroken" : ""}` : ""}</span></div>
      ${(() => { const rl = robustnessLabel(wr, (jid) => jn(jid)); return `<div class="integ-item"><span class="integ-k">Robustness</span><b class="${rl.cls}">${rl.tag}</b><span class="integ-v">${rl.detail}</span></div>`; })()}
      <div class="integ-item"><span class="integ-k">Serving drift</span><b>${dr ? (dr.slope > 0 ? "+" : "") + dr.slope : "—"}</b><span class="integ-v">${dr ? esc(dr.direction) : "not enough data"}</span></div>
    </div>
    ${outs.length
      ? `<div class="integ-out"><b>Outlier ballots</b> <span class="hint">a judge ≥1.0 off the dish's consensus</span><ul>${outs.slice(0, 6).map((o) => `<li>${esc(jn(o.judgeId, o.judgeName))} on ${esc(dishLbl(o.code, o.dish))}: <b>${o.judgeAvg}</b> vs ${o.consensus} (${o.delta > 0 ? "+" : ""}${o.delta})</li>`).join("")}</ul></div>`
      : `<p class="hint">No outlier ballots — every judge scored within 1.0 of each dish's consensus.</p>`}
  </div>`;

  const wrap = el(`<div class="analytics">
    <div class="astat">
      <div><b>${a.fieldAvg}</b><span>field average</span></div>
      <div><b>${a.strongest ? esc(a.strongest.short) : "–"}</b><span>strongest facet</span></div>
      <div><b>${a.weakest ? esc(a.weakest.short) : "–"}</b><span>weakest facet</span></div>
    </div>
    ${integ}
    <div class="agrid">
      ${card("Average score by criterion", "Which facets scored high across all dishes", critBars)}
      ${card("Score distribution", "How judges used the 1–5 scale", disto)}
      ${card("Judge generosity", "Above (+) or below (−) the field average", genBars)}
      ${card("Judge consistency", "Spread of a judge's scores — lower is steadier", consBars)}
      ${card("What drove the results", "Correlation of each facet with final score", inflBars)}
    </div>
    <div class="dishdive acard">
      <div class="dd-head"><h4>Dish deep-dive</h4>
        <select id="ddSel"></select></div>
      <div id="ddBody"></div>
    </div>
  </div>`);

  // Populate the dish selector with scored dishes (winner first).
  const scored = scaled.filter((r) => r.scaled > 0);
  const sel = $("#ddSel", wrap);
  const ddBody = $("#ddBody", wrap);
  const mmByCode = Object.fromEntries(
    computeLeaderboards(ev.criteria, ev.teams, scores).minmax.map((r) => [r.code, r])
  );
  scored.forEach((r) => {
    const label = reveal ? r.name || r.code : "Team #" + r.code;
    sel.appendChild(el(`<option value="${esc(r.code)}">${esc(label)} — ${r.scaled}</option>`));
  });

  function drawDish(code) {
    if (!code) {
      ddBody.replaceChildren(el(`<p class="hint">No scored dishes yet.</p>`));
      return;
    }
    const d = dishAnalytics(ev.criteria, ev.teams, scores, code);
    const srow = scaled.find((r) => r.code === code) || {};
    const mrow = mmByCode[code] || {};
    const nameOf = Object.fromEntries((ev.judges || []).map((j) => [j.id, j.name]));
    const facetBars = barChart(d.perCriterion.map((c) => ({ label: c.short, value: c.avg })), { max: 5 });
    const rdr = radar(dishFacets(ev.criteria, scores, code), { max: 5 });
    const judgeRows = d.perJudge
      .map(
        (j, i) => `<tr>
          <td>${esc(nameOf[j.judgeId] || j.judgeId)}</td>
          <td class="jt">${j.avg}</td>
          <td class="tot">${j.total}${i === 0 && d.perJudge.length > 1 ? ' <span class="hi">▲ high</span>' : ""}${
          i === d.perJudge.length - 1 && d.perJudge.length > 1 ? ' <span class="lo">▼ low</span>' : ""
        }</td>
        </tr>`
      )
      .join("");
    const vClass = d.verdict === "divisive" ? "divisive" : d.verdict === "strong consensus" ? "consensus" : "mid";

    ddBody.replaceChildren(
      el(`<div class="dd-detail">
        <div class="dd-meta">
          <span class="dd-rank">Scaled #${srow.place ?? "–"}${srow.tieBroken ? " △" : ""} · Min-Max #${mrow.place ?? "–"}</span>
          <span class="dd-verdict ${vClass}">${esc(d.verdict)} (σ ${d.judgeSpread})</span>
        </div>
        ${d.dishDescription ? `<p class="dd-desc">${esc(d.dishDescription)}</p>` : ""}
        <div class="dd-cols">
          <div class="dd-radar">${rdr}</div>
          <div class="dd-bars">${facetBars}</div>
        </div>
        <div class="dd-hl">${d.best ? `Best: <b>${esc(d.best.short)}</b> (${d.best.avg})` : ""}${
        d.worst && d.worst !== d.best ? ` · Weakest: <b>${esc(d.worst.short)}</b> (${d.worst.avg})` : ""
      }</div>
        <table class="dd-judges"><thead><tr><th>Judge</th><th>avg</th><th>total</th></tr></thead><tbody>${judgeRows}</tbody></table>
      </div>`)
    );
  }
  sel.onchange = () => drawDish(sel.value);
  drawDish(winner ? winner.code : scored[0] && scored[0].code);

  return wrap;
}

function judgesPerTeam(ev) {
  const a = ev.judges.filter((j) => j.table === "A").length;
  const b = ev.judges.filter((j) => j.table === "B").length;
  return Math.max(a, b) || 1;
}

function exportCSV(ev, scores, peoples, aw) {
  aw = aw || eventAwards(ev);
  const { scaled, minmax } = computeLeaderboards(ev.criteria, ev.teams, scores);
  const mmByCode = Object.fromEntries(minmax.map((r) => [r.code, r]));
  const pc = peoplesRanking(ev.teams, peoples || {});
  const pcByCode = Object.fromEntries(pc.map((r) => [r.code, r]));
  const head = ["Place(Scaled)", "Code", "Team", "Table", "Scaled", "Place(MinMax)", "MinMax", "Judges"];
  if (aw.peoples.enabled) head.push(aw.peoples.unit, "Place(People's)");
  const lines = [head];
  scaled.forEach((r) => {
    const mm = mmByCode[r.code] || {};
    const row = [r.place ?? "", r.code, r.name, r.table, r.scaled, mm.place ?? "", r.minmax, r.judgeCount];
    if (aw.peoples.enabled) {
      const p = pcByCode[r.code] || {};
      row.push(p.count ?? 0, p.place ?? "");
    }
    lines.push(row);
  });
  const csv = lines.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${ev.id}-results.csv`;
  a.click();
}

// Full post-event workbook: setup, judges, tally totals, dish detail,
// participants, raw scores and analytics — one sheet each.
function exportXLSX(ev, scores, peoples, aw) {
  const XLSX = window.XLSX;
  if (!XLSX) { alert("Spreadsheet library still loading — try again in a moment."); return; }
  aw = aw || eventAwards(ev);
  scores = scores || [];
  const criteria = ev.criteria || [];
  const teams = ev.teams || [];
  const judges = ev.judges || [];
  const nameOf = Object.fromEntries(judges.map((j) => [j.id, j.name]));
  const teamByCode = Object.fromEntries(teams.map((t) => [t.code, t]));
  const { scaled, minmax } = computeLeaderboards(criteria, teams, scores);
  const mmByCode = Object.fromEntries(minmax.map((r) => [r.code, r]));
  const pc = peoplesRanking(teams, peoples || {});
  const pcByCode = Object.fromEntries(pc.map((r) => [r.code, r]));
  const ea = eventAnalytics(criteria, teams, scores);
  const jById = Object.fromEntries(ea.judges.map((j) => [j.judgeId, j]));
  const tsStr = (t) => {
    const ms = t && t.seconds ? t.seconds * 1000 : typeof t === "number" ? t : null;
    return ms ? new Date(ms).toLocaleString() : "";
  };
  const wb = XLSX.utils.book_new();
  const add = (name, aoa) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name.slice(0, 31));

  // 1) Event + criteria
  add("Event", [
    ["tasteoff — event export"],
    ["Event", ev.name || ""], ["Event ID", ev.id || ""], ["Date", ev.eventDate || ""],
    ["Venue", ev.venue || ""], ["Status", ev.status || ""],
    ["Dish delivery", ev.deliveryMode === "dropoff" ? "Participant delivers to judging area" : "Runner picks up at serving time"],
    ["Official method", ev.officialMethod || "(both shown)"],
    ["Serving start", fmt12(ev.schedule && ev.schedule.startTime)],
    ["Interval (min)", (ev.schedule && ev.schedule.intervalMin) || ""],
    ["People's Choice", aw.peoples.enabled ? `On — "${aw.peoples.unit}", top ${aw.peoples.topN}` : "Off"],
    ["Judges' Choice — top N", aw.judgesTopN],
    ["Teams / dishes", teams.length], ["Judges", judges.length],
    ["Score sheets submitted", scores.length], ["Field average (1–5)", ea.fieldAvg],
    ["Exported", new Date().toLocaleString()],
    [], ["Criteria & weights"], ["Criterion", "Weight %", "Low note", "High note"],
    ...criteria.map((c) => [c.name, Math.round((c.weight || 0) * 100), c.low || "", c.high || ""]),
  ]);

  // 2) Judges (setup + behavior this event)
  const jAoa = [["Judge", "Table", "Ballots", "Avg (1–5)", "Generosity", "Std dev (σ)"]];
  judges.forEach((j) => { const a = jById[j.id] || {}; jAoa.push([j.name, j.table || "", a.n ?? 0, a.avg ?? "", a.generosity ?? "", a.spread ?? ""]); });
  ea.judges.forEach((a) => { if (!judges.some((j) => j.id === a.judgeId)) jAoa.push([nameOf[a.judgeId] || a.judgeId, "", a.n, a.avg, a.generosity, a.spread]); });
  add("Judges", jAoa);

  // 3) Leaderboard / tally totals
  const lbHead = ["Place (Scaled)", "Place (Min-Max)", "Code", "Team", "Table", "Dish #", "Scaled", "Min-Max", "Judges", "#5s"];
  if (aw.peoples.enabled) lbHead.push(aw.peoples.unit, "Place (People's)");
  lbHead.push("Tiebroken?");
  const lbAoa = [lbHead];
  scaled.forEach((r) => {
    const mm = mmByCode[r.code] || {};
    const row = [r.place ?? "", mm.place ?? "", r.code, r.name || "", r.table || "", r.dishNumber ?? "", r.scaled, r.minmax, r.judgeCount, r.fives ?? ""];
    if (aw.peoples.enabled) { const p = pcByCode[r.code] || {}; row.push(p.count ?? 0, p.place ?? ""); }
    row.push(r.tieBroken ? "yes" : "");
    lbAoa.push(row);
  });
  add("Leaderboard", lbAoa);

  // 4) Dish detail — per-criterion averages + consensus
  const ddAoa = [["Code", "Team", "Table", "Dish #", ...criteria.map((c) => c.shortName || c.name), "Judge spread σ", "Verdict"]];
  teams.forEach((t) => {
    const d = dishAnalytics(criteria, teams, scores, t.code);
    const byId = Object.fromEntries(d.perCriterion.map((p) => [p.id, p.avg]));
    ddAoa.push([t.code, t.name || "", t.table || "", t.dishNumber ?? "", ...criteria.map((c) => byId[c.id] ?? ""), d.judgeSpread ?? "", d.verdict || ""]);
  });
  add("Dish detail", ddAoa);

  // 5) Participants
  const pAoa = [["Code", "Team", "Table", "Dish #", "Serve/pickup time", "Dish description", "Contact name", "Contact email"]];
  [...teams].sort((a, b) => (a.dishNumber || 0) - (b.dishNumber || 0)).forEach((t) =>
    pAoa.push([t.code, t.name || "", t.table || "", t.dishNumber ?? "", fmt12(t.serveTime), t.dishDescription || "", t.contactName || "", t.contactEmail || ""]));
  add("Participants", pAoa);

  // 6) Raw scores (judge × dish × criterion)
  const rsAoa = [["Judge", "Table", "Code", "Team", "Dish #", ...criteria.map((c) => c.shortName || c.name), "Submitted"]];
  scores.forEach((s) => {
    const t = teamByCode[s.teamCode] || {};
    const cs = s.criterionScores || {};
    rsAoa.push([s.judgeName || nameOf[s.judgeId] || s.judgeId, s.table || t.table || "", s.teamCode, t.name || "", t.dishNumber ?? "", ...criteria.map((c) => cs[c.id] ?? ""), tsStr(s.submittedAt)]);
  });
  add("Raw scores", rsAoa);

  // 7) Analytics
  add("Analytics", [
    ["Event analytics"],
    ["Field average (1–5)", ea.fieldAvg], ["Score sheets", ea.totalSheets],
    ["Strongest facet", ea.strongest ? `${ea.strongest.name} (${ea.strongest.avg})` : ""],
    ["Weakest facet", ea.weakest ? `${ea.weakest.name} (${ea.weakest.avg})` : ""],
    [], ["Per-criterion average"], ["Criterion", "Avg", "n"],
    ...ea.perCriterion.map((c) => [c.name, c.avg, c.n]),
    [], ["Score distribution (1–5)"], ["Score", "Count"],
    ...ea.distribution.map((d) => [d.score, d.count]),
    [], ["Judge behavior"], ["Judge", "Ballots", "Avg", "Generosity", "Std dev σ"],
    ...ea.judges.map((j) => [nameOf[j.judgeId] || j.judgeId, j.n, j.avg, j.generosity, j.spread]),
  ]);

  XLSX.writeFile(wb, `${ev.id || "event"}-export.xlsx`);
}

// ---------- JUDGES DATABASE ----------
async function renderJudgesDB() {
  const myToken = renderToken;
  app().replaceChildren(
    el(`<div class="wrap"><a class="back" href="#/menu">← home</a><h2>Judge database</h2><p class="sub">Loading judges across all events…</p></div>`)
  );
  let [{ events, scoresByEvent }, roster] = await Promise.all([
    loadAllEventsWithScores(),
    listRoster(),
  ]);
  if (isStale(myToken)) return;
  // Fall back to in-memory demo data (e.g. local preview with no backend).
  if (!events.length) {
    const demo = getDemoData();
    if (demo) ({ events, scoresByEvent } = demo);
  }
  const rosterMap = Object.fromEntries(roster.map((r) => [r.id, r]));
  const allProfiles = judgeProfiles(rosterMap, events, scoresByEvent);

  const c = el(`<div class="wrap judgesdb"><a class="back" href="#/menu">← home</a>
    <h2>Judge Analytics</h2>
    <p class="sub" id="jsub"></p></div>`);
  c.querySelector(".back").after(hubTabs("analytics", "judges"));

  if (!allProfiles.length) {
    $("#jsub", c).textContent = "No judging data yet.";
    c.appendChild(el(`<p class="empty">No judging data yet. Once judges submit scores in an event, their profiles build here automatically.</p>`));
    app().replaceChildren(c);
    return;
  }

  // Event-type ("series") filter: total list, plus a per-type pick-list (e.g. "who's
  // judged Truffle Masters"). Series = the event name with its year stripped.
  const seriesOf = (e) => String(e.name || "").replace(/\s*\b(19|20)\d{2}\b.*$/, "").trim() || String(e.name || e.id);
  const seriesList = [...new Set(events.filter((e) => (scoresByEvent[e.id] || []).length).map(seriesOf))].sort();

  // ---- Dream Team builder ----
  const suggestedSize = (evs) => {
    const counts = evs.filter((e) => (scoresByEvent[e.id] || []).length).map((e) => (e.judges || []).length).filter(Boolean);
    if (!counts.length) return 5;
    counts.sort((a, b) => a - b);
    return counts[Math.floor(counts.length / 2)];
  };
  const dtCard = el(`<div class="dreamteam">
    <h3>🌟 Construct a Dream Team of Judges</h3>
    <p class="hint">Pick an event type — tasteoff drafts a balanced panel from everyone who's judged it, weighing experience, calibration (scoring near the field) and consistency. Tap a name for their full profile.</p>
    <div class="dt-controls">
      <label>Event type <select id="dtSeries">
        <option value="__all__">Any / all events</option>
        ${seriesList.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}
      </select></label>
      <label>Panel size <input id="dtSize" type="number" min="1" value="5"></label>
      <button class="primary" id="dtBuild">Build panel</button>
    </div>
    <div id="dtResult"></div>
  </div>`);
  const syncDtSize = () => {
    const v = $("#dtSeries", dtCard).value;
    const evs = v === "__all__" ? events : events.filter((e) => seriesOf(e) === v);
    $("#dtSize", dtCard).value = suggestedSize(evs);
  };
  function buildDream() {
    const series = $("#dtSeries", dtCard).value;
    const evs = series === "__all__" ? events : events.filter((e) => seriesOf(e) === series);
    const profs = judgeProfiles(rosterMap, evs, scoresByEvent).filter((p) => p.dishesScored > 0);
    const size = Math.max(1, parseInt($("#dtSize", dtCard).value) || 5);
    const out = $("#dtResult", dtCard);
    if (!profs.length) { out.innerHTML = `<p class="empty">No one has judged ${series === "__all__" ? "any events" : esc(series)} yet.</p>`; return; }
    const maxDish = Math.max(...profs.map((p) => p.dishesScored));
    const maxEv = Math.max(...profs.map((p) => p.eventsJudged));
    const scored = profs.map((p) => {
      const exp = 0.6 * (p.dishesScored / maxDish) + 0.4 * (p.eventsJudged / maxEv);
      const cal = 1 - Math.min(1, Math.abs(p.generosity) / 0.6);
      const con = 1 - Math.min(1, Math.abs((p.consistency || 0) - 0.8) / 0.8);
      return { p, fit: 0.45 * exp + 0.35 * cal + 0.20 * con };
    }).sort((a, b) => b.fit - a.fit);
    const pick = scored.slice(0, size).map((x) => x.p);
    const avgGen = Math.round((pick.reduce((a, p) => a + p.generosity, 0) / pick.length) * 100) / 100;
    out.innerHTML = `<div class="dt-head">Recommended panel of <b>${pick.length}</b>${series !== "__all__" ? ` for ${esc(series)}` : ""} · balance: avg ${avgGen >= 0 ? "+" : ""}${avgGen} vs field <small>(0 = perfectly fair)</small></div>`;
    const ol = el(`<ol class="dt-list"></ol>`);
    pick.forEach((p) => {
      const tags = [];
      if (p.eventsJudged >= 3 || p.dishesScored >= 40) tags.push(`<span class="tag steady">experienced</span>`);
      if (Math.abs(p.generosity) <= 0.15) tags.push(`<span class="tag neu">well-calibrated</span>`);
      else if (p.generosity > 0.15) tags.push(`<span class="tag gen">runs generous</span>`);
      else tags.push(`<span class="tag harsh">runs tough</span>`);
      if (p.consistency >= 0.5 && p.consistency <= 1.1) tags.push(`<span class="tag steady">consistent</span>`);
      const li = el(`<li class="dt-item" title="Tap for ${esc(p.name)}'s profile"><div class="dt-l"><span class="dt-name">${esc(p.name)}</span><span class="dt-tags">${tags.join("")}</span></div><div class="dt-stats">${p.eventsJudged} ev · ${p.dishesScored} ballots · avg ${p.avgScore} · ${p.generosity > 0 ? "+" : ""}${p.generosity} vs field · σ ${p.consistency}</div></li>`);
      li.onclick = () => showJudge(p);
      ol.appendChild(li);
    });
    out.appendChild(ol);
  }
  $("#dtSeries", dtCard).onchange = syncDtSize;
  $("#dtBuild", dtCard).onclick = buildDream;
  syncDtSize();
  c.appendChild(dtCard);

  const controls = el(`<div class="rcontrols">
    <label class="serieslbl">Event type
      <select id="jseries">
        <option value="__all__">All events (total)</option>
        ${seriesList.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}
      </select>
    </label>
  </div>`);
  const host = el(`<div id="jhost"></div>`);
  c.appendChild(el(`<div class="scoreblurb">
    <b>How to read this.</b> Every judge scores each dish <b>1–5</b> on each criterion. <b>Avg</b> is that judge's mean rating across every ballot. <b>vs field</b> is their generosity — how far above (+) or below (−) each event's average they tend to score, so it flags tough vs. generous graders. <b>σ</b> is consistency — the spread of their scores, where lower means steadier. <b>Ballots</b> = dishes scored, <b>Events</b> = events judged. Pick an event type to rank only the judges who've worked it.
  </div>`));
  c.appendChild(controls);
  c.appendChild(host);

  const rankCols = [
    { k: "eventsJudged", label: "Events" },
    { k: "dishesScored", label: "Ballots" },
    { k: "avgScore", label: "Avg" },
    { k: "generosity", label: "vs field" },
    { k: "consistency", label: "σ" },
  ];
  let sortK = "dishesScored";
  let sortDir = -1; // -1 desc, +1 asc (persists across event-type switches)
  let series = "__all__";

  // Judge stats popup (mirrors the participant-details modal).
  function showJudge(p) {
    const gTag =
      p.generosity > 0.15 ? `<span class="tag gen">generous +${p.generosity}</span>`
      : p.generosity < -0.15 ? `<span class="tag harsh">harsh ${p.generosity}</span>`
      : `<span class="tag neu">balanced</span>`;
    const cTag =
      p.consistency <= 0.8 ? `<span class="tag steady">very consistent</span>`
      : p.consistency >= 1.4 ? `<span class="tag swingy">high spread</span>`
      : `<span class="tag neu">typical spread</span>`;
    const facets = Object.keys(p.perCriterion || {}).map((k) => ({ short: k, value: p.perCriterion[k] }));
    const bars = facets.length ? barChart(facets.map((f) => ({ label: f.short, value: f.value })), { max: 5 }) : `<p class="hint">No per-criterion data.</p>`;
    const rdr = facets.length >= 3 ? radar(facets, { max: 5 }) : "";
    const track = (p.appearances || [])
      .map((a) => `<tr><td>${esc(a.event)}</td><td class="sc">${a.dishes}</td><td class="sc">${a.avg}</td><td class="${a.generosity > 0.15 ? "gen" : a.generosity < -0.15 ? "harsh" : ""}">${a.generosity > 0 ? "+" : ""}${a.generosity}</td></tr>`)
      .join("");
    const ov = el(`<div class="modal-ov"><div class="modal wide">
      <div class="dd-head"><h3>${esc(p.name)}</h3><button class="mini" id="jClose">close</button></div>
      <p class="sub">${p.eventsJudged} event(s) · ${p.dishesScored} dishes scored</p>
      <div class="jdb-stats">
        <div><b>${p.avgScore || "—"}</b><span>avg score</span></div>
        <div><b>${p.dishesScored ? (p.generosity > 0 ? "+" : "") + p.generosity : "—"}</b><span>vs field</span></div>
        <div><b>${p.dishesScored ? p.consistency : "—"}</b><span>spread (σ)</span></div>
      </div>
      <div class="jdb-tags">${gTag}${cTag}</div>
      ${gradeBadge(judgeGrade(p), "Overall")}
      <h4>Events judged</h4>
      <table class="dd-judges"><thead><tr><th>Event</th><th>Ballots</th><th>Avg</th><th>vs field</th></tr></thead><tbody>${track}</tbody></table>
      <h4>By criterion</h4>
      <div class="dd-cols">${rdr ? `<div class="dd-radar">${rdr}</div>` : ""}<div class="dd-bars">${bars}</div></div>
    </div></div>`);
    $("#jClose", ov).onclick = () => ov.remove();
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
    document.addEventListener("keydown", function esc2(e) { if (e.key === "Escape") { ov.remove(); document.removeEventListener("keydown", esc2); } });
    document.body.appendChild(ov);
  }

  function render() {
    const evs = series === "__all__" ? events : events.filter((e) => seriesOf(e) === series);
    const profiles = judgeProfiles(rosterMap, evs, scoresByEvent);
    const scoredEvents = evs.filter((e) => (scoresByEvent[e.id] || []).length).length;
    const totalBallots = profiles.reduce((a, p) => a + p.dishesScored, 0);
    const fieldAvg = totalBallots
      ? Math.round((profiles.reduce((a, p) => a + p.avgScore * p.dishesScored, 0) / totalBallots) * 100) / 100
      : 0;
    $("#jsub", c).innerHTML =
      series === "__all__"
        ? `${profiles.length} judge(s) across ${scoredEvents} event(s). Learned from every submitted ballot.`
        : `${profiles.length} judge(s) have judged <b>${esc(series)}</b> (${scoredEvents} event(s)) — your pick-list for the next one.`;

    // ---- Ranked leaderboard (sortable) ----
    const rankWrap = el(`<div class="jdb-rankwrap">
      <div class="jdb-rankhead"><h3>Rankings${series === "__all__" ? "" : " — " + esc(series)}</h3>
        <span class="rk-note">field avg <b>${fieldAvg}</b> · tap a judge for full stats · tap a column to sort · vs field: + generous, − tough · σ: lower = steadier</span></div>
      <div class="rk-scroll"><table class="jdb-rank">
        <thead><tr><th class="rk-num">#</th><th class="rk-name">Judge</th>
          ${rankCols.map((col) => `<th data-k="${col.k}">${col.label}</th>`).join("")}
          <th class="rk-g">Grade</th>
        </tr></thead><tbody></tbody></table></div>
    </div>`);
    const rankBody = $("tbody", rankWrap);
    const drawRank = () => {
      const sorted = [...profiles].sort(
        (a, b) =>
          (a[sortK] - b[sortK]) * sortDir ||
          b.dishesScored - a.dishesScored ||
          String(a.name).localeCompare(String(b.name))
      );
      rankBody.replaceChildren(
        ...sorted.map((p, i) => {
          const tr = el(`<tr class="rk-click" title="Tap for ${esc(p.name)}'s full stats">
            <td class="rk-num">${i + 1}</td>
            <td class="rk-name">${esc(p.name)}</td>
            <td>${p.eventsJudged}</td>
            <td class="rk-b">${p.dishesScored}</td>
            <td>${p.avgScore || "—"}</td>
            <td class="${p.generosity > 0.15 ? "gen" : p.generosity < -0.15 ? "harsh" : ""}">${
              p.dishesScored ? (p.generosity > 0 ? "+" : "") + p.generosity : "—"
            }</td>
            <td>${p.dishesScored ? p.consistency : "—"}</td>
            <td class="rk-g">${(() => { const g = judgeGrade(p); return g ? `<span class="gchip g${g.grade}" title="${g.score}/100 — ${esc(g.meaning)}">${g.grade}</span>` : "—"; })()}</td>
          </tr>`);
          tr.onclick = () => showJudge(p);
          return tr;
        })
      );
      rankWrap.querySelectorAll("th[data-k]").forEach((th) => {
        const on = th.dataset.k === sortK;
        th.classList.toggle("on", on);
        th.dataset.arrow = on ? (sortDir < 0 ? "▼" : "▲") : "";
      });
    };
    rankWrap.querySelectorAll("th[data-k]").forEach((th) => {
      th.onclick = () => {
        const k = th.dataset.k;
        if (sortK === k) sortDir = -sortDir;
        else { sortK = k; sortDir = k === "consistency" ? 1 : -1; } // steadiest-first for σ, high-first otherwise
        drawRank();
      };
    });
    drawRank();

    host.replaceChildren(rankWrap);
  }

  $("#jseries", c).onchange = (e) => { series = e.target.value; render(); };
  render();
  app().replaceChildren(c);
}

// ---------- RUNNER SHEET (organizer key: code -> joint -> pickup) ----------
async function renderRunner() {
  const myToken = renderToken;
  const eventId = LS.activeEvent();
  const ev = await loadEvent(eventId);
  if (isStale(myToken)) return;
  if (!ev) {
    app().replaceChildren(el(`<div class="wrap"><a class="back" href="#/menu">← home</a><p class="empty">No event found.</p></div>`));
    return;
  }
  if (ev.resultsPasscode && !resultsUnlocked) {
    return gate("Results passcode", (val) => {
      if (val === ev.resultsPasscode) { resultsUnlocked = true; renderRunner(); } else alert("Wrong passcode.");
    });
  }
  const teams = [...(ev.teams || [])].sort(
    (a, b) => (a.dishNumber || 0) - (b.dishNumber || 0) || String(a.serveTime).localeCompare(String(b.serveTime))
  );
  const anyTable = teams.some((t) => t.table);
  const rows = teams
    .map(
      (t) => `<tr>
        <td class="rt">${esc(fmt12(t.serveTime))}</td>
        <td class="tb">${t.dishNumber ?? ""}</td>
        <td class="rteam">${esc(t.name || "")}</td>
        ${anyTable ? `<td class="tb rtable">${esc(t.table || "—")}</td>` : ""}
        ${t.dishDescription ? `<td class="rd">${esc(t.dishDescription)}</td>` : "<td></td>"}
      </tr>`
    )
    .join("");
  const c = el(`<div class="wrap runner">
    <div class="jbar noprint"><a class="back" href="#/menu">←</a><div class="who">${esc(ev.name || "Runner sheet")}</div>
      <button class="mini" id="print">Print</button></div>
    <h2 class="runner-h">Runner sheet — pickup schedule</h2>
    <p class="runner-when">${esc(ev.name || "")}${ev.eventDate ? " · " + esc(fmtDay(ev.eventDate)) : ""} · pick up each dish at its time and deliver it to the judging table under a blind code.</p>
    <p class="sub noprint">Team names &amp; times only (no blind codes) — safe to hand to runners.</p>
    <table class="runner-table"><thead><tr><th>Pickup time</th><th>Dish #</th><th>Pick up from</th>${anyTable ? "<th>Deliver to</th>" : ""}<th>Dish</th></tr></thead>
      <tbody>${rows}</tbody></table>
  </div>`);
  $("#print", c).onclick = () => window.print();
  app().replaceChildren(c);
}

// ---------- PARTICIPANT INSTRUCTIONS (printable, one card per team) ----------
async function renderInstructions() {
  const myToken = renderToken;
  const eventId = LS.activeEvent();
  const ev = await loadEvent(eventId);
  if (isStale(myToken)) return;
  if (!ev) {
    app().replaceChildren(el(`<div class="wrap"><a class="back" href="#/menu">← home</a><p class="empty">No event found.</p></div>`));
    return;
  }
  const judges = ev.judges || [];
  const judgesAt = (tbl) => judges.filter((j) => (j.table || "A") === (tbl || "A")).length;
  const dropoff = ev.deliveryMode === "dropoff";
  const timeLbl = dropoff ? "Deliver by" : "Pickup time";
  const teams = [...(ev.teams || [])].sort(
    (a, b) => (a.dishNumber || 0) - (b.dishNumber || 0) || String(a.serveTime).localeCompare(String(b.serveTime))
  );
  const cards = teams
    .map((t) => {
      const jn = judgesAt(t.table);
      const portions = jn + 1;
      const portionLine = jn > 0
        ? `Bring <b>${portions} portions</b> of your dish — one for each of the ${jn} judge${jn === 1 ? "" : "s"} at your table, <b>plus one for photography</b>.`
        : `Bring <b>one portion per judge plus one extra</b> for photography.`;
      return `<section class="pi-card">
        <div class="pi-head"><span class="pi-brand">🔥 ${esc(ev.name || "Competition")}</span><span class="pi-tag">Participant instructions</span></div>
        <h2 class="pi-name">${esc(t.name || "Participant")}</h2>
        <div class="pi-dishrow"><span class="pi-lbl">Your dish</span><span class="pi-val">${esc(t.dishDescription || "—")}</span></div>
        <div class="pi-time">
          <div class="pi-time-l">
            <span class="pi-time-lbl">${dropoff ? "⏱ Deliver by" : "⏱ Pickup time"}</span>
            <span class="pi-time-sub">${dropoff ? "have your dish at the judging area by" : "have all portions plated &amp; ready — a runner collects at"}</span>
          </div>
          <span class="pi-time-val">${esc(fmt12(t.serveTime))}</span>
        </div>
        <div class="pi-rules">
          <div class="pi-rule"><span class="pi-num">1</span><p>${portionLine}</p></div>
          <div class="pi-rule"><span class="pi-num">2</span><p><b>No identifying marks.</b> Your dish and its servingware must carry <b>no logos, brands, names, stickers, signature garnishes or anything</b> that could identify you. Judging is 100% blind.</p></div>
          <div class="pi-rule"><span class="pi-num">3</span><p>${
            dropoff
              ? `<b>Deliver on time.</b> Bring all portions to the <b>judging area</b> by your appointed time. Dishes are received under a blind code — late dishes may not be judged.`
              : `<b>Be ready at your time.</b> Have all portions plated and ready at your pickup time — a <b>runner will collect</b> your dish and deliver it to the judges under a blind code.`
          }</p></div>
        </div>
      </section>`;
    })
    .join("");
  const c = el(`<div class="wrap instructions">
    <div class="jbar noprint"><a class="back" href="#/menu">←</a><div class="who">${esc(ev.name || "Participant instructions")}</div>
      <button class="mini" id="print">Print all</button></div>
    <p class="sub noprint">One instruction sheet per participant — print and hand out. Each shows their dish, entry time, portion count (judges + 1) and the blind-judging rules.</p>
    ${teams.length ? cards : `<p class="empty">No participants yet — add teams in Set up event.</p>`}
  </div>`);
  $("#print", c).onclick = () => window.print();
  app().replaceChildren(c);
}

// ---------- JUDGE CARD (printable: join QR + scoring rubric, one per table) ----------
async function renderJudgeCard() {
  const myToken = renderToken;
  const eventId = LS.activeEvent();
  const ev = await loadEvent(eventId);
  if (isStale(myToken)) return;
  if (!ev) {
    app().replaceChildren(el(`<div class="wrap"><a class="back" href="#/menu">← home</a><p class="empty">No event found.</p></div>`));
    return;
  }
  const base = location.origin + location.pathname;
  const crit = ev.criteria || [];
  const wtot = crit.reduce((a, c) => a + (+c.weight || 0), 0) || 1;
  const wpct = (c) => Math.round((+c.weight || 0) / wtot * 100);
  const judges = ev.judges || [];
  const multiTable = usedTables(ev).length > 1;
  const jUrl = (j) => `${base}#/judge?event=${encodeURIComponent(ev.id)}&table=${j.table || "A"}&judge=${encodeURIComponent(j.id)}`;
  const critRows = crit
    .map((c) => `<tr><td class="jc-crit">${esc(c.name)}</td><td class="jc-w">${wpct(c)}%</td><td class="jc-lo">${esc(c.low || "—")}</td><td class="jc-hi">${esc(c.high || "—")}</td></tr>`)
    .join("");
  const cards = judges
    .map((j, i) => {
      const tbl = j.table || "A";
      return `<section class="jc-card">
        <div class="pi-head"><span class="pi-brand">🔥 ${esc(ev.name || "Competition")}</span><span class="pi-tag">Judge card</span></div>
        <h2 class="jc-name">${esc(j.name || "Judge")}${multiTable ? ` <span class="jc-tablebadge">Table ${esc(tbl)}</span>` : ""}</h2>
        <div class="jc-top">
          <div class="jc-qr" id="jcqr${i}"></div>
          <div class="jc-scan">
            <h3 class="jc-h">Scan to start judging</h3>
            <ol class="jc-steps">
              <li>Point your phone camera at the code — it opens your ballot as <b>${esc(j.name || "you")}</b>${multiTable ? ` at Table ${esc(tbl)}` : ""}.</li>
              <li>Tap the <b>code</b> on each dish as it arrives and score every criterion <b>1–5</b>. Scores save automatically.</li>
            </ol>
            <p class="jc-url">${esc(jUrl(j))}</p>
          </div>
        </div>
        <h3 class="jc-gh">Scoring rubric — ${crit.length} criteria, 1 (low) → 5 (high)</h3>
        <table class="jc-table"><thead><tr><th>Criterion</th><th>Weight</th><th>A “1” means…</th><th>A “5” means…</th></tr></thead><tbody>${critRows}</tbody></table>
        <p class="jc-note"><b>Judge blind.</b> Dishes are anonymous, identified only by a code — score exactly what's on the plate. Weights are applied automatically; you just rate each criterion 1–5.</p>
      </section>`;
    })
    .join("");
  const empty = !judges.length
    ? (crit.length
        ? `<p class="empty">No judges yet — add judges in Set up event and each gets their own card.</p>`
        : `<p class="empty">Add judges and criteria in Set up event first — each judge gets a card with the rubric.</p>`)
    : "";
  const c = el(`<div class="wrap judgecard">
    <div class="jbar noprint"><a class="back" href="#/menu">←</a><div class="who">${esc(ev.name || "Judge cards")}</div>
      <button class="mini" id="print">Print all</button></div>
    <p class="sub noprint">One card per judge — print and hand each judge theirs. Scanning the code opens their ballot already set to their name${multiTable ? " and table" : ""}; the scoring rubric is printed on the card.</p>
    ${judges.length ? cards : empty}
  </div>`);
  app().replaceChildren(c);
  judges.forEach((j, i) => makeQR($("#jcqr" + i, c), jUrl(j)));
  $("#print", c).onclick = () => window.print();
}

// ---------- HISTORICAL ANALYSIS ----------
async function renderHistory(mode) {
  const myToken = renderToken;
  const title = mode === "restaurants" ? "Participant history" : "Event history";
  app().replaceChildren(
    el(`<div class="wrap"><a class="back" href="#/menu">← home</a><h2>${title}</h2><p class="sub">Loading past events…</p></div>`)
  );
  const { events, scoresByEvent } = await loadAllEventsWithScores();
  if (isStale(myToken)) return;
  // Prefer flagged historical events; fall back to all if none flagged.
  let hist = events.filter((e) => e.historical);
  if (!hist.length) hist = events;

  // Derive the "series" (event type) from each event name by stripping the year.
  const seriesOf = (e) => String(e.name || "").replace(/\s*\b(19|20)\d{2}\b.*$/, "").trim() || String(e.name || e.id);
  const seriesList = [...new Set(hist.map(seriesOf))].sort();
  let series = "__all__";
  let tab = mode === "restaurants" ? "restaurants" : "events";
  let pSortK = "avgScore"; // participants table sort column
  let pSortDir = -1; // -1 desc (high→low), +1 asc
  const idByName = {}; // event name -> id (for winner lookup)
  hist.forEach((e) => (idByName[e.name] = e.id));

  const isParts = tab === "restaurants";
  const c = el(`<div class="wrap history">
    <a class="back" href="#/menu">← home</a>
    <h2>${isParts ? "Participant Analytics" : "Event Analytics"}</h2>
    <p class="sub" id="hsub"></p>
    <div class="rcontrols">
      <label class="serieslbl">Event type
        <select id="seriesSel">
          <option value="__all__">All event types</option>
          ${seriesList.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}
        </select>
      </label>
    </div>
    <div id="hhost"></div>
  </div>`);
  c.querySelector(".back").after(hubTabs("analytics", isParts ? "participants" : "events"));
  const host = $("#hhost", c);
  $("#seriesSel", c).onchange = (e) => {
    series = e.target.value;
    draw();
  };
  const currentEvents = () => (series === "__all__" ? hist : hist.filter((e) => seriesOf(e) === series));

  function draw() {
    const evs = currentEvents();
    const overview = eventsOverview(evs, scoresByEvent);
    const restaurants = restaurantHistory(evs, scoresByEvent);
    const ballots = overview.reduce((a, e) => a + e.ballots, 0);
    $("#hsub", c).innerHTML = `${evs.length} event(s) · ${restaurants.length} participants · ${ballots} ballots${
      series === "__all__" ? "" : ` — <b>${esc(series)}</b> only`
    }. <a href="#/judges">Judge database →</a>`;
    if (tab === "events") {
      const gradeByName = {};
      evs.forEach((e) => { const g = integrityGrade(e, scoresByEvent[e.id] || []); if (g) gradeByName[e.name] = g; });
      const rows = overview
        .map(
          (e) => {
            const g = gradeByName[e.name];
            return `<tr class="clickrow" data-name="${esc(e.name)}">
            <td>${esc(e.name)}</td>
            <td class="tb">${e.teams}</td>
            <td class="tb">${e.judges}</td>
            <td class="tb">${e.ballots}</td>
            <td class="sc">${e.fieldAvg}</td>
            <td class="tb">${g ? `<span class="gchip g${g.grade}" title="Integrity ${g.score}/100 — ${esc(g.meaning)}">${g.grade}</span>` : "—"}</td>
            <td>🏆 ${esc(e.winner)}${
              e.publishedWinner && esc(e.publishedWinner) !== esc(e.winner)
                ? `<div class="pubwin">published: ${esc(e.publishedWinner)}</div>`
                : ""
            }</td>
          </tr>`;
          }
        )
        .join("");
      const node = el(`<div>
        <div class="scoreblurb">
          <b>How events are scored.</b> Judges rate every dish <b>1–5</b> on each weighted criterion. <b>Field avg</b> is the plain average of all those 1–5 ratings across the whole event. <b>Grade</b> is the result-integrity grade (A–F) — how much the panel agreed, how decisive the win was, and how clean the scoring was. The <b>Winner</b> is decided by the event's <em>official method</em>: <b>Scaled</b> or <b>Min-Max</b> (drops each dish's high &amp; low first). Tap an event for the full breakdown.
        </div>
        <div class="board"><table>
          <thead><tr><th>Event</th><th>Teams</th><th>Judges</th><th>Ballots</th><th>Field avg</th><th>Grade</th><th>Winner</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
          <p class="tienote">Tap an event to see why the winner won + the integrity breakdown.</p>
        </div>`);
      node.querySelectorAll(".clickrow").forEach((tr) => (tr.onclick = () => showWinner(idByName[tr.dataset.name])));
      host.replaceChildren(node);
    } else {
      const psorted = [...restaurants].sort(
        (a, b) => (a[pSortK] - b[pSortK]) * pSortDir || b.avgScore - a.avgScore || String(a.name).localeCompare(String(b.name))
      );
      const rows = psorted
        .map(
          (r, i) => `<tr class="clickrow" data-name="${esc(r.name)}">
            <td class="pl">${i + 1}</td>
            <td>${esc(r.name)}</td>
            <td class="tb">${r.appearances}</td>
            <td class="tb">${r.wins || "–"}</td>
            <td class="tb">${r.podiums || "–"}</td>
            <td class="tb">${ordinal(r.bestPlace)}</td>
            <td class="sc">${r.avgPlace}</td>
            <td class="sc">${r.avgScore}</td>
          </tr>`
        )
        .join("");
      const node = el(`<div>
        <div class="scoreblurb">
          <b>How scoring works.</b> Every judge rates each dish <b>1–5</b> on each criterion. An event's winner is set by its <em>official method</em>: <b>Scaled</b> (all judges' scores, each criterion weighted) or <b>Min-Max</b> (same, but each dish's single highest and lowest judge scores are dropped first). Those totals live on their scale and aren't comparable between events. The <b>Avg (1–5)</b> column below sidesteps that — it's the plain average of every 1–5 rating a participant received, so it reads the same across all events regardless of method or weighting.
        </div>
        <div class="board"><table>
          <thead><tr><th>#</th><th>Participant</th><th data-k="appearances">Events</th><th data-k="wins">Wins</th><th data-k="podiums">Top 3</th><th data-k="bestPlace">Best</th><th data-k="avgPlace">Avg place</th><th data-k="avgScore">Avg (1–5)</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
          <p class="tienote">Tap a column to sort · tap a participant for their profile · “Events” = events entered · “Avg (1–5)” = mean of every judge × criterion rating.</p>
        </div>`);
      node.querySelectorAll("th[data-k]").forEach((th) => {
        if (th.dataset.k === pSortK) th.dataset.arrow = pSortDir < 0 ? " ▼" : " ▲";
        th.onclick = () => {
          const k = th.dataset.k;
          if (pSortK === k) pSortDir = -pSortDir;
          else { pSortK = k; pSortDir = k === "bestPlace" || k === "avgPlace" ? 1 : -1; } // place cols: best first
          draw();
        };
      });
      node.querySelectorAll(".clickrow").forEach((tr) => {
        tr.onclick = () => showParticipant(tr.dataset.name);
      });
      host.replaceChildren(node);
    }
  }

  function showWinner(eventId) {
    const ev = hist.find((e) => e.id === eventId);
    if (!ev) return;
    const w = explainWinner(ev, scoresByEvent[eventId] || []);
    if (!w) {
      const ovn = el(`<div class="modal-ov"><div class="modal"><div class="dd-head"><h3>${esc(ev.name)}</h3><button class="mini" id="wClose">close</button></div><p class="empty">No scored results.</p></div></div>`);
      $("#wClose", ovn).onclick = () => ovn.remove();
      ovn.onclick = (e) => { if (e.target === ovn) ovn.remove(); };
      document.body.appendChild(ovn);
      return;
    }
    const critRows = w.topCriteria
      .map(
        (d) => `<tr><td>${esc(d.short)}</td><td class="sc">${d.winnerAvg}</td><td class="sc">${d.fieldAvg}</td><td class="sc ${d.delta >= 0 ? "pos" : "neg"}">${d.delta > 0 ? "+" : ""}${d.delta}</td></tr>`
      )
      .join("");
    const pub = ev.publishedWinner && ev.publishedWinner !== w.winner
      ? `<p class="pubnote">🏅 Published/announced winner: <b>${esc(ev.publishedWinner)}</b> — the trophy actually awarded that night. It differs from the score-computed leader shown here; this app ranks strictly from the judging spreadsheet, so the computed champion stays authoritative.</p>`
      : "";
    // Result integrity for this historical event.
    const scr = scoresByEvent[eventId] || [];
    const pa = panelAgreement(ev.criteria, ev.teams, scr);
    const wr = winnerRobustness(ev, scr);
    const dr = servingDrift(ev.criteria, ev.teams, scr);
    const outs = outlierBallots(ev.criteria, ev.teams, scr);
    const ig = integrityGrade(ev, scr, { pa, wr, dr, outs });
    const jn = Object.fromEntries((ev.judges || []).map((j) => [j.id, j.name]));
    const jname = (jid, fb) => jn[jid] || fb || jid;
    const integ = `<h4>Result integrity</h4>
      ${gradeBadge(ig)}
      <div class="integ-grid">
        <div class="integ-item"><span class="integ-k">Panel agreement</span><b>${pa.r == null ? "—" : pa.r}</b><span class="integ-v">${esc(pa.label)}</span></div>
        <div class="integ-item"><span class="integ-k">Winner margin</span><b>${wr ? wr.margin : "—"}</b><span class="integ-v">${wr ? `${wr.marginPct}% over 2nd${wr.tieBroken ? " · tiebroken" : ""}` : ""}</span></div>
        ${(() => { const rl = robustnessLabel(wr, (jid) => jname(jid)); return `<div class="integ-item"><span class="integ-k">Robustness</span><b class="${rl.cls}">${rl.tag}</b><span class="integ-v">${rl.detail}</span></div>`; })()}
        <div class="integ-item"><span class="integ-k">Serving drift</span><b>${dr ? (dr.slope > 0 ? "+" : "") + dr.slope : "—"}</b><span class="integ-v">${dr ? esc(dr.direction) : "not enough data"}</span></div>
      </div>
      ${outs.length ? `<p class="hint">Outlier ballots: ${outs.slice(0, 4).map((o) => esc(jname(o.judgeId, o.judgeName)) + " on " + esc(o.dish || "#" + o.code) + " (" + (o.delta > 0 ? "+" : "") + o.delta + ")").join("; ")}</p>` : `<p class="hint">No outlier ballots — every judge scored within 1.0 of each dish's consensus.</p>`}`;
    const ov = el(`<div class="modal-ov"><div class="modal wide">
      <div class="dd-head"><h3>🏆 ${esc(w.winner)}</h3><div class="dd-acts"><button class="mini primary" id="wPdf">⬇ PDF report</button><button class="mini" id="wClose">close</button></div></div>
      <p class="sub">${esc(ev.name)} · winner (${esc(w.method)})</p>
      ${pub}
      <p class="whytext">${esc(w.summary)}</p>
      <h4>Winner vs. field, by criterion</h4>
      <table class="dd-judges"><thead><tr><th>Criterion</th><th>Winner</th><th>Field</th><th>Δ</th></tr></thead><tbody>${critRows}</tbody></table>
      ${integ}
    </div></div>`);
    $("#wClose", ov).onclick = () => ov.remove();
    $("#wPdf", ov).onclick = () => exportReportPDF(ev, scr, {}, eventAwards(ev));
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
    document.body.appendChild(ov);
  }

  function showParticipant(name) {
    const p = participantProfile(currentEvents(), scoresByEvent, name);
    const track = p.appearances
      .map((a) => `<tr><td>${esc(a.event)}</td><td class="tb">${a.place ? ordinal(a.place) + " / " + a.field : "–"}</td><td class="sc">${a.score}</td></tr>`)
      .join("");
    const aff = p.affinity;
    const favor = aff.slice(0, 3).filter((a) => a.delta > 0.15);
    const tough = aff.slice(-3).reverse().filter((a) => a.delta < -0.15);
    const rdr = radar(p.facets.map((f) => ({ short: f.short, value: f.value })), { max: 5 });
    const facetBars = barChart(p.facets.map((f) => ({ label: f.short, value: f.value })), { max: 5 });
    const ov = el(`<div class="modal-ov"><div class="modal wide">
      <div class="dd-head"><h3>${esc(name)}</h3><button class="mini" id="pClose">close</button></div>
      <p class="sub">${p.appearances.length} event(s) · best facet <b>${p.best ? esc(p.best.short) : "–"}</b>${p.worst && p.worst !== p.best ? ` · weakest <b>${esc(p.worst.short)}</b>` : ""}</p>
      <div class="dd-cols"><div class="dd-radar">${rdr}</div><div class="dd-bars">${facetBars}</div></div>
      <h4>Track record</h4>
      <table class="dd-judges"><thead><tr><th>Event</th><th>Finish</th><th>Score</th></tr></thead><tbody>${track}</tbody></table>
      <h4>Judge affinity</h4>
      <p class="hint">${favor.length ? "Scored highest by: " + favor.map((a) => `${esc(a.judge)} (+${a.delta})`).join(", ") : "No strong high-scorers."}${tough.length ? " · Toughest: " + tough.map((a) => `${esc(a.judge)} (${a.delta})`).join(", ") : ""}</p>
    </div></div>`);
    $("#pClose", ov).onclick = () => ov.remove();
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
    document.body.appendChild(ov);
  }

  draw();
  app().replaceChildren(c);
}

// ---------- shared UI ----------
function gate(label, onSubmit) {
  const c = el(`<div class="wrap gate"><a class="back" href="#/menu">← home</a>
    <h2>🔒 ${esc(label)}</h2>
    <input type="password" id="pc" inputmode="numeric" placeholder="passcode">
    <button class="primary" id="go">Enter</button></div>`);
  const submit = () => onSubmit($("#pc", c).value.trim());
  $("#go", c).onclick = submit;
  $("#pc", c).addEventListener("keydown", (e) => e.key === "Enter" && submit());
  app().replaceChildren(c);
  setTimeout(() => $("#pc", c).focus(), 50);
}

function toast(msg) {
  const t = el(`<div class="toast">${esc(msg)}</div>`);
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, 1600);
}

function blankEvent(id) {
  return {
    id,
    name: "",
    status: "draft", // draft | live | done — planning lifecycle
    eventDate: "",
    venue: "",
    deliveryMode: "runner", // runner = a runner picks up; dropoff = participant delivers
    officialMethod: "scaled", // scaled | minmax — decides the winner & the PDF report ranking
    criteria: [],
    judges: [],
    teams: [],
    schedule: { startTime: "13:00", intervalMin: 5 },
    adminPasscode: "",
    resultsPasscode: "",
    awards: { judgesTopN: 3, peoples: { enabled: false, unit: "Coins", topN: 3 } },
  };
}

const STATUS_META = {
  draft: { label: "Draft", cls: "draft" },
  live: { label: "Live", cls: "live" },
  done: { label: "Done", cls: "done" },
};
const eventStatus = (ev) => (ev && STATUS_META[ev.status] ? ev.status : "draft");

function eventAwards(ev) {
  const a = ev.awards || {};
  return {
    judgesTopN: a.judgesTopN || 3,
    peoples: {
      enabled: !!(a.peoples && a.peoples.enabled),
      unit: (a.peoples && a.peoples.unit) || "Coins",
      topN: (a.peoples && a.peoples.topN) || 3,
    },
  };
}

function fmtDate(ts) {
  const ms = ts && ts.seconds ? ts.seconds * 1000 : null;
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Format an ISO date string (yyyy-mm-dd) as e.g. "Sep 15, 2026" without TZ drift.
function fmtDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return iso || "";
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function addMinutes(hhmm, mins) {
  const [h, m] = (hhmm || "13:00").split(":").map(Number);
  const d = new Date();
  d.setHours(h, m + mins, 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 24h "HH:MM" -> 12h "H:MM AM/PM" for human-facing sheets.
function fmt12(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || "");
  if (!m) return hhmm || "—";
  let h = +m[1];
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
}
