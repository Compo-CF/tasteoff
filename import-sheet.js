// import-sheet.js — build an event object from a spreadsheet.
// Two sources: an uploaded .xlsx/.csv file, or a shared Google Sheet URL.
// Uses SheetJS (window.XLSX), vendored locally.
//
// Expected tabs (case-insensitive; extra columns ignored):
//   Event    : Event ID | Event Name | Start Time | Interval | Admin Passcode | Results Passcode | Event Type
//   Criteria : Criterion | Short | Weight % | Low | High   (optional — if blank, the Event Type's preset is used)
//   Judges   : Judge | Table
//   Teams    : Code | Team | Table | Dish # | Serve Time | Dish Description

const SHEET_ALIASES = {
  event: ["event", "event info", "settings"],
  criteria: ["criteria", "criterion", "scoring"],
  judges: ["judges", "judge"],
  teams: ["teams", "team", "restaurants", "participants", "dishes"],
};

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24) || "x";
}

function findSheet(wb, key) {
  const names = wb.SheetNames;
  for (const alias of SHEET_ALIASES[key]) {
    const hit = names.find((n) => n.trim().toLowerCase() === alias);
    if (hit) return wb.Sheets[hit];
  }
  return null;
}

// header-keyed rows, with a lowercased-key lookup helper
function rows(ws) {
  if (!ws) return [];
  const arr = window.XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
  return arr.map((r) => {
    const low = {};
    for (const k of Object.keys(r)) low[k.trim().toLowerCase()] = r[k];
    return low;
  });
}

function pick(row, ...keys) {
  for (const k of keys) {
    const v = row[k.toLowerCase()];
    if (v !== undefined && v !== "") return v;
  }
  return "";
}

