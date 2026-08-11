/**
 * Volunteer form + tracking backend (Google Apps Script, bound to the sheet).
 *
 *   doPost()  — each signup is logged to "Volunteer Signups".
 *   doGet()   — returns candidate names (JSONP) for the form's dropdown.
 *   onOpen()  — adds a "Volunteer Tools" menu; run "Generate Check-in list…" once
 *               signups are in to build the day-of Check-in tab.
 *   onEdit()  — ticking a "Checked in" box on the Check-in tab auto-stamps the time.
 *
 * NON-DESTRUCTIVE: your existing "Volunteer Signups" columns/data stay put. The new
 * "Event" column is added at the END and existing rows are backfilled automatically
 * on the next signup. Reusable across events — every row carries an Event tag.
 *
 * DEPLOY / UPDATE
 *   - Paste this whole file into Extensions > Apps Script (replace everything), Ctrl+S.
 *   - Deploy > Manage deployments > edit the deployment > Version: New version > Deploy.
 *     (Execute as: Me, Who has access: Anyone. The /exec URL stays the same.)
 *   - Reload the spreadsheet once so the "Volunteer Tools" menu appears.
 */

// ===================== CONFIG =====================
var SIGNUP_TAB = "Volunteer Signups";  // full log (one row per submission)
var CHECKIN_TAB = "Check-in";          // day-of check-in list (checkbox + time)
var CANDIDATE_TAB_INDEX = 0;           // tab holding your candidate list (0 = first tab)
var EVENT_FALLBACK = "houbbq-throwdown-2026"; // used if a submission doesn't send an event
// Candidate names: column A = Last name, column B = First name. Shown as "First Last".
// =================================================

// Event is LAST so it can be appended to an existing sheet without shifting old columns.
var SIGNUP_HEADER = ["Timestamp", "Name", "Email", "Phone", "Availability", "Roles", "T-shirt", "Notes", "Added new name", "Event"];
var CHECKIN_HEADER = ["Name", "Phone", "Roles", "T-shirt", "Event", "Checked in", "Checked in at"];
// Signups column positions (0-based) used when building the Check-in list:
var SI = { name: 1, phone: 3, roles: 5, shirt: 6, event: 9 };

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ev = data.event || EVENT_FALLBACK;

    var log = getOrCreate(ss, SIGNUP_TAB, SIGNUP_HEADER);
    ensureEventColumn(log, ev); // one-time migrate: add Event col + backfill old rows
    log.appendRow([
      new Date(), data.name || "", data.email || "", data.phone || "",
      (data.availability || []).join(", "), (data.roles || []).join(", "),
      data.shirt || "", data.notes || "", data.addedNewName ? "yes" : "", ev
    ]);

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  var body = JSON.stringify({ names: getCandidateNames() });
  var cb = e && e.parameter && e.parameter.callback;
  if (cb) return ContentService.createTextOutput(cb + "(" + body + ")").setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

// Auto-stamp the check-in time when the "Checked in" box is ticked (simple trigger).
function onEdit(e) {
  try {
    var sh = e.range.getSheet();
    if (sh.getName() !== CHECKIN_TAB) return;
    if (e.range.getColumn() !== 6 || e.range.getRow() < 2) return; // col F = "Checked in"
    sh.getRange(e.range.getRow(), 7).setValue(e.range.getValue() === true ? new Date() : "");
  } catch (err) { /* ignore */ }
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Volunteer Tools")
    .addItem("Generate Check-in list…", "rebuildCheckin")
    .addToUi();
}

// Rebuild the Check-in tab from the signups log — optionally filtered to one event.
function rebuildCheckin() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var src = ss.getSheetByName(SIGNUP_TAB);
  if (!src) { ui.alert("No '" + SIGNUP_TAB + "' tab yet."); return; }
  ensureEventColumn(src, EVENT_FALLBACK);

  var resp = ui.prompt("Generate Check-in list", "Event to include (leave blank for ALL events):", ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var filter = resp.getResponseText().trim().toLowerCase();

  var old = ss.getSheetByName(CHECKIN_TAB);
  if (old) ss.deleteSheet(old);
  var sh = getOrCreate(ss, CHECKIN_TAB, CHECKIN_HEADER);

  var v = src.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < v.length; i++) {
    var r = v[i];
    var ev = String(r[SI.event] || "");
    if (filter && ev.toLowerCase().indexOf(filter) === -1) continue;
    rows.push([r[SI.name] || "", r[SI.phone] || "", r[SI.roles] || "", r[SI.shirt] || "", ev, false, ""]);
  }
  if (rows.length) {
    sh.getRange(2, 1, rows.length, CHECKIN_HEADER.length).setValues(rows);
    sh.getRange(2, 6, rows.length, 1).insertCheckboxes();
  }
  ui.alert("Check-in list generated: " + rows.length + " volunteer(s)" + (filter ? " for \"" + filter + "\"" : "") + ".");
}

// If the signups sheet predates the Event column, add it at the end and backfill.
function ensureEventColumn(sh, ev) {
  var lastCol = sh.getLastColumn();
  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim().toLowerCase(); });
  if (header.indexOf("event") !== -1) return; // already has it
  var col = SI.event + 1; // 1-based target column (10)
  sh.getRange(1, col).setValue("Event").setFontWeight("bold");
  var lastRow = sh.getLastRow();
  if (lastRow > 1) {
    var fill = [];
    for (var i = 0; i < lastRow - 1; i++) fill.push([ev]);
    sh.getRange(2, col, lastRow - 1, 1).setValues(fill);
  }
}

function getCandidateNames() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheets()[CANDIDATE_TAB_INDEX];
  if (!sh) return [];
  var values = sh.getDataRange().getValues();
  if (!values.length) return [];
  // Column A = Last name, Column B = First name. Show as "First Last".
  var a0 = String(values[0][0] || "").toLowerCase();
  var b0 = String(values[0][1] || "").toLowerCase();
  var start = (/name|last|first/.test(a0) || /name|first|last/.test(b0)) ? 1 : 0;
  var seen = {}, out = [];
  for (var i = start; i < values.length; i++) {
    var last = String(values[i][0] || "").trim();
    var first = String(values[i][1] || "").trim();
    var full = (first + " " + last).replace(/\s+/g, " ").trim();
    if (!full) continue;
    var key = full.toLowerCase();
    if (!seen[key]) { seen[key] = true; out.push(full); }
  }
  out.sort(function (a, b) { return a.localeCompare(b); });
  return out;
}

// Get a tab by name, creating it with a bold, frozen header row if missing.
function getOrCreate(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(header);
    sh.getRange(1, 1, 1, header.length).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
