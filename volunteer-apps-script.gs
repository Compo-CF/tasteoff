/**
 * HouBBQ Throwdown volunteer form — Google Apps Script backend.
 *
 * WHAT IT DOES
 *   - doPost(): appends each form submission as a new row in a "Volunteer Signups" tab.
 *   - doGet():  returns the known volunteer names (from your candidate tab) so the
 *               form's dropdown can list them. Uses JSONP (?callback=) to avoid CORS.
 *
 * SETUP (one time)
 *   1. Open your Google Sheet (the one with the volunteer candidates).
 *   2. Extensions > Apps Script. Delete anything there and paste ALL of this file.
 *   3. Adjust the CONFIG constants below if your candidate tab/column differ.
 *   4. Click Deploy > New deployment > type: Web app.
 *        - Description: volunteer form
 *        - Execute as: Me
 *        - Who has access: Anyone
 *      Deploy, authorize when prompted, and COPY the Web app URL (ends in /exec).
 *   5. Paste that URL into volunteer.html as the ENDPOINT value (or send it to me).
 *   If you change this script later, redeploy: Deploy > Manage deployments >
 *   edit > Version: New version > Deploy (the /exec URL stays the same).
 */

// ===================== CONFIG =====================
var SIGNUP_TAB = "Volunteer Signups";   // tab the form writes to (created if missing)
var CANDIDATE_TAB_INDEX = 0;            // which existing tab holds your candidate list (0 = first tab)
var NAME_HEADER = "Name";               // header of the column holding candidate names
                                        // (falls back to column A if that header isn't found)
// =================================================

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(SIGNUP_TAB);
    if (!sh) {
      sh = ss.insertSheet(SIGNUP_TAB);
      sh.appendRow(["Timestamp", "Name", "Email", "Phone", "Availability", "Roles", "T-shirt", "Notes", "Added new name"]);
      sh.getRange(1, 1, 1, 9).setFontWeight("bold");
      sh.setFrozenRows(1);
    }
    sh.appendRow([
      new Date(),
      data.name || "",
      data.email || "",
      data.phone || "",
      (data.availability || []).join(", "),
      (data.roles || []).join(", "),
      data.shirt || "",
      data.notes || "",
      data.addedNewName ? "yes" : ""
    ]);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  var names = getCandidateNames();
  var body = JSON.stringify({ names: names });
  var cb = e && e.parameter && e.parameter.callback;
  if (cb) {
    return ContentService.createTextOutput(cb + "(" + body + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

function getCandidateNames() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var sh = sheets[CANDIDATE_TAB_INDEX];
  if (!sh) return [];
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var header = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var col = header.indexOf(NAME_HEADER.toLowerCase());
  if (col < 0) col = 0; // fall back to column A
  var seen = {}, out = [];
  for (var i = 1; i < values.length; i++) {
    var v = String(values[i][col] || "").trim();
    if (v && !seen[v]) { seen[v] = true; out.push(v); }
  }
  return out;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
