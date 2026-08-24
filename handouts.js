// handouts.js — printable handouts as PDFs (runner sheet, participant
// instructions, judge cards). Used on iOS home-screen (standalone) PWAs where
// window.print() is a silent no-op: we build a PDF and hand it to the native
// share sheet (Print / Save to Files / Mail). Elsewhere the app still uses the
// rich HTML print layouts via window.print().

const BRICK = [181, 54, 31];   // #B5361F
const INK = [30, 30, 30];
const MUTE = [110, 110, 110];
const LINE = [210, 205, 200];
const GOLD = [224, 138, 44];

function jspdf() {
  if (!window.jspdf || !window.jspdf.jsPDF) return null;
  return window.jspdf.jsPDF;
}
function fmt12(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || "");
  if (!m) return hhmm || "—";
  let h = +m[1];
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
}
function fmtDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return iso || "";
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function usedTables(ev) {
  const s = [...new Set([...(ev.teams || []).map((t) => t.table), ...(ev.judges || []).map((j) => j.table)].filter(Boolean))].sort();
  return s.length ? s : ["A"];
}
const sortedTeams = (ev) =>
  [...(ev.teams || [])].sort(
    (a, b) => (a.dishNumber || 0) - (b.dishNumber || 0) || String(a.serveTime).localeCompare(String(b.serveTime))
  );

// Draw a QR for `text` as filled squares (jsPDF has no SVG import).
function drawQR(doc, text, x, y, size) {
  if (!window.qrcode) return false;
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2;
  const cell = size / (n + quiet * 2);
  doc.setFillColor(255, 255, 255);
  doc.rect(x, y, size, size, "F");
  doc.setFillColor(0, 0, 0);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) doc.rect(x + (c + quiet) * cell, y + (r + quiet) * cell, cell, cell, "F");
    }
  }
  return true;
}