function addMinutes(hhmm, mins) {
  const [h, m] = String(hhmm || "13:00").split(":").map(Number);
  const t = (h || 0) * 60 + (m || 0) + mins;
  return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

function hm(h, m) {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function normTime(v, fallback) {
  if (v === "" || v == null) return fallback;
  // Excel Date object (SheetJS cellDates) — read wall-clock time.
  if (v instanceof Date && !isNaN(v)) return hm(v.getHours(), v.getMinutes());
  const s = String(v).trim();
  // "1:00:00 PM", "13:00", "2:05 pm"
  const ampm = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i);
  if (ampm) {
    let h = +ampm[1];
    const m = +ampm[2];
    const ap = (ampm[3] || "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return hm(h, m);
  }
  // Excel time serial (fraction of a day, e.g. 0.5868 → 14:05).
  const num = parseFloat(s);
  if (!Number.isNaN(num) && num > 0 && num < 1) {
    const mins = Math.round(num * 24 * 60);
    return hm(Math.floor(mins / 60) % 24, mins % 60);
  }
  return fallback;
}

export function workbookToEvent(wb) {
  // --- Event ---
  const evRows = rows(findSheet(wb, "event"));
  const e = evRows[0] || {};
  const startTime = normTime(pick(e, "start time", "start"), "13:00");
  const intervalMin = parseInt(pick(e, "interval", "interval minutes", "interval (min)")) || 5;
  const idRaw = pick(e, "event id", "id") || pick(e, "event name", "name") || "event";
  const id =
    String(idRaw)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "event";
  const name = pick(e, "event name", "name") || "Untitled Event";

  // --- Criteria ---
  const criteria = rows(findSheet(wb, "criteria"))
    .map((r) => {
      const nm = pick(r, "criterion", "name", "criteria");
      if (!nm) return null;
      let w = parseFloat(pick(r, "weight %", "weight", "weight%")) || 0;
      if (w > 1) w = w / 100; // accept "30" or "0.3"
      return {
        id: "c_" + slug(pick(r, "short", "short name") || nm),
        name: nm,
        shortName: pick(r, "short", "short name") || nm,
        weight: w,
        low: pick(r, "low", "low descrip", "low descriptor"),
        high: pick(r, "high", "high descrip", "high descriptor"),
      };
    })
    .filter(Boolean);

  // --- Judges ---
  const judges = rows(findSheet(wb, "judges"))
    .map((r, i) => {
      const nm = pick(r, "judge", "name", "judge name");
      if (!nm) return null;
      const table = (pick(r, "table", "tbl") || "A").toString().trim().toUpperCase().charAt(0) || "A";
      return { id: "j_" + slug(nm) + (i ? "_" + i : ""), name: nm, table: table === "B" ? "B" : "A" };
    })
    .filter(Boolean);

  // --- Teams ---
  let n = 0;
  const perTableCount = {};
  const teams = rows(findSheet(wb, "teams"))
    .map((r) => {
      const nm = pick(r, "team", "team name", "restaurant", "participant", "name");
      const code = String(pick(r, "code", "team #", "team number", "number")).trim();
      if (!nm && !code) return null;
      const table = (pick(r, "table", "tbl") || "A").toString().trim().toUpperCase().charAt(0);
      const tbl = table === "B" ? "B" : "A";
      perTableCount[tbl] = (perTableCount[tbl] || 0) + 1;
      const dishNumber = parseInt(pick(r, "dish #", "dish", "dish number", "order")) || perTableCount[tbl];
      return {
        code: code || `${tbl}${String(dishNumber).padStart(2, "0")}`,
        name: nm,
        table: tbl,
        dishNumber,
        serveTime: normTime(pick(r, "serve time", "serve", "time"), ""),
        dishDescription: pick(r, "dish description", "dish", "description", "menu"),
      };
    })
    .filter(Boolean);

  // Fill any missing serve times from the schedule, per table by dish order.
  ["A", "B"].forEach((tbl) => {
    const list = teams.filter((t) => t.table === tbl).sort((a, b) => a.dishNumber - b.dishNumber);
    list.forEach((t, idx) => {
      if (!t.serveTime) t.serveTime = addMinutes(startTime, idx * intervalMin);
    });
  });

  return {
    id,
    name,
    criteria,
    judges,
    teams,
    schedule: { startTime, intervalMin },
    adminPasscode: String(pick(e, "admin passcode", "admin")).trim(),
    resultsPasscode: String(pick(e, "results passcode", "results")).trim(),
    // Optional: when the Criteria tab is blank, the import flow fills criteria
    // from the matching saved/built-in Event Type preset.
    eventType: String(pick(e, "event type", "type", "template")).trim(),
  };
}

// ---- Event-type library import -------------------------------------------
// Long format: one row per criterion, grouped by "Event Type".
// Columns: Event Type | Category | Note | Criterion | Short | Weight % | Low | High
function findTypesSheet(wb) {
  const names = wb.SheetNames;
  const pref = names.find((n) => ["types", "event types", "templates", "type"].includes(n.trim().toLowerCase()));
  if (pref) return wb.Sheets[pref];
  for (const n of names) {
    const r = rows(wb.Sheets[n])[0];
    if (r && ("event type" in r || "type" in r || "type name" in r)) return wb.Sheets[n];
  }
  return wb.Sheets[names[0]];
}

export function workbookToTemplates(wb) {
  const rs = rows(findTypesSheet(wb));
  const groups = new Map(); // preserves insertion order
  for (const r of rs) {
    const tname = String(pick(r, "event type", "type", "type name")).trim();
    const cname = pick(r, "criterion", "name", "criteria");
    if (!tname || !cname) continue;
    if (!groups.has(tname)) {
      groups.set(tname, { name: tname, category: pick(r, "category") || "Custom", note: pick(r, "note") || "", criteria: [] });
    }
    const g = groups.get(tname);
    if ((!g.category || g.category === "Custom") && pick(r, "category")) g.category = pick(r, "category");
    if (!g.note && pick(r, "note")) g.note = pick(r, "note");
    let w = parseFloat(pick(r, "weight %", "weight", "weight%")) || 0;
    if (w > 1) w = w / 100;
    g.criteria.push({
      name: cname,
      shortName: pick(r, "short", "short name") || cname,
      weight: w,
      low: pick(r, "low", "low descrip", "low descriptor"),
      high: pick(r, "high", "high descrip", "high descriptor"),
    });
  }
  return [...groups.values()];
}

export async function parseFile(file) {
  const buf = await file.arrayBuffer();
  const wb = window.XLSX.read(buf, { type: "array" });
  return workbookToEvent(wb);
}

// Accepts a normal Google Sheets URL (…/spreadsheets/d/<ID>/…) OR a published
// URL. Fetches each tab as CSV via the gviz endpoint (needs the sheet shared so
// "anyone with the link can view"). Falls back with a clear error on CORS.
export async function parseGoogleSheet(url) {
  const m = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) throw new Error("That doesn't look like a Google Sheets link.");
  const id = m[1];
  const wb = { SheetNames: [], Sheets: {} };
  const tabs = ["Event", "Criteria", "Judges", "Teams"];
  let got = 0;
  for (const tab of tabs) {
    const csvUrl = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
    try {
      const res = await fetch(csvUrl);
      if (!res.ok) continue;
      const text = await res.text();
      if (text.trim().startsWith("<")) continue; // got an HTML error page, not CSV
      const ws = window.XLSX.read(text, { type: "string" }).Sheets.Sheet1;
      wb.SheetNames.push(tab);
      wb.Sheets[tab] = ws;
      got++;
    } catch (err) {
      throw new Error(
        "Couldn't read the Google Sheet from the browser (sharing or CORS). " +
          "Set sharing to 'Anyone with the link → Viewer', or download it as .xlsx and use Upload instead."
      );
    }
  }
  if (!got) throw new Error("No matching tabs found. Make sure the sheet is shared and has Event/Criteria/Judges/Teams tabs.");
  return workbookToEvent(wb);
}
