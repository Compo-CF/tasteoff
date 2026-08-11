/**
 * Volunteer form + tracking backend (Google Apps Script, bound to the sheet).
 *
 *   doPost()  — each signup is logged to "Volunteer Signups" AND added to "Check-in".
 *   doGet()   — returns candidate names (JSONP) for the form's dropdown.
 *   onEdit()  — ticking a "Checked in" box on the Check-in tab auto-stamps the time.
 *   onOpen()  — adds a "Volunteer Tools" menu to rebuild the Check-in list per event.
 *
 * This sheet is reusable across events: every row carries an Event column, so you can
 * sort/filter by event and rebuild the day-of Check-in list for whichever event you want.
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

var SIGNUP_HEADER = ["Timestamp", "Event", "Name", "Email", "Phone", "Availability", "Roles", "T-shirt", "Notes", "Added new name"];
var CHECKIN_HEADER = ["Name", "Phone", "Roles", "T-shirt", "Event", "Checked in", "Checked in at"];

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ev = data.event || EVENT_FALLBACK;

    var log = getOrCreate(ss, SIGNUP_TAB, SIGNUP_HEADER);
    log.appendRow([
      new Date(), ev, data.name || "", data.email || "", data.phone || "",
      (data.availability || []).join(", "), (data.roles || []).join(", "),
      data.shirt || "", data.notes || "", data.addedNewName ? "yes" : ""
    ]);

    var chk = getOrCreate(ss, CHECKIN_TAB, CHECKIN_HEADER);
    chk.appendRow([data.name || "", data.phone || "", (data.roles || []).join(", "), data.shirt || "", ev, false, ""]);
    chk.getRange(chk.getLastRow(), 6).insertCheckboxes();

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
    .addItem("Rebuild Check-in list…", "rebuildCheckin")
    .addToUi();
}

// Rebuild the Check-in tab from the signups log — optionally filtered to one event.
function rebuildCheckin() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var src = ss.getSheetByName(SIGNUP_TAB);
  if (!src) { ui.alert("No '" + SIGNUP_TAB + "' tab yet."); return; }

  var resp = ui.prompt("Rebuild Check-in", "Event to include (leave blank for ALL events):", ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var filter = resp.getResponseText().trim().toLowerCase();

  var old = ss.getSheetByName(CHECKIN_TAB);
  if (old) ss.deleteSheet(old);
  var sh = getOrCreate(ss, CHECKIN_TAB, CHECKIN_HEADER);

  var v = src.getDataRange().getValues(); // [Timestamp, Event, Name, Email, Phone, Availability, Roles, T-shirt, Notes, Added]
  var rows = [];
  for (var i = 1; i < v.length; i++) {
    var r = v[i];
    var ev = String(r[1] || "");
    if (filter && ev.toLowerCase().indexOf(filter) === -1) continue;
    rows.push([r[2] || "", r[4] || "", r[6] || "", r[7] || "", ev, false, ""]); // Name, Phone, Roles, T-shirt, Event
  }
  if (rows.length) {
    sh.getRange(2, 1, rows.length, CHECKIN_HEADER.length).setValues(rows);
    sh.getRange(2, 6, rows.length, 1).insertCheckboxes();
  }
  ui.alert("Check-in rebuilt: " + rows.length + " volunteer(s)" + (filter ? " for \"" + filter + "\"" : "") + ".");
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