// ---------- RUNNER SHEET ----------
export function buildRunnerPdf(ev) {
  const jsPDF = jspdf();
  if (!jsPDF) { alert("PDF library still loading — try again in a moment."); return null; }
  const doc = new jsPDF({ unit: "pt", format: "letter", compress: true });
  const PW = 612, M = 44, U = PW - 2 * M, PH = 792;
  const teams = sortedTeams(ev);
  const anyTable = teams.some((t) => t.table);
  const dropoff = ev.deliveryMode === "dropoff";

  const cols = anyTable
    ? [{ h: dropoff ? "Deliver by" : "Pickup", w: 78 }, { h: "Dish #", w: 46 }, { h: "Pick up from", w: 190 }, { h: "To", w: 44 }, { h: "Dish", w: U - 358 }]
    : [{ h: dropoff ? "Deliver by" : "Pickup", w: 78 }, { h: "Dish #", w: 46 }, { h: "Pick up from", w: 210 }, { h: "Dish", w: U - 334 }];

  let y = 56;
  doc.setFont("helvetica", "bold"); doc.setFontSize(20); doc.setTextColor(...BRICK);
  doc.text("Runner sheet — pickup schedule", M, y);
  y += 6; doc.setDrawColor(...GOLD); doc.setLineWidth(2); doc.line(M, y, M + 210, y);
  y += 20;
  doc.setFont("helvetica", "normal"); doc.setFontSize(10.5); doc.setTextColor(...MUTE);
  const sub = `${ev.name || ""}${ev.eventDate ? " · " + fmtDay(ev.eventDate) : ""}`;
  doc.text(sub, M, y); y += 14;
  doc.text(dropoff ? "Receive each dish at its time under a blind code." : "Pick up each dish at its time and deliver it to the judging table under a blind code.", M, y);
  y += 22;

  function header() {
    doc.setFillColor(245, 240, 236); doc.rect(M, y - 12, U, 22, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor(...INK);
    let x = M + 6;
    cols.forEach((c) => { doc.text(c.h.toUpperCase(), x, y + 3); x += c.w; });
    y += 18;
  }
  header();
  doc.setFont("helvetica", "normal"); doc.setFontSize(10.5);

  teams.forEach((t, i) => {
    const dishStr = t.dishDescription || "";
    const dishCol = cols[cols.length - 1];
    const dishLines = doc.splitTextToSize(dishStr, dishCol.w - 8);
    const rowH = Math.max(20, dishLines.length * 12 + 6);
    if (y + rowH > PH - 40) { doc.addPage(); y = 56; header(); doc.setFont("helvetica", "normal"); doc.setFontSize(10.5); }
    if (i % 2 === 0) { doc.setFillColor(250, 249, 247); doc.rect(M, y - 12, U, rowH, "F"); }
    let x = M + 6;
    const cells = anyTable
      ? [fmt12(t.serveTime), String(t.dishNumber ?? ""), t.name || "", t.table || "—"]
      : [fmt12(t.serveTime), String(t.dishNumber ?? ""), t.name || ""];
    doc.setTextColor(...INK);
    cells.forEach((val, ci) => {
      doc.setFont("helvetica", ci === 0 ? "bold" : "normal");
      const line = doc.splitTextToSize(String(val), cols[ci].w - 8);
      doc.text(line, x, y + 2);
      x += cols[ci].w;
    });
    doc.setFont("helvetica", "normal"); doc.setTextColor(...MUTE);
    doc.text(dishLines, x, y + 2);
    y += rowH;
    doc.setDrawColor(...LINE); doc.setLineWidth(0.5); doc.line(M, y - 10, M + U, y - 10);
  });
  return doc;
}

// ---------- PARTICIPANT INSTRUCTIONS (one per page) ----------
export function buildInstructionsPdf(ev) {
  const jsPDF = jspdf();
  if (!jsPDF) { alert("PDF library still loading — try again in a moment."); return null; }
  const doc = new jsPDF({ unit: "pt", format: "letter", compress: true });
  const PW = 612, PH = 792, M = 54, U = PW - 2 * M;
  const teams = sortedTeams(ev);
  const judges = ev.judges || [];
  const judgesAt = (tbl) => judges.filter((j) => (j.table || "A") === (tbl || "A")).length;
  const dropoff = ev.deliveryMode === "dropoff";

  teams.forEach((t, idx) => {
    if (idx) doc.addPage();
    let y = 70;
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(...BRICK);
    doc.text((ev.name || "Competition").toUpperCase(), M, y);
    doc.setTextColor(...MUTE); doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    doc.text("Participant instructions", PW - M, y, { align: "right" });
    y += 8; doc.setDrawColor(...LINE); doc.setLineWidth(1); doc.line(M, y, PW - M, y);
    y += 34;
    doc.setFont("helvetica", "bold"); doc.setFontSize(26); doc.setTextColor(...INK);
    doc.text(doc.splitTextToSize(t.name || "Participant", U), M, y);
    y += 30;
    if (t.dishDescription) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(12); doc.setTextColor(...MUTE);
      doc.text("Your dish", M, y);
      doc.setTextColor(...INK); doc.setFontSize(12.5);
      const dl = doc.splitTextToSize(t.dishDescription, U - 90);
      doc.text(dl, M + 84, y);
      y += Math.max(20, dl.length * 15);
    }
    y += 8;
    // Prominent time block
    const boxH = 66;
    doc.setFillColor(248, 238, 232); doc.roundedRect(M, y, U, boxH, 10, 10, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(...BRICK);
    doc.text((dropoff ? "DELIVER BY" : "PICKUP TIME"), M + 18, y + 26);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(...MUTE);
    doc.text(dropoff ? "have your dish at the judging area by" : "have all portions plated & ready — a runner collects at", M + 18, y + 44);
    doc.setFont("helvetica", "bold"); doc.setFontSize(30); doc.setTextColor(...INK);
    doc.text(fmt12(t.serveTime), PW - M - 18, y + 42, { align: "right" });
    y += boxH + 30;

    const jn = judgesAt(t.table);
    const portions = jn + 1;
    const rules = [
      jn > 0
        ? `Bring ${portions} portions of your dish — one for each of the ${jn} judge${jn === 1 ? "" : "s"} at your table, plus one for photography.`
        : `Bring one portion per judge plus one extra for photography.`,
      `No identifying marks. Your dish and its servingware must carry no logos, brands, names, stickers, signature garnishes or anything that could identify you. Judging is 100% blind.`,
      dropoff
        ? `Deliver on time. Bring all portions to the judging area by your appointed time. Dishes are received under a blind code — late dishes may not be judged.`
        : `Be ready at your time. Have all portions plated and ready at your pickup time — a runner will collect your dish and deliver it to the judges under a blind code.`,
    ];
    rules.forEach((txt, i) => {
      doc.setFillColor(...BRICK); doc.circle(M + 10, y - 4, 10, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(255, 255, 255);
      doc.text(String(i + 1), M + 10, y, { align: "center" });
      doc.setFont("helvetica", "normal"); doc.setFontSize(11.5); doc.setTextColor(...INK);
      const lines = doc.splitTextToSize(txt, U - 34);
      doc.text(lines, M + 30, y - 1);
      y += Math.max(24, lines.length * 15 + 10);
    });
  });
  return doc;
}

// ---------- JUDGE CARDS (one per page: QR + rubric) ----------
export function buildJudgeCardsPdf(ev) {
  const jsPDF = jspdf();
  if (!jsPDF) { alert("PDF library still loading — try again in a moment."); return null; }
  const doc = new jsPDF({ unit: "pt", format: "letter", compress: true });
  const PW = 612, PH = 792, M = 54, U = PW - 2 * M;
  const base = location.origin + location.pathname;
  const crit = ev.criteria || [];
  const wtot = crit.reduce((a, c) => a + (+c.weight || 0), 0) || 1;
  const wpct = (c) => Math.round((+c.weight || 0) / wtot * 100);
  const judges = ev.judges || [];
  const multiTable = usedTables(ev).length > 1;
  const jUrl = (j) => `${base}#/judge?event=${encodeURIComponent(ev.id)}&table=${j.table || "A"}&judge=${encodeURIComponent(j.id)}`;

  judges.forEach((j, idx) => {
    if (idx) doc.addPage();
    let y = 70;
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(...BRICK);
    doc.text((ev.name || "Competition").toUpperCase(), M, y);
    doc.setTextColor(...MUTE); doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    doc.text("Judge card", PW - M, y, { align: "right" });
    y += 8; doc.setDrawColor(...LINE); doc.setLineWidth(1); doc.line(M, y, PW - M, y);
    y += 30;
    doc.setFont("helvetica", "bold"); doc.setFontSize(24); doc.setTextColor(...INK);
    doc.text(`${j.name || "Judge"}${multiTable ? "   (Table " + (j.table || "A") + ")" : ""}`, M, y);
    y += 24;

    const qrSize = 150;
    drawQR(doc, jUrl(j), M, y, qrSize);
    const tx = M + qrSize + 20;
    doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor(...INK);
    doc.text("Scan to start judging", tx, y + 14);
    doc.setFont("helvetica", "normal"); doc.setFontSize(10.5); doc.setTextColor(...INK);
    const steps = [
      `1.  Point your phone camera at the code — it opens your ballot as ${j.name || "you"}${multiTable ? " at Table " + (j.table || "A") : ""}.`,
      `2.  Tap the code on each dish as it arrives and score every criterion 1–5. Scores save automatically.`,
    ];
    let sy = y + 34;
    steps.forEach((s) => { const l = doc.splitTextToSize(s, U - qrSize - 20); doc.text(l, tx, sy); sy += l.length * 13 + 6; });
    y += qrSize + 24;

    doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(...BRICK);
    doc.text(`Scoring rubric — ${crit.length} criteria, 1 (low) to 5 (high)`, M, y);
    y += 14;
    // table
    const cw = [U * 0.30, 52, (U - U * 0.30 - 52) / 2, (U - U * 0.30 - 52) / 2];
    const hd = ["Criterion", "Weight", 'A "1" means…', 'A "5" means…'];
    doc.setFillColor(245, 240, 236); doc.rect(M, y, U, 20, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor(...INK);
    let hx = M + 6; hd.forEach((h, i) => { doc.text(h, hx, y + 13); hx += cw[i]; });
    y += 20;
    doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    crit.forEach((c) => {
      const c1 = doc.splitTextToSize(c.name || "", cw[0] - 8);
      const c3 = doc.splitTextToSize(c.low || "—", cw[2] - 8);
      const c4 = doc.splitTextToSize(c.high || "—", cw[3] - 8);
      const rh = Math.max(18, c1.length * 12, c3.length * 12, c4.length * 12) + 6;
      if (y + rh > PH - 90) { doc.addPage(); y = 70; }
      let x = M + 6;
      doc.setTextColor(...INK); doc.text(c1, x, y + 12); x += cw[0];
      doc.text(wpct(c) + "%", x, y + 12); x += cw[1];
      doc.setTextColor(...MUTE); doc.text(c3, x, y + 12); x += cw[2];
      doc.text(c4, x, y + 12);
      y += rh; doc.setDrawColor(...LINE); doc.setLineWidth(0.5); doc.line(M, y, M + U, y);
    });
    y += 16;
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(...INK);
    doc.text("Judge blind.", M, y);
    doc.setFont("helvetica", "normal"); doc.setTextColor(...MUTE);
    const note = doc.splitTextToSize(" Dishes are anonymous, identified only by a code — score exactly what's on the plate. Weights are applied automatically; you just rate each criterion 1–5.", U - 58);
    doc.text(note, M + 58, y);
  });
  return doc;
}

// True when running as an iOS home-screen (standalone) web app, where
// window.print() does nothing and window.open() is blocked.
export function isIosStandalone() {
  const standalone =
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  const iOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return standalone && iOS;
}

// On desktop / in-browser Safari / Android: window.print() the rich HTML.
// On an iOS home-screen app: build the PDF and open the native share sheet
// (Print / Save to Files / Mail), falling back to opening the PDF inline.
export async function printOrShare(buildDoc, filename, title) {
  if (!isIosStandalone()) { window.print(); return; }
  let doc;
  try { doc = await buildDoc(); } catch (e) { doc = null; }
  if (!doc) return;
  const blob = doc.output("blob");
  const file = new File([blob], filename, { type: "application/pdf" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: title || "tasteoff" });
      return;
    }
  } catch (e) {
    if (e && e.name === "AbortError") return; // user dismissed the sheet
  }
  // Fallback: open the PDF so iOS shows its own share/print controls.
  const url = URL.createObjectURL(blob);
  if (!window.open(url, "_blank")) location.href = url;
}
