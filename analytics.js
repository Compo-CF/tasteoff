// analytics.js — pure analytics for the results dashboard + judge database.
// No DOM, no Firebase. Fed the same {criteria, teams, scores} the scoring engine uses.
import { computeLeaderboards } from "./scoring.js";

// Rank an event by its OFFICIAL method (Min-Max or Scaled, stored per event).
const methodOf = (ev) => (ev && ev.officialMethod === "minmax" ? "minmax" : "scaled");
const officialVal = (row, method) => (method === "minmax" ? row.minmax : row.scaled);
function officialRanked(ev, scores) {
  const lb = computeLeaderboards(ev.criteria || [], ev.teams || [], scores || []);
  return methodOf(ev) === "minmax" ? lb.minmax : lb.scaled;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
}

// Flatten scores into per-criterion values: [{judgeId, teamCode, critId, value}]
function flatten(scores) {
  const out = [];
  for (const s of scores) {
    const cs = s.criterionScores || {};
    for (const cid of Object.keys(cs)) {
      const v = cs[cid];
      if (typeof v === "number" && v > 0) out.push({ judgeId: s.judgeId, teamCode: s.teamCode, critId: cid, value: v });
    }
  }
  return out;
}

// ---- Event-level analytics -------------------------------------------------
export function eventAnalytics(criteria, teams, scores) {
  const flat = flatten(scores);
  const all = flat.map((f) => f.value);

  // Per-criterion average across every judge/dish (which facets score high/low)
  const perCriterion = criteria.map((c) => {
    const vals = flat.filter((f) => f.critId === c.id).map((f) => f.value);
    return { id: c.id, name: c.name, short: c.shortName || c.name, avg: round2(mean(vals)), n: vals.length };
  });

  // Score distribution over the 1..5 (0.5-step) scale
  const dist = {};
  for (let v = 1; v <= 5; v += 0.5) dist[v] = 0;
  all.forEach((v) => { if (dist[v] != null) dist[v]++; });
  const distribution = Object.keys(dist).map((k) => ({ score: +k, count: dist[k] }));

  // Judge behavior within this event
  const judgeIds = [...new Set(flat.map((f) => f.judgeId))];
  const fieldMean = mean(all);
  const judges = judgeIds.map((jid) => {
    const mine = flat.filter((f) => f.judgeId === jid);
    const vals = mine.map((f) => f.value);
    return {
      judgeId: jid,
      n: vals.length,
      avg: round2(mean(vals)),
      generosity: round2(mean(vals) - fieldMean), // + = scores above the field
      spread: round2(stdev(vals)), // higher = more variable scorer
    };
  });

  // Consensus agreement: how close each judge's dish totals are to the dish
  // average total (lower distance = more "with the room")
  const { scaled } = computeLeaderboards(criteria, teams, scores);
  const dishTotal = Object.fromEntries(scaled.map((r) => [r.code, r.scaled]));

  return {
    fieldAvg: round2(fieldMean),
    totalSheets: scores.length,
    perCriterion,
    distribution,
    judges: judges.sort((a, b) => b.avg - a.avg),
    strongest: [...perCriterion].sort((a, b) => b.avg - a.avg)[0] || null,
    weakest: [...perCriterion].sort((a, b) => a.avg - b.avg)[0] || null,
    dishTotal,
  };
}

// Radar data for one dish: its average score per criterion (0..5)
export function dishFacets(criteria, scores, teamCode) {
  const flat = flatten(scores).filter((f) => f.teamCode === teamCode);
  return criteria.map((c) => ({
    short: c.shortName || c.name,
    value: round2(mean(flat.filter((f) => f.critId === c.id).map((f) => f.value))),
  }));
}

