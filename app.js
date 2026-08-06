// app.js — tasteoff SPA: router + Admin / Judge / Results views.
import {
  loadEvent,
  saveEvent,
  saveEventSafe,
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
import { parseFile, parseGoogleSheet } from "./import-sheet.js";
import { eventAnalytics, dishFacets, dishAnalytics, criterionInfluence, judgeProfiles } from "./analytics.js";
import { barChart, divergingChart, histogram, radar } from "./charts.js";

// stable judge id from a name, so the same person links across events
function judgeKey(name) {
  return "j_" + String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);
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

const DEFAULT_EVENT_ID = "houbbq-2026";
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

async function render() {
  beginRender();
  const { path, params } = parseRoute();
  if (params.get("event")) LS.setActiveEvent(params.get("event"));
  // Home renders instantly. Data views call loadEvent(), which awaits auth
  // internally for real events and returns instantly for demo mode.
  if (path === "/admin") return renderAdmin();
  if (path === "/judge") return renderJudge(params);
  if (path === "/results") return renderResults();
  if (path === "/judges") return renderJudgesDB();
  return renderHome();
}

// ---------- HOME ----------
function renderHome() {
  app().replaceChildren(
    el(`
    <div class="wrap home">
      <div class="brand"><span class="logo">🍴</span> tasteoff</div>
      <p class="tag">Food-competition judging — score on your phone, results live.</p>
      <div class="cards">
        <a class="card judge" href="#/judge">
          <div class="ci">📝</div><h3>I'm a Judge</h3>
          <p>Score the dishes at your table.</p>
        </a>
        <a class="card results" href="#/results">
          <div class="ci">🏆</div><h3>Results</h3>
          <p>Live leaderboard (organizer).</p>
        </a>
        <a class="card admin" href="#/admin">
          <div class="ci">⚙️</div><h3>Set up event</h3>
          <p>Criteria, judges, teams, codes.</p>
        </a>
        <a class="card judgesdb" href="#/judges">
          <div class="ci">📊</div><h3>Judge database</h3>
          <p>How your judges behave over time.</p>
        </a>
      </div>
      <p class="foot">Add to Home Screen to use it like an app.</p>
      <a class="demo-link" href="#/judge?event=demo&table=A">Try the demo (no setup) →</a>
    </div>`)
  );
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
  c.appendChild(el(`<a class="back" href="#/">← home</a>`));
  c.appendChild(el(`<h2>Event setup</h2>`));

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
      const row = el(`
        <div class="evrow${isCur ? " cur" : ""}">
          <button class="evopen">
            <span class="evname">${esc(r.name)}${isCur ? " ·  current" : ""}</span>
            <span class="evmeta">${r.teamCount} teams · ${r.judgeCount} judges${
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

  function applyImported(imported) {
    const merged = { ...blankEvent(imported.id), ...imported };
    LS.setActiveEvent(merged.id);
    adminUnlocked = true;
    // Bump the token so any in-flight renderAdmin (still awaiting loadEvent)
    // sees itself as stale and won't clobber this imported view.
    beginRender();
    // Populate the form instantly from the parsed file — no Firebase round-trip.
    // The organizer reviews, then clicks "Save event" to persist.
    renderAdmin(merged);
    toast("Loaded ✓ — review below, then Save event");
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
  const meta = el(`
    <section class="panel">
      <label>Event ID (URL slug) <input id="a_id" value="${esc(ev.id)}"></label>
      <label>Event name <input id="a_name" value="${esc(ev.name)}"></label>
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
        <label>Top <input id="aw_ptop" type="number" min="1" value="${aw.peoples.topN}" style="width:64px"></label>
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

  // --- criteria ---
  const critSec = el(`<section class="panel"><div class="phead"><h3>Criteria &amp; weights</h3><button class="mini" id="addCrit">+ add</button></div><div id="critList"></div><div class="wtotal" id="wtotal"></div></section>`);
  c.appendChild(critSec);
  const critList = $("#critList", critSec);
  function drawCrit() {
    critList.replaceChildren();
    ev.criteria.forEach((cr, i) => {
      const row = el(`
        <div class="crow" data-i="${i}">
          <input class="cn" placeholder="Criterion (e.g. Flavor)" value="${esc(cr.name)}">
          <input class="cw" type="number" min="0" step="1" placeholder="%" value="${Math.round(
            (cr.weight || 0) * 100
          )}">
          <input class="cl" placeholder="Low descriptor" value="${esc(cr.low || "")}">
          <input class="ch" placeholder="High descriptor" value="${esc(cr.high || "")}">
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
    <button class="mini" id="autoCode">Auto-fill codes &amp; serve times</button></section>`);
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
    }));
  }
  $("#addT", tSec).onclick = () => {
    readTeams();
    ev.teams.push({ code: "", name: "", table: "A", dishNumber: null, serveTime: "", dishDescription: "" });
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
  drawTeams();

  function readMeta() {
    ev.id = $("#a_id").value.trim() || DEFAULT_EVENT_ID;
    ev.name = $("#a_name").value.trim();
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

  app().replaceChildren(c);
}

function showLinks(ev, box) {
  const base = location.origin + location.pathname;
  box.replaceChildren();
  ["A", "B"].forEach((tbl) => {
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
    app().replaceChildren(
      el(`<div class="wrap"><a class="back" href="#/">← home</a><p class="empty">No event found. Ask the organizer for the link.</p></div>`)
    );
    return;
  }
  LS.setActiveEvent(eventId);

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
    el(`<div class="jbar"><a class="back" href="#/">←</a>
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
  const c = el(`<div class="wrap"><a class="back" href="#/">← home</a>
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
      el(`<div class="wrap"><a class="back" href="#/">← home</a><p class="empty">No event found.</p></div>`)
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
  c.appendChild(el(`<div class="jbar"><a class="back" href="#/">←</a><div class="who">${esc(
    ev.name || "Results"
  )}</div><button class="mini" id="csv">export CSV</button></div>`));
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
      host.replaceChildren(
        el(`<div>
          ${winnersSummary(ev, scaled, minmax, latestPeoples, aw, reveal)}
          <div class="boards">
            ${board("Scaled (all judges)", scaled, reveal)}
            ${board("Min-Max (drop hi/low)", minmax, reveal)}
          </div>
          <p class="tienote">△ = position decided by tiebreaker (equal totals, broken by criterion priority).</p>
        </div>`)
      );
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
}

// Winners banner: Judges' Choice top N (both methods) + People's Choice top N.
function winnersSummary(ev, scaled, minmax, counts, aw, reveal) {
  const nm = (r) => (reveal ? r.name || r.code : "Team #" + r.code);
  const list = (rows, key) =>
    rows
      .filter((r) => r.place)
      .slice(0, aw.judgesTopN)
      .map((r) => `<li><span class="pl">${r.place}</span> ${esc(nm(r))} <span class="sc">${r[key]}</span></li>`)
      .join("") || `<li class="none">no scores yet</li>`;

  const pcRanked = peoplesRanking(ev.teams, counts);
  const pcHasData = pcRanked.some((r) => r.count > 0);
  const pcBlock = aw.peoples.enabled
    ? `<div class="wcard peoples"><h4>People's Choice — top ${aw.peoples.topN}</h4><ol>${
        pcHasData
          ? pcRanked
              .slice(0, aw.peoples.topN)
              .map((r) => `<li><span class="pl">${r.place}</span> ${esc(reveal ? r.name || r.code : "Team #" + r.code)} <span class="sc">${r.count} ${esc(aw.peoples.unit.toLowerCase())}</span></li>`)
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

  const wrap = el(`<div class="analytics">
    <div class="astat">
      <div><b>${a.fieldAvg}</b><span>field average</span></div>
      <div><b>${a.strongest ? esc(a.strongest.short) : "–"}</b><span>strongest facet</span></div>
      <div><b>${a.weakest ? esc(a.weakest.short) : "–"}</b><span>weakest facet</span></div>
    </div>
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

// ---------- JUDGES DATABASE ----------
async function renderJudgesDB() {
  const myToken = renderToken;
  app().replaceChildren(
    el(`<div class="wrap"><a class="back" href="#/">← home</a><h2>Judge database</h2><p class="sub">Loading judges across all events…</p></div>`)
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
  const profiles = judgeProfiles(rosterMap, events, scoresByEvent);

  const c = el(`<div class="wrap judgesdb"><a class="back" href="#/">← home</a>
    <h2>Judge database</h2>
    <p class="sub">${profiles.length} judge(s) · ${events.length} event(s). Learned from every submitted ballot.</p></div>`);

  if (!profiles.length) {
    c.appendChild(el(`<p class="empty">No judging data yet. Once judges submit scores in an event, their profiles build here automatically.</p>`));
    app().replaceChildren(c);
    return;
  }

  const list = el(`<div class="jdb-list"></div>`);
  profiles.forEach((p) => {
    const gTag =
      p.generosity > 0.15 ? `<span class="tag gen">generous +${p.generosity}</span>`
      : p.generosity < -0.15 ? `<span class="tag harsh">harsh ${p.generosity}</span>`
      : `<span class="tag neu">balanced</span>`;
    const cTag =
      p.consistency <= 0.8 ? `<span class="tag steady">very consistent</span>`
      : p.consistency >= 1.4 ? `<span class="tag swingy">high spread</span>`
      : `<span class="tag neu">typical spread</span>`;
    const crit = Object.keys(p.perCriterion)
      .map((k) => `<span class="pcrit">${esc(k)} <b>${p.perCriterion[k]}</b></span>`)
      .join("");
    list.appendChild(
      el(`<div class="jdb-card">
        <div class="jdb-head"><h3>${esc(p.name)}</h3><span class="jdb-meta">${p.eventsJudged} event(s) · ${p.dishesScored} dishes</span></div>
        <div class="jdb-stats">
          <div><b>${p.avgScore}</b><span>avg score</span></div>
          <div><b>${p.generosity > 0 ? "+" : ""}${p.generosity}</b><span>vs field</span></div>
          <div><b>${p.consistency}</b><span>spread (σ)</span></div>
        </div>
        <div class="jdb-tags">${gTag}${cTag}</div>
        <div class="jdb-crit">${crit}</div>
      </div>`)
    );
  });
  c.appendChild(list);
  app().replaceChildren(c);
}

// ---------- shared UI ----------
function gate(label, onSubmit) {
  const c = el(`<div class="wrap gate"><a class="back" href="#/">← home</a>
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
    criteria: [],
    judges: [],
    teams: [],
    schedule: { startTime: "13:00", intervalMin: 5 },
    adminPasscode: "",
    resultsPasscode: "",
    awards: { judgesTopN: 3, peoples: { enabled: false, unit: "Coins", topN: 2 } },
  };
}

function eventAwards(ev) {
  const a = ev.awards || {};
  return {
    judgesTopN: a.judgesTopN || 3,
    peoples: {
      enabled: !!(a.peoples && a.peoples.enabled),
      unit: (a.peoples && a.peoples.unit) || "Coins",
      topN: (a.peoples && a.peoples.topN) || 2,
    },
  };
}

function fmtDate(ts) {
  const ms = ts && ts.seconds ? ts.seconds * 1000 : null;
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function addMinutes(hhmm, mins) {
  const [h, m] = (hhmm || "13:00").split(":").map(Number);
  const d = new Date();
  d.setHours(h, m + mins, 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
