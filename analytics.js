// analytics.js — pure analytics for the results dashboard + judge database.
// No DOM, no Firebase. Fed the same {criteria, teams, scores} the scoring engine uses.
import { computeLeaderboards } from "./scoring.js";

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
    const { scaled } = computeLeaderboards(ev.criteria || [], ev.teams || [], scores);
    const winner = scaled.find((r) => r.place === 1);
    const flat = flatten(scores);
    return {
      id: ev.id,
      name: ev.name || ev.id,
      teams: (ev.teams || []).length,
      judges: (ev.judges || []).length,
      ballots: scores.length,
      winner: winner ? winner.name || winner.code : "—",
      fieldAvg: round2(mean(flat.map((f) => f.value))),
    };
  });
}

// Restaurant/dish track record aggregated by name across all events.
export function restaurantHistory(events, scoresByEvent) {
  const byName = {};
  for (const ev of events) {
    const scores = scoresByEvent[ev.id] || [];
    const { scaled } = computeLeaderboards(ev.criteria || [], ev.teams || [], scores);
    const field = scaled.length;
    for (const row of scaled) {
      if (!(row.scaled > 0)) continue; // only dishes that were actually judged
      const key = row.name || row.code;
      (byName[key] = byName[key] || { name: key, apps: [] }).apps.push({
        event: ev.name || ev.id,
        eventId: ev.id,
        place: row.place,
        field,
        perJudge: round2(row.scaled / Math.max(1, row.judgeCount)), // ~0–36, comparable across events
      });
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
        avgScore: round2(mean(r.apps.map((a) => a.perJudge))),
        apps: r.apps.sort((a, b) => String(a.event).localeCompare(String(b.event))),
      };
    })
    .sort((a, b) => b.wins - a.wins || a.avgPlace - b.avgPlace || b.appearances - a.appearances);
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
  })).sort((a, b) => b.eventsJudged - a.eventsJudged || b.dishesScored - a.dishesScored);
}