// Deep analytics for a single dish.
export function dishAnalytics(criteria, teams, scores, teamCode) {
  const team = teams.find((t) => t.code === teamCode) || {};
  const flat = flatten(scores).filter((f) => f.teamCode === teamCode);
  const judges = [...new Set(flat.map((f) => f.judgeId))];

  const perCriterion = criteria.map((c) => {
    const vals = flat.filter((f) => f.critId === c.id).map((f) => f.value);
    return {
      id: c.id,
      name: c.name,
      short: c.shortName || c.name,
      avg: round2(mean(vals)),
      spread: round2(stdev(vals)),
      n: vals.length,
    };
  });

  const perJudge = judges
    .map((jid) => {
      const vals = flat.filter((f) => f.judgeId === jid).map((f) => f.value);
      return { judgeId: jid, total: round2(vals.reduce((a, b) => a + b, 0)), avg: round2(mean(vals)), n: vals.length };
    })
    .sort((a, b) => b.total - a.total);

  // How divided were the judges on this dish? Spread of their per-dish averages.
  const judgeSpread = round2(stdev(perJudge.map((j) => j.avg)));
  const verdict =
    perJudge.length < 2 ? "single judge" : judgeSpread <= 0.35 ? "strong consensus" : judgeSpread >= 0.8 ? "divisive" : "some disagreement";

  const ranked = [...perCriterion].filter((c) => c.n > 0).sort((a, b) => b.avg - a.avg);

  return {
    code: teamCode,
    name: team.name,
    table: team.table,
    dishNumber: team.dishNumber,
    dishDescription: team.dishDescription,
    judgeCount: judges.length,
    perCriterion,
    perJudge,
    judgeSpread,
    verdict,
    best: ranked[0] || null,
    worst: ranked[ranked.length - 1] || null,
  };
}

// Which criterion best predicts final rank? Correlate each criterion's dish
// average with the dish's scaled total (Pearson). Higher = drives the result.
export function criterionInfluence(criteria, teams, scores) {
  const { scaled } = computeLeaderboards(criteria, teams, scores);
  const scoredCodes = scaled.filter((r) => r.scaled > 0).map((r) => r.code);
  const totals = scoredCodes.map((code) => scaled.find((r) => r.code === code).scaled);
  return criteria
    .map((c) => {
      const facet = scoredCodes.map((code) => {
        const f = flatten(scores).filter((x) => x.teamCode === code && x.critId === c.id).map((x) => x.value);
        return mean(f);
      });
      return { id: c.id, name: c.name, short: c.shortName || c.name, r: round2(pearson(facet, totals)) };
    })
    .sort((a, b) => b.r - a.r);
}

