// report.js — client-facing PDF results report for tasteoff.
// Branded multi-page report (cover, podium, leaderboard, charts, dish detail,
// methodology). Uses the vendored jsPDF (window.jspdf) and draws charts on an
// offscreen canvas. Pure: depends only on scoring/analytics helpers + jsPDF.
import { computeLeaderboards } from "./scoring.js";
import { eventAnalytics, dishAnalytics } from "./analytics.js";

const RPT = {
  brick: "#B5361F", ember: "#E08A2C", gold: "#F0B44E", goldm: "#EBA93C",
  silver: "#B9BCC4", bronze: "#CB935E", ink: "#2A2320", card: "#FBF7F3",
  line: "#E7DCD2", muted: "#8A7E74", cream: "#FDF3E4", darkbrick: "#9E2E19", lightcream: "#F3D9C7",
};
function hx(h) { h = String(h).replace("#", ""); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function rclip(s, n) { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function rRound(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2); if (w <= 0) return;
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
// hi-DPI canvas → PNG dataURL
function chartPNG(wpx, hpx, drawFn) {
  const s = 3, cv = document.createElement("canvas");
  cv.width = wpx * s; cv.height = hpx * s;
  const ctx = cv.getContext("2d"); ctx.scale(s, s); ctx.textBaseline = "alphabetic";
  drawFn(ctx, wpx, hpx);
  return { data: cv.toDataURL("image/png"), w: wpx, h: hpx };
}
function chLeaderboard(rows, key, name) {
  const items = rows.slice(0, 10), wpx = 720, top = 44, rowH = 34, bottom = 12, left = 176, right = 54;
  const hpx = top + bottom + items.length * rowH;
  return chartPNG(wpx, hpx, (ctx) => {
    const maxV = Math.max(...items.map((r) => r[key])) || 1, barMax = wpx - left - right;
    ctx.fillStyle = RPT.brick; ctx.font = "bold 17px Helvetica,Arial"; ctx.textAlign = "left";
    ctx.fillText(`Top ${items.length} dishes — final score (${name})`, 8, 26);
    items.forEach((r, i) => {
      const y = top + i * rowH, col = r.place === 1 ? RPT.gold : (r.place <= 3 ? RPT.ember : RPT.brick);
      const bw = Math.max(3, (r[key] / maxV) * barMax);
      ctx.fillStyle = RPT.ink; ctx.font = "13px Helvetica,Arial"; ctx.textAlign = "right";
      ctx.fillText(rclip(r.name || "#" + r.code, 24), left - 10, y + rowH / 2 + 4);
      ctx.fillStyle = col; rRound(ctx, left, y + 6, bw, rowH - 14, 4); ctx.fill();
      ctx.fillStyle = RPT.ink; ctx.font = "bold 12px Helvetica,Arial"; ctx.textAlign = "left";
      ctx.fillText(Number(r[key]).toFixed(1), left + bw + 6, y + rowH / 2 + 4);
    });
  });
}
function chVBars(title, cats, vals, o = {}) {
  const { refLine = null, refLabel = "", color = RPT.ember, colorFn = null, max = 5, wpx = 344, hpx = 250, rot = false } = o;
  return chartPNG(wpx, hpx, (ctx) => {
    const top = 42, bottom = rot ? 74 : 34, left = 34, right = 12;
    const plotH = hpx - top - bottom, plotW = wpx - left - right;
    ctx.fillStyle = RPT.brick; ctx.font = "bold 14px Helvetica,Arial"; ctx.textAlign = "left"; ctx.fillText(title, 6, 22);
    ctx.strokeStyle = RPT.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, top); ctx.lineTo(left, top + plotH); ctx.lineTo(left + plotW, top + plotH); ctx.stroke();
    const n = vals.length, gap = plotW / n, bw = gap * 0.6, mv = max || Math.max(1, ...vals) * 1.18;
    if (refLine != null) {
      const ry = top + plotH - (refLine / mv) * plotH;
      ctx.setLineDash([5, 4]); ctx.strokeStyle = RPT.brick; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.moveTo(left, ry); ctx.lineTo(left + plotW, ry); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = RPT.brick; ctx.font = "bold 9px Helvetica,Arial"; ctx.textAlign = "left"; ctx.fillText(refLabel, left + 1, top - 2);
    }
    vals.forEach((v, i) => {
      const x = left + gap * i + (gap - bw) / 2, bh = Math.max(0, (v / mv) * plotH), y = top + plotH - bh;
      ctx.fillStyle = colorFn ? colorFn(i) : color; rRound(ctx, x, y, bw, bh, 3); ctx.fill();
      ctx.fillStyle = RPT.ink; ctx.font = "bold 9px Helvetica,Arial"; ctx.textAlign = "center";
      if (v) ctx.fillText(String(v), x + bw / 2, y - 3);
      ctx.fillStyle = RPT.ink; ctx.font = "9px Helvetica,Arial";
      if (rot) { ctx.save(); ctx.translate(x + bw / 2, top + plotH + 8); ctx.rotate(-Math.PI / 6); ctx.textAlign = "right"; ctx.fillText(rclip(cats[i], 15), 0, 0); ctx.restore(); }
      else { ctx.textAlign = "center"; ctx.fillText(rclip(cats[i], 9), x + bw / 2, top + plotH + 14); }
    });
  });
}
function chRadar(labels, winVals, fieldVals, max = 5) {
  const wpx = 300, hpx = 296;
  return chartPNG(wpx, hpx, (ctx) => {
    const cx = wpx / 2, cy = hpx / 2 + 8, R = 92, n = labels.length;
    const pt = (i, r) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
    ctx.strokeStyle = "#E0D5CB"; ctx.lineWidth = 1;
    [0.25, 0.5, 0.75, 1].forEach((f) => { ctx.beginPath(); labels.forEach((_, i) => { const [x, y] = pt(i, R * f); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); ctx.stroke(); });
    labels.forEach((lb, i) => {
      const [x, y] = pt(i, R); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
      const [lx, ly] = pt(i, R + 15); ctx.fillStyle = RPT.muted; ctx.font = "9.5px Helvetica,Arial"; ctx.textBaseline = "middle";
      ctx.textAlign = Math.abs(lx - cx) < 10 ? "center" : (lx > cx ? "left" : "right"); ctx.fillText(rclip(lb, 13), lx, ly);
    });
    ctx.textBaseline = "alphabetic";
    const poly = (vals, stroke, fillc, dash) => {
      ctx.beginPath(); vals.forEach((v, i) => { const [x, y] = pt(i, R * Math.max(0, Math.min(1, v / max))); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath();
      ctx.setLineDash(dash || []); ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.fillStyle = fillc; ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
    };
    poly(fieldVals, "#B7ABA0", "rgba(138,126,116,0.10)", [5, 4]);
    poly(winVals, RPT.brick, "rgba(181,54,31,0.22)");
    ctx.fillStyle = RPT.brick; ctx.font = "bold 15px Helvetica,Arial"; ctx.textAlign = "center"; ctx.fillText("Champion vs. field", cx, 18);
  });
}
function loadImgDataURL(url) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => { const cv = document.createElement("canvas"); cv.width = img.naturalWidth; cv.height = img.naturalHeight; cv.getContext("2d").drawImage(img, 0, 0); res(cv.toDataURL("image/png")); };
    img.onerror = () => res(null); img.src = url;
  });
}
function rdate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ""); if (!m) return iso || "";
  const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${MON[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}
function ordinal(n) { if (!n) return "unranked"; const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
// Mirrors app.js peoplesRanking: rank teams by crowd count, unplaced when 0.
function peoplesRanking(teams, counts) {
  const rows = (teams || []).map((t) => ({ code: t.code, name: t.name, table: t.table, count: Number((counts || {})[t.code]) || 0 }));
  rows.sort((a, b) => b.count - a.count || String(a.code).localeCompare(String(b.code)));
  rows.forEach((r, i) => { r.place = r.count > 0 ? i + 1 : null; });
  return rows;
}
// Horizontal People's Choice bar chart (crowd counts).
function chPeoples(items, unit) {
  const wpx = 720, top = 44, rowH = 32, bottom = 12, left = 176, right = 66;
  const hpx = top + bottom + items.length * rowH;
  return chartPNG(wpx, hpx, (ctx) => {
    const maxV = Math.max(...items.map((r) => r.count)) || 1, barMax = wpx - left - right;
    ctx.fillStyle = RPT.brick; ctx.font = "bold 17px Helvetica,Arial"; ctx.textAlign = "left";
    ctx.fillText(`People's Choice — ${unit} counted`, 8, 26);
    items.forEach((r, i) => {
      const y = top + i * rowH, col = i === 0 ? RPT.gold : (i < 3 ? RPT.ember : RPT.brick);
      const bw = Math.max(3, (r.count / maxV) * barMax);
      ctx.fillStyle = RPT.ink; ctx.font = "13px Helvetica,Arial"; ctx.textAlign = "right";
      ctx.fillText(rclip(r.name || "#" + r.code, 24), left - 10, y + rowH / 2 + 4);
      ctx.fillStyle = col; rRound(ctx, left, y + 6, bw, rowH - 14, 4); ctx.fill();
      ctx.fillStyle = RPT.ink; ctx.font = "bold 12px Helvetica,Arial"; ctx.textAlign = "left";
      ctx.fillText(String(r.count), left + bw + 6, y + rowH / 2 + 4);
    });
  });
}
export async function exportReportPDF(ev, scores, peoples, aw) {
  const doc = await buildReportDoc(ev, scores, peoples, aw);
  if (doc) doc.save(`${ev.id || "event"}-results-report.pdf`);
}
// Builds and returns the jsPDF doc (no download) — exported for testing/preview.
export async function buildReportDoc(ev, scores, peoples, aw) {
  if (!window.jspdf || !window.jspdf.jsPDF) { alert("PDF library still loading — try again in a moment."); return null; }
  scores = scores || [];
  const criteria = ev.criteria || [], teams = ev.teams || [], judges = ev.judges || [];
  if (!scores.length) { alert("No score sheets submitted yet — nothing to report."); return; }
  const nameOf = Object.fromEntries(judges.map((j) => [j.id, j.name]));
  const { scaled, minmax } = computeLeaderboards(criteria, teams, scores);
  const primary = ev.officialMethod === "minmax" ? "minmax" : "scaled";
  const other = primary === "minmax" ? "scaled" : "minmax";
  const PN = primary === "minmax" ? "Min-Max" : "Scaled";
  const ON = primary === "minmax" ? "Scaled" : "Min-Max";
  const rows = primary === "minmax" ? minmax : scaled;      // ranked by official method
  const ea = eventAnalytics(criteria, teams, scores);
  const wtot = criteria.reduce((a, c) => a + (+c.weight || 0), 0) || 1;
  const wpct = (c) => Math.round((+c.weight || 0) / wtot * 100);
  const equalW = new Set(criteria.map((c) => Math.round((+c.weight || 0) * 1e4))).size === 1;
  const win = rows[0], runner = rows[1];
  // per-dish facet averages + judge spread, computed once and reused
  const dishStats = teams.map((t) => {
    const d = dishAnalytics(criteria, teams, scores, t.code);
    return { code: t.code, name: t.name, spread: d.judgeSpread, verdict: d.verdict, by: Object.fromEntries((d.perCriterion || []).map((p) => [p.id, p.avg])) };
  });
  const dsByCode = Object.fromEntries(dishStats.map((d) => [d.code, d]));
  const fById = Object.fromEntries((ea.perCriterion || []).map((p) => [p.id, p.avg]));
  const winVals = criteria.map((c) => (dsByCode[win.code] || { by: {} }).by[c.id] || 0);
  const fieldVals = criteria.map((c) => fById[c.id] || 0);
  const wStrongIdx = winVals.indexOf(Math.max(...winVals));
  const margin = runner ? Math.round((win[primary] - runner[primary]) * 100) / 100 : 0;
  // notable dishes by judge agreement
  const spreads = dishStats.filter((d) => typeof d.spread === "number");
  const divisive = spreads.length ? spreads.reduce((a, b) => (b.spread > a.spread ? b : a)) : null;
  const tightest = spreads.length ? spreads.reduce((a, b) => (b.spread < a.spread ? b : a)) : null;
  // which dish topped each criterion
  const critChamp = criteria.map((c) => {
    let best = null; dishStats.forEach((d) => { const v = d.by[c.id]; if (v != null && (!best || v > best.v)) best = { name: d.name || "#" + d.code, v }; });
    return { crit: c.shortName || c.name, name: best ? best.name : "—", v: best ? best.v : "" };
  });
  // People's Choice
  const rankByCode = Object.fromEntries(rows.map((r) => [r.code, r.place]));
  const pcCfg = (aw && aw.peoples) || {};
  const pc = peoplesRanking(teams, peoples || {});
  const pcOn = !!pcCfg.enabled && pc.some((r) => r.count > 0);
  const pcUnit = pcCfg.unit || "votes";
  const pcTopN = pcCfg.topN || 3;
  const pcWin = pc[0];
  const pcAgree = pcOn && pcWin && win.code === pcWin.code;

  const iconURL = await loadImgDataURL("icons/icon-512.png");
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "letter", compress: true });
  const PW = 612, PH = 792, M = 50, U = PW - 2 * M;
  const setF = (s, sz) => { doc.setFont("helvetica", s); doc.setFontSize(sz); };
  const setC = (h) => { const [r, g, b] = hx(h); doc.setTextColor(r, g, b); };
  const fill = (h) => { const [r, g, b] = hx(h); doc.setFillColor(r, g, b); };
  const drawc = (h) => { const [r, g, b] = hx(h); doc.setDrawColor(r, g, b); };
  const T = (t, x, y, opt) => doc.text(String(t), x, y, opt);
  const wordmark = (x, y, sz, tasteC, offC) => {
    setF("bold", sz); setC(tasteC); T("taste", x, y);
    const tw = doc.getTextWidth("taste"); setC(offC); T("off", x + tw, y);
    return tw + doc.getTextWidth("off");
  };
  const addImg = (png, x, y, w) => doc.addImage(png.data, "PNG", x, y, w, w * png.h / png.w);

  // ---------- COVER ----------
  fill(RPT.brick); doc.rect(0, 0, PW, PH, "F");
  if (iconURL) doc.addImage(iconURL, "PNG", PW / 2 - 44, 96, 88, 88);
  const wmW = (() => { setF("bold", 40); return doc.getTextWidth("taste") + doc.getTextWidth("off"); })();
  wordmark(PW / 2 - wmW / 2, 250, 40, "#FFFFFF", RPT.gold);
  setF("normal", 11.5); setC(RPT.lightcream); T("Digital scorecards for food competitions", PW / 2, 272, { align: "center" });
  drawc(RPT.gold); doc.setLineWidth(2.4); doc.line(PW / 2 - 72, 288, PW / 2 + 72, 288);
  setF("bold", 13); setC("#FFFFFF"); T("RESULTS & ANALYTICS REPORT", PW / 2, 340, { align: "center" });
  setF("bold", 24); T(rclip(ev.name || "Event", 40), PW / 2, 372, { align: "center" });
  const meta = [rdate(ev.eventDate), ev.venue].filter(Boolean).join("  ·  ");
  if (meta) { setF("normal", 12.5); setC(RPT.lightcream); T(meta, PW / 2, 396, { align: "center" }); }
  const chips = [["DISHES", teams.length], ["JUDGES", judges.length], ["SCORES", scores.length], ["FIELD AVG", ea.fieldAvg]];
  const cw = 110, gp = 14, tot = chips.length * cw + (chips.length - 1) * gp; let sx = PW / 2 - tot / 2;
  chips.forEach(([lb, val]) => {
    fill(RPT.darkbrick); doc.roundedRect(sx, 436, cw, 66, 9, 9, "F");
    setF("bold", 23); setC(RPT.gold); T(String(val), sx + cw / 2, 472, { align: "center" });
    setF("bold", 8.5); setC(RPT.lightcream); T(lb, sx + cw / 2, 492, { align: "center" });
    sx += cw + gp;
  });
  setF("normal", 10); setC(RPT.lightcream); T("Prepared by subtlefoodie  ·  powered by tasteoff", PW / 2, PH - 58, { align: "center" });
  setF("normal", 8.5); T(`© ${new Date().getFullYear()} tasteoff, a subtlefoodie project. Confidential — prepared for event organizers.`, PW / 2, PH - 42, { align: "center" });

  // ---------- body page chrome ----------
  let pageNo = 0;
  const chrome = () => {
    wordmark(M, 34, 13, RPT.ink, RPT.brick);
    setF("normal", 8.2); setC(RPT.muted); T(rclip((ev.name || "") + "  ·  Results & Analytics", 60), PW - M, 34, { align: "right" });
    drawc(RPT.line); doc.setLineWidth(0.8); doc.line(M, 42, PW - M, 42);
    doc.line(M, PH - 40, PW - M, PH - 40);
    setF("normal", 8); setC(RPT.muted); T(`© ${new Date().getFullYear()} tasteoff, a subtlefoodie project`, M, PH - 28);
    T(`Page ${pageNo}`, PW - M, PH - 28, { align: "right" });
  };
  const newPage = () => { doc.addPage(); pageNo++; chrome(); return 66; };
  const h1 = (txt, y) => { setF("bold", 18); setC(RPT.brick); T(txt, M, y); drawc(RPT.gold); doc.setLineWidth(2.2); doc.line(M, y + 8, M + U, y + 8); return y + 26; };
  const para = (txt, y, sz = 10.3, col = RPT.ink) => {
    setF("normal", sz); setC(col); doc.setLineHeightFactor(1.34);
    const lines = doc.splitTextToSize(txt, U); doc.text(lines, M, y); return y + lines.length * sz * 1.34 + 4;
  };
  // hand-drawn table with auto page-break; returns new y
  const drawTable = (y, colW, headers, body, o = {}) => {
    const { hbg = RPT.brick, hfg = "#FFFFFF", fs = 9, rowH = 20, center = [], boldCol = -1, badges = {}, rowBg = {}, nameBold = -1 } = o;
    const totalW = colW.reduce((a, b) => a + b, 0);
    const header = () => {
      fill(hbg); doc.rect(M, y, totalW, rowH + 3, "F"); setF("bold", fs); setC(hfg);
      let cx = M; headers.forEach((h, ci) => { const c = center.includes(ci); T(rclip(h, 22), c ? cx + colW[ci] / 2 : cx + 6, y + rowH - 4, c ? { align: "center" } : undefined); cx += colW[ci]; });
      y += rowH + 3;
    };
    header();
    body.forEach((r, ri) => {
      if (y + rowH > PH - 52) { y = newPage(); header(); }
      if (rowBg[ri]) { fill(rowBg[ri]); doc.rect(M, y, totalW, rowH, "F"); }
      else if (ri % 2 === 1) { fill(RPT.card); doc.rect(M, y, totalW, rowH, "F"); }
      if (badges[ri]) { fill(badges[ri]); doc.rect(M, y, colW[0], rowH, "F"); }
      let cx = M;
      r.forEach((cell, ci) => {
        const c = center.includes(ci);
        if (badges[ri] && ci === 0) { setF("bold", fs + 3); setC("#FFFFFF"); }
        else { setF((ci === boldCol || (ci === nameBold)) ? "bold" : "normal", fs); setC(RPT.ink); }
        T(rclip(cell, ci === 1 ? 30 : 22), c ? cx + colW[ci] / 2 : cx + 6, y + rowH - 6, c ? { align: "center" } : undefined);
        cx += colW[ci];
      });
      drawc(RPT.line); doc.setLineWidth(0.5); doc.line(M, y + rowH, M + totalW, y + rowH);
      y += rowH;
    });
    return y;
  };

  // ---------- PAGE: EXECUTIVE SUMMARY ----------
  let y = newPage();
  y = h1("Executive summary", y);
  const methname = primary === "minmax" ? "Min-Max (trimmed high & low)" : "Scaled total";
  const wtxt = equalW ? "all criteria weighted equally" : `${criteria.length} weighted criteria`;
  y = para(`${ev.name || "The competition"} brought ${teams.length} dishes before ${judges.length} judges, who cast ${scores.length} blind score sheets across ${criteria.length} criteria (${wtxt}). Scoring was blind and tie-free; the official ranking method was ${methname}. The field averaged ${ea.fieldAvg} out of 5.`, y, 11);
  const facetName = (criteria[wStrongIdx] || {}).name || "";
  y = para(`${win.name || "#" + win.code} took first place with a ${PN} score of ${win[primary]} (${win[other]} ${ON.toLowerCase()})${runner ? `, edging out ${runner.name || "#" + runner.code} by ${margin} points` : ""}. Their strongest facet was ${facetName} (avg ${Math.max(...winVals)}). Across the field, judges scored highest on ${ea.strongest ? ea.strongest.name + " (" + ea.strongest.avg + ")" : "—"} and were toughest on ${ea.weakest ? ea.weakest.name + " (" + ea.weakest.avg + ")" : "—"}.`, y + 2);
  y += 6;
  const podBody = rows.slice(0, 3).map((r) => [String(r.place), r.name || "#" + r.code, String(r[primary]), String(r[other]), String(r.fives ?? "")]);
  y = drawTable(y, [58, 236, 96, 74, 48], ["Place", "Dish / Team", PN + " (official)", ON, "#5s"], podBody, {
    center: [0, 2, 3, 4], rowH: 26, fs: 10.5, boldCol: 2, nameBold: 1,
    badges: { 0: RPT.goldm, 1: RPT.silver, 2: RPT.bronze }, rowBg: { 0: RPT.cream },
  });
  y += 16;
  addImg(chLeaderboard(rows, primary, PN), M, y, U);

  // ---------- PAGE: FULL LEADERBOARD ----------
  y = newPage();
  y = h1("Full leaderboard", y);
  y = para(`Every dish, ranked by the official method (${PN}). Both scoring methods are shown for transparency; “#5s” counts perfect marks awarded.`, y, 9.6, RPT.ink);
  const lbBody = rows.map((r) => [String(r.place), r.name || "#" + r.code, r.table || "", String(r.dishNumber ?? ""), String(r[primary]), String(r[other]), String(r.judgeCount ?? ""), String(r.fives ?? "")]);
  const lbBadges = {}; rows.slice(0, 3).forEach((r, i) => { lbBadges[i] = [RPT.goldm, RPT.silver, RPT.bronze][i]; });
  y = drawTable(y, [30, 190, 48, 46, 74, 60, 46, 34], ["#", "Dish / Team", "Table", "Dish #", PN + " (off.)", ON, "Judges", "#5s"], lbBody, {
    center: [0, 2, 3, 4, 5, 6, 7], fs: 9, rowH: 19, boldCol: 4, badges: lbBadges,
  });

  // ---------- PAGE: PEOPLE'S CHOICE (only if enabled & has votes) ----------
  if (pcOn) {
    y = newPage();
    y = h1("People's Choice", y);
    const pcNote = pcAgree
      ? `The judges' champion and the crowd favorite were the same dish — ${win.name || "#" + win.code} swept both.`
      : `The judges crowned ${win.name || "#" + win.code}; the crowd's favorite was ${pcWin.name || "#" + pcWin.code}, which placed ${ordinal(rankByCode[pcWin.code])} on the judges' board.`;
    y = para(`Ranked by ${pcUnit.toLowerCase()} counted at each dish — the crowd's vote, tallied separately from the judges. Top ${pcTopN} take the award. ${pcNote}`, y, 10.3);
    const pcListed = pc.filter((r) => r.count > 0);
    const pcPng = chPeoples(pcListed.slice(0, 10), pcUnit);
    addImg(pcPng, M, y, U); y += U * pcPng.h / pcPng.w + 16;
    const pcBody = pcListed.slice(0, Math.max(pcTopN, 10)).map((r) => [String(r.place), r.name || "#" + r.code, r.table || "", String(r.count), rankByCode[r.code] ? ordinal(rankByCode[r.code]) : "—"]);
    const pcBadges = {}; pcListed.slice(0, 3).forEach((r, i) => { pcBadges[i] = [RPT.goldm, RPT.silver, RPT.bronze][i]; });
    y = drawTable(y, [40, 250, 60, 96, 72], ["#", "Dish / Team", "Table", pcUnit, "Judges' rank"], pcBody, { center: [0, 2, 3, 4], fs: 9.5, rowH: 20, badges: pcBadges });
  }

  // ---------- PAGE: ANALYTICS ----------
  y = newPage();
  y = h1("The judging, in analytics", y);
  y = para(`How the ${judges.length} judges used the scale, where the field was strong or soft, and how the champion's dish compared to the room.`, y, 9.6);
  const half = U / 2 - 8;
  const critChart = chVBars("Average by criterion", criteria.map((c) => c.shortName || c.name), criteria.map((c) => fById[c.id] || 0), { refLine: ea.fieldAvg, refLabel: "field " + ea.fieldAvg, color: RPT.ember, max: 5, rot: true });
  const dist = ea.distribution.slice().sort((a, b) => a.score - b.score);
  const distChart = chVBars("How judges scored (1–5)", dist.map((d) => String(d.score)), dist.map((d) => d.count), { color: RPT.gold, max: 0 });
  addImg(critChart, M, y, half); addImg(distChart, M + half + 16, y, half);
  y += half * critChart.h / critChart.w + 14;
  const jsorted = ea.judges.slice().sort((a, b) => b.avg - a.avg);
  const judgeChart = chVBars("Judge tendencies", jsorted.map((j) => (nameOf[j.judgeId] || j.judgeId).split(" ").slice(-1)[0]), jsorted.map((j) => j.avg), { refLine: ea.fieldAvg, refLabel: "field " + ea.fieldAvg, colorFn: (i) => (jsorted[i].generosity > 0 ? RPT.brick : RPT.ember), max: 5, rot: true });
  const radarChart = chRadar(criteria.map((c) => c.shortName || c.name), winVals, fieldVals, 5);
  addImg(judgeChart, M, y, half); addImg(radarChart, M + half + 16, y, half);
  y += Math.max(half * judgeChart.h / judgeChart.w, half * radarChart.h / radarChart.w) + 16;
  const jBody = jsorted.map((j) => {
    const tag = j.generosity > 0.15 ? "generous" : (j.generosity < -0.15 ? "tough" : "balanced");
    return [nameOf[j.judgeId] || j.judgeId, String(j.n), String(j.avg), `${j.generosity >= 0 ? "+" : ""}${j.generosity} (${tag})`, String(j.spread)];
  });
  y = drawTable(y, [150, 70, 66, 150, 76], ["Judge", "Ballots", "Avg", "Generosity", "Consistency (SD)"], jBody, { hbg: RPT.ink, center: [1, 2, 3, 4], fs: 9, rowH: 19 });

  // ---------- PAGE: DISH DETAIL ----------
  y = newPage();
  y = h1("Dish detail", y);
  y = para("Average score each dish earned on every criterion, plus how tightly the judges agreed (spread across dish-level averages).", y, 9.6);
  const sh = criteria.map((c) => (c.shortName || c.name).slice(0, 6));
  const shortVerdict = (v) => ({ "strong consensus": "tight", "some disagreement": "mixed", "divisive": "split", "single judge": "1 judge" }[v] || rclip(v || "", 8));
  const ddCols = [26, 150, ...criteria.map(() => (U - 26 - 150 - 46 - 56) / criteria.length), 46, 56];
  const ddBody = rows.map((r) => {
    const d = dsByCode[r.code] || { by: {}, spread: "", verdict: "" };
    return [String(r.place), r.name || "#" + r.code, ...criteria.map((c) => String(d.by[c.id] ?? 0)), String(d.spread ?? ""), shortVerdict(d.verdict)];
  });
  y = drawTable(y, ddCols, ["#", "Dish / Team", ...sh, "Spread", "Read"], ddBody, { center: [0, ...criteria.map((_, i) => i + 2), criteria.length + 2, criteria.length + 3], fs: 8.5, rowH: 18, badges: lbBadges });
  y += 14;
  setF("bold", 12.5); setC(RPT.ink); T("Highlights", M, y); y += 16;
  y = para("Criterion champions — " + critChamp.map((c) => `${c.crit}: ${c.name} (${c.v})`).join("   ·   "), y, 8.8, RPT.ink);
  if (divisive && tightest) y = para(`Most divisive dish: ${divisive.name || "#" + divisive.code} (judge spread ${divisive.spread}). Tightest consensus: ${tightest.name || "#" + tightest.code} (spread ${tightest.spread}).`, y, 8.8, RPT.ink);
  y += 6;
  setF("bold", 12.5); setC(RPT.ink); T("How scoring works", M, y); y += 16;
  const wline = equalW ? `all ${criteria.length} criteria carried equal weight (${wpct(criteria[0])}% each)` : criteria.map((c) => `${c.name} ${wpct(c)}%`).join(", ");
  y = para(`Criteria & weights: ${wline}.`, y, 8.4, RPT.muted);
  y = para("Scaled total sums every judge's weighted 1–5 marks. Min-Max (trimmed) drops each dish's single highest and lowest mark before summing (when 3+ judges scored it), reducing the pull of one outlier ballot. Rankings are tie-free: exact ties break on the alternate method, then on count of top marks. All scoring is blind — judges see a code, never a team name.", y, 8.4, RPT.muted);

  return doc;
}