function pearson(x, y) {
  const n = x.length;
  if (n < 2) return 0;
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

// ---- Historical analysis (across events) ----------------------------------
// Per-event summary: winner, field average, counts.
export function eventsOverview(events, scoresByEvent) {
  return events.map((ev) => {
    const scores = scoresByEvent[ev.id] || [];
    const ranked = officialRanked(ev, scores);
    const winner = ranked.find((r) => r.place === 1);
    const flat = flatten(scores);
    return {
      id: ev.id,
      name: ev.name || ev.id,
      teams: (ev.teams || []).length,
      judges: (ev.judges || []).length,
      ballots: scores.length,
      winner: winner ? winner.name || winner.code : "—",
      // Officially announced winner, when it differs from the computed leader
      // (e.g. a hand-decided result on a near-tie). Purely a note; scoring is unchanged.
      publishedWinner: ev.publishedWinner || null,
      method: methodOf(ev) === "minmax" ? "Min-Max" : "Scaled",
      fieldAvg: round2(mean(flat.map((f) => f.value))),
    };
  });
}

// Restaurant/dish track record aggregated by name across all events.
export function restaurantHistory(events, scoresByEvent) {
  const byName = {};
  for (const ev of events) {
    const scores = scoresByEvent[ev.id] || [];
    const method = methodOf(ev);
    const ranked = officialRanked(ev, scores);
    const field = ranked.filter((r) => officialVal(r, method) > 0).length;
    for (const row of ranked) {
      const val = officialVal(row, method);
      if (!(val > 0)) continue; // only dishes that were actually judged
      const key = row.name || row.code;
      (byName[key] = byName[key] || { name: key, apps: [], rawSum: 0, rawN: 0 }).apps.push({
        event: ev.name || ev.id,
        eventId: ev.id,
        place: row.place,
        field,
        perJudge: round2(val / Math.max(1, row.judgeCount)), // scaled points, per judge
      });
    }
    // Pooled raw 1–5 average: every actual criterion rating this participant received,
    // regardless of the event's method or weighting — so it's comparable across events.
    // Excludes absent-judge 0 placeholders (0 is never a real ballot value).
    const teamName = Object.fromEntries((ev.teams || []).map((t) => [String(t.code), t.name || t.code]));
    for (const s of scores) {
      const key = teamName[String(s.teamCode)];
      if (!key) continue;
      const b = (byName[key] = byName[key] || { name: key, apps: [], rawSum: 0, rawN: 0 });
      for (const v of Object.values(s.criterionScores || {})) {
        if (typeof v === "number" && v > 0) {
          b.rawSum += v;
          b.rawN += 1;
        }
      }
    }
  }
  return Object.values(byName)
    .map((r) => {
      const places = r.apps.map((a) => a.place);
      return {
        name: r.name,
        appearances: r.apps.length,
        wins: r.apps.filter((a) => a.place === 1).length,
        podiums: r.apps.filter((a) => a.place <= 3).length,
        bestPlace: Math.min(...places),
        avgPlace: round2(mean(places)),
        avgScore: round2(r.rawN ? r.rawSum / r.rawN : 0), // plain 1–5 mean, cross-event comparable
        apps: r.apps.sort((a, b) => String(a.event).localeCompare(String(b.event))),
      };
    })
    .sort((a, b) => b.wins - a.wins || a.avgPlace - b.avgPlace || b.appearances - a.appearances);
}

// Explain WHY the winner won an event, from the scoring (official method).
export function explainWinner(event, scores) {
  const method = methodOf(event);
  const ranked = officialRanked(event, scores || []);
  const scored = ranked.filter((r) => officialVal(r, method) > 0);
  if (!scored.length) return null;
  const w = scored[0], run = scored[1] || null;
  const wVal = officialVal(w, method), runVal = run ? officialVal(run, method) : null;
  const flat = flatten(scores || []);
  const critName = Object.fromEntries((event.criteria || []).map((c) => [c.id, c.shortName || c.name]));
  const wflat = flat.filter((f) => f.teamCode === w.code);
  const deltas = (event.criteria || [])
    .map((c) => {
      const fieldAvg = mean(flat.filter((f) => f.critId === c.id).map((f) => f.value));
      const winnerAvg = mean(wflat.filter((f) => f.critId === c.id).map((f) => f.value));
      return { short: critName[c.id], winnerAvg: round2(winnerAvg), fieldAvg: round2(fieldAvg), delta: round2(winnerAvg - fieldAvg) };
    })
    .sort((a, b) => b.delta - a.delta);
  // consensus: spread of the winner's per-judge AVERAGE scores (1–5 scale)
  const perJudge = {};
  wflat.forEach((f) => (perJudge[f.judgeId] = perJudge[f.judgeId] || []).push(f.value));
  const spread = round2(stdev(Object.values(perJudge).map((vals) => mean(vals))));
  const margin = run ? round2(wVal - runVal) : null;
  const methodLabel = method === "minmax" ? "Min-Max" : "Scaled";

  const strengths = deltas.filter((d) => d.delta > 0.05).slice(0, 3);
  const consensus = spread <= 0.35 ? "broad agreement across the judges" : spread >= 0.8 ? "a split panel — carried by its champions" : "solid consensus";
  let summary = `${w.name || w.code} won with ${wVal} points (${methodLabel})`;
  if (run) summary += `, ${margin} ahead of ${run.name || run.code}`;
  if (strengths.length)
    summary += `. It pulled ahead on ${strengths.map((d) => `${d.short} (${d.winnerAvg} vs field ${d.fieldAvg})`).join(" and ")}`;
  summary += `, with ${consensus} (σ ${spread}).`;

  return { winner: w.name || w.code, score: wVal, method: methodLabel, runnerUp: run ? run.name || run.code : null, margin, topCriteria: deltas, spread, judgeCount: w.judgeCount, summary };
}

// Deep profile for one participant across all events they entered.
export function participantProfile(events, scoresByEvent, name) {
  // global judge means (for affinity: does a judge score this participant above their own norm?)
  const judgeAll = {};
  for (const ev of events) {
    for (const s of scoresByEvent[ev.id] || []) {
      (judgeAll[s.judgeId] = judgeAll[s.judgeId] || []).push(...Object.values(s.criterionScores || {}));
    }
  }
  const judgeMean = Object.fromEntries(Object.entries(judgeAll).map(([k, v]) => [k, mean(v)]));

  const critAgg = {};
  const perJudge = {};
  const appearances = [];
  for (const ev of events) {
    const team = (ev.teams || []).find((t) => (t.name || t.code) === name);
    if (!team) continue;
    const evScores = scoresByEvent[ev.id] || [];
    const mine = evScores.filter((s) => s.teamCode === team.code);
    if (!mine.length) continue;
    const method = methodOf(ev);
    const ranked = officialRanked(ev, evScores);
    const row = ranked.find((r) => r.code === team.code) || {};
    const critName = Object.fromEntries((ev.criteria || []).map((c) => [c.id, c.shortName || c.name]));
    const nameOf = Object.fromEntries((ev.judges || []).map((j) => [j.id, j.name]));
    appearances.push({
      event: ev.name || ev.id,
      place: row.place,
      field: ranked.filter((r) => officialVal(r, method) > 0).length,
      score: round2((officialVal(row, method) || 0) / Math.max(1, row.judgeCount)),
    });
    for (const s of mine) {
      for (const [cid, v] of Object.entries(s.criterionScores || {})) {
        const cn = critName[cid] || cid;
        (critAgg[cn] = critAgg[cn] || []).push(v);
      }
      (perJudge[s.judgeId] = perJudge[s.judgeId] || { name: nameOf[s.judgeId] || s.judgeId, vals: [] }).vals.push(
        ...Object.values(s.criterionScores || {})
      );
    }
  }
  const facets = Object.entries(critAgg)
    .map(([k, v]) => ({ short: k, value: round2(mean(v)) }))
    .sort((a, b) => b.value - a.value);
  const affinity = Object.entries(perJudge)
    .map(([jid, o]) => ({ judge: o.name, avg: round2(mean(o.vals)), delta: round2(mean(o.vals) - (judgeMean[jid] || 0)) }))
    .sort((a, b) => b.delta - a.delta);
  return { name, appearances, facets, best: facets[0] || null, worst: facets[facets.length - 1] || null, affinity };
}

// ---- Cross-event judge database -------------------------------------------
// events: [{id, name, criteria, teams}]  scoresByEvent: {eventId: [score,...]}
// Returns per-judge learned profile aggregated across every event they judged.
export function judgeProfiles(roster, events, scoresByEvent) {
  const profiles = {}; // judgeId -> accumulator
  const ensure = (jid, name) =>
    (profiles[jid] = profiles[jid] || {
      judgeId: jid,
      name: name || jid,
      events: new Set(),
      dishes: new Set(),
      values: [],
      perCriterion: {}, // shortName -> values[]
      generosities: [], // per-event generosity
      consensusDeltas: [], // |judge dish total - dish avg total| per dish
      appearances: [], // per-event participation record
    });

  for (const ev of events) {
    const scores = scoresByEvent[ev.id] || [];
    if (!scores.length) continue;
    const flat = flatten(scores);
    const fieldMean = mean(flat.map((f) => f.value));
    const { scaled } = computeLeaderboards(ev.criteria || [], ev.teams || [], scores);
    const dishAvgTotal = Object.fromEntries(scaled.map((r) => [r.code, r.scaled / Math.max(1, r.judgeCount)]));
    const critName = Object.fromEntries((ev.criteria || []).map((c) => [c.id, c.shortName || c.name]));
    const nameOf = Object.fromEntries((ev.judges || []).map((j) => [j.id, j.name]));

    const byJudge = {};
    flat.forEach((f) => (byJudge[f.judgeId] = byJudge[f.judgeId] || []).push(f));
    for (const jid of Object.keys(byJudge)) {
      const p = ensure(jid, nameOf[jid]);
      p.events.add(ev.id);
      const mine = byJudge[jid];
      const vals = mine.map((f) => f.value);
      p.values.push(...vals);
      p.generosities.push(mean(vals) - fieldMean);
      mine.forEach((f) => {
        const cn = critName[f.critId] || f.critId;
        (p.perCriterion[cn] = p.perCriterion[cn] || []).push(f.value);
      });
      // consensus: judge's per-dish total vs dish average per-judge total
      const perDish = {};
      mine.forEach((f) => (perDish[f.teamCode] = (perDish[f.teamCode] || 0) + f.value));
      Object.keys(perDish).forEach((code) => p.dishes.add(ev.id + ":" + code));
      // per-event participation record (for the judge-detail popup)
      p.appearances.push({
        eventId: ev.id,
        event: ev.name || ev.id,
        eventDate: ev.eventDate || "",
        dishes: Object.keys(perDish).length,
        avg: round2(mean(vals)),
        generosity: round2(mean(vals) - fieldMean),
      });
    }
  }

  return Object.values(profiles).map((p) => ({
    judgeId: p.judgeId,
    name: (roster && roster[p.judgeId] && roster[p.judgeId].name) || p.name,
    eventsJudged: p.events.size,
    dishesScored: p.dishes.size,
    avgScore: round2(mean(p.values)),
    generosity: round2(mean(p.generosities)), // + generous, - harsh (vs peers)
    consistency: round2(stdev(p.values)), // lower = more consistent
    perCriterion: Object.fromEntries(
      Object.keys(p.perCriterion).map((k) => [k, round2(mean(p.perCriterion[k]))])
    ),
    appearances: p.appearances
      .slice()
      .sort((a, b) => (b.eventDate || "").localeCompare(a.eventDate || "") || String(a.event).localeCompare(String(b.event))),
  })).sort((a, b) => b.eventsJudged - a.eventsJudged || b.dishesScored - a.dishesScored);
}

// ---- Result-integrity analytics (per event) --------------------------------

// Panel agreement: average pairwise Spearman correlation of judges' per-dish
// weighted totals. Only judge pairs sharing >=3 dishes count (tables don't overlap).
export function panelAgreement(criteria, teams, scores) {
  const wById = Object.fromEntries((criteria || []).map((c) => [c.id, +c.weight || 0]));
  const byJudge = {};
  for (const s of scores || []) {
    const cs = s.criterionScores || {};
    let tot = 0, any = false;
    for (const cid of Object.keys(cs)) {
      const v = cs[cid];
      if (typeof v === "number" && v > 0) { tot += (wById[cid] || 0) * v; any = true; }
    }
    if (any) (byJudge[s.judgeId] = byJudge[s.judgeId] || {})[s.teamCode] = tot;
  }
  const judges = Object.keys(byJudge);
  const rankMap = (obj, codes) => {
    const arr = codes.map((c) => ({ c, v: obj[c] })).sort((a, b) => a.v - b.v);
    const rank = {};
    let i = 0;
    while (i < arr.length) {
      let j = i;
      while (j + 1 < arr.length && arr[j + 1].v === arr[i].v) j++;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) rank[arr[k].c] = r;
      i = j + 1;
    }
    return rank;
  };
  const pearson = (xs, ys) => {
    const n = xs.length; if (n < 2) return 0;
    const mx = mean(xs), my = mean(ys);
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
    return dx && dy ? num / Math.sqrt(dx * dy) : 0;
  };
  const rs = [];
  for (let a = 0; a < judges.length; a++) {
    for (let b = a + 1; b < judges.length; b++) {
      const ja = byJudge[judges[a]], jb = byJudge[judges[b]];
      const common = Object.keys(ja).filter((c) => c in jb);
      if (common.length < 3) continue;
      const ra = rankMap(ja, common), rb = rankMap(jb, common);
      rs.push(pearson(common.map((c) => ra[c]), common.map((c) => rb[c])));
    }
  }
  const r = rs.length ? round2(mean(rs)) : null;
  const label = r == null ? "not enough overlap"
    : r >= 0.7 ? "strong consensus" : r >= 0.4 ? "moderate agreement"
    : r >= 0.15 ? "loose agreement" : "divided panel";
  return { r, pairs: rs.length, label };
}

// Winner robustness: does the official winner survive dropping any one judge?
export function winnerRobustness(event, scores) {
  const method = methodOf(event);
  const full = officialRanked(event, scores || []);
  if (!full.length) return null;
  const winner = full[0], runner = full[1] || null;
  const wval = officialVal(winner, method), rval = runner ? officialVal(runner, method) : 0;
  const margin = round2(wval - rval);
  const judgeIds = [...new Set((scores || []).map((s) => s.judgeId))];
  const pivotal = [];
  judgeIds.forEach((jid) => {
    const lb = officialRanked(event, (scores || []).filter((s) => s.judgeId !== jid));
    if (lb.length && lb[0].code !== winner.code) pivotal.push({ judgeId: jid, newWinnerCode: lb[0].code, newWinnerName: lb[0].name });
  });
  return {
    winner, runner, margin,
    marginPct: wval ? Math.round((margin / wval) * 1000) / 10 : 0,
    tieBroken: !!winner.tieBroken,
    stable: pivotal.length === 0,
    pivotal,
    judgeCount: judgeIds.length,
  };
}

// Serving-order drift: linear trend of per-dish-per-judge average vs serve order.
export function servingDrift(criteria, teams, scores) {
  const orderOf = Object.fromEntries((teams || []).map((t) => [t.code, t.dishNumber || null]));
  const pts = [];
  for (const s of scores || []) {
    const vals = Object.values(s.criterionScores || {}).filter((v) => typeof v === "number" && v > 0);
    const x = orderOf[s.teamCode];
    if (vals.length && x) pts.push({ x, y: mean(vals) });
  }
  if (pts.length < 4) return null;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0, dy = 0;
  for (let i = 0; i < pts.length; i++) { const a = xs[i] - mx; num += a * (ys[i] - my); den += a * a; dy += (ys[i] - my) ** 2; }
  const slope = den ? num / den : 0;
  const span = Math.max(...xs) - Math.min(...xs);
  return {
    slope: round2(slope),
    perEvent: round2(slope * span),
    r: den && dy ? round2(num / Math.sqrt(den * dy)) : 0,
    direction: slope > 0.02 ? "later dishes scored higher" : slope < -0.02 ? "later dishes scored lower (possible palate fatigue)" : "no meaningful drift",
    n: pts.length,
  };
}

// Outlier ballots: a judge's dish average far from that dish's consensus.
export function outlierBallots(criteria, teams, scores, threshold = 1.0) {
  const teamName = Object.fromEntries((teams || []).map((t) => [t.code, t.name]));
  const byDish = {};
  for (const s of scores || []) {
    const vals = Object.values(s.criterionScores || {}).filter((v) => typeof v === "number" && v > 0);
    if (!vals.length) continue;
    (byDish[s.teamCode] = byDish[s.teamCode] || []).push({ judgeId: s.judgeId, judgeName: s.judgeName, avg: mean(vals) });
  }
  const out = [];
  Object.keys(byDish).forEach((code) => {
    const arr = byDish[code];
    if (arr.length < 3) return;
    const consensus = mean(arr.map((a) => a.avg));
    arr.forEach((a) => {
      const delta = a.avg - consensus;
      if (Math.abs(delta) >= threshold) out.push({ judgeId: a.judgeId, judgeName: a.judgeName, code, dish: teamName[code], judgeAvg: round2(a.avg), consensus: round2(consensus), delta: round2(delta) });
    });
  });
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

// Composite integrity grade (A–F) from the four result-integrity signals.
// Pass precomputed {pa,wr,dr,outs} to avoid recomputation where available.
export function integrityGrade(event, scores, pre) {
  const teams = event.teams || [];
  const pa = (pre && pre.pa) || panelAgreement(event.criteria, teams, scores);
  const wr = (pre && pre.wr) || winnerRobustness(event, scores);
  const dr = (pre && pre.dr) || servingDrift(event.criteria, teams, scores);
  const outs = (pre && pre.outs) || outlierBallots(event.criteria, teams, scores);
  if (!wr) return null; // no scored result to grade
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const nTeams = teams.length || 1;
  const jc = wr.judgeCount || 1;
  const rAgree = pa.r == null ? 0.3 : pa.r;                    // neutral if no overlap
  // Panel consensus (0–30): food judging runs ~0.3, so r≈0.4 is already strong.
  const agreement = clamp((rAgree + 0.10) / 0.50) * 30;
  // Decisiveness (0–25): mostly the margin; a stable win (or few pivotal judges)
  // adds up to 10. A close race in a big field isn't a data flaw, so it's gentle.
  const decisiveness = clamp(wr.marginPct / 5) * 15 + (wr.stable ? 10 : clamp(1 - wr.pivotal.length / jc) * 10);
  // Serving steadiness (0–20): penalize real palate drift.
  const steadiness = dr ? clamp(1 - Math.abs(dr.slope) / 0.10) * 20 : 15;
  // Clean ballots (0–25): outliers per dish; ~0.8/dish is where it bottoms out.
  const clean = clamp(1 - (outs.length / Math.max(1, nTeams)) / 0.8) * 25;
  const score = Math.round(agreement + decisiveness + steadiness + clean);
  const grade = score >= 85 ? "A" : score >= 72 ? "B" : score >= 58 ? "C" : score >= 45 ? "D" : "F";
  const meaning = {
    A: "rock-solid — strong consensus, decisive & clean",
    B: "sound — a dependable result",
    C: "defensible, but a close or loosely-agreed call",
    D: "shaky — the result hinged on a few ballots",
    F: "fragile — treat the ranking with caution",
  }[grade];
  return { score, grade, meaning, parts: { agreement: Math.round(agreement), decisiveness: Math.round(decisiveness), steadiness: Math.round(steadiness), clean: Math.round(clean) }, pa, wr, dr, outs };
}
