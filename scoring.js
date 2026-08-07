// scoring.js — pure scoring engine, ported from the HouBBQ Throwdown workbook.
// No DOM, no Firebase — pure functions so the math can be tested in isolation.
//
// Workbook mechanics being reproduced (Dish Tally sheets):
//   * Each criterion i has a weight w_i (weights across criteria sum to 1.0).
//   * Per-criterion scale factor:  SF_i = (w_i * 6) * 1.2   ==  w_i * 7.2
//     (matches 'Places, Judges, Coding'!I49:I54  =(G*6)*1.2)
//   * A judge scores each criterion 1..5 in 0.5 steps. An absent judge = no score.
//   * SCALED total for a dish  = Σ_i  SF_i * Σ_j(score_ij)             (all judges)
//   * MIN-MAX total for a dish = Σ_i  SF_i * (Σ_j score_ij − max_j − min_j)
//        i.e. drop each criterion's single highest and single lowest judge score.
//   * The workbook always had 5–6 judges; for robustness we only trim hi/lo when a
//     criterion has >= 3 scores (below that there's nothing meaningful to trim).

export const SCALE_MULTIPLIER = 6 * 1.2; // 7.2 — weight → per-criterion scale factor

export function scaleFactor(weight) {
  return weight * SCALE_MULTIPLIER;
}

// scoresByJudge: { [judgeId]: { [criterionId]: number } }
// criteria:      [ { id, weight, ... }, ... ]
// Returns { scaled, minmax, perCriterion:[{id, sum, count, scaledPts, minmaxPts}], judgeCount }
export function computeDishTotals(criteria, scoresByJudge) {
  let scaled = 0;
  let minmax = 0;
  let fives = 0;
  const perCriterion = [];
  const judgeIds = Object.keys(scoresByJudge || {});

  for (const crit of criteria) {
    const sf = scaleFactor(crit.weight);
    const vals = [];
    for (const jid of judgeIds) {
      const v = scoresByJudge[jid] ? scoresByJudge[jid][crit.id] : undefined;
      // Count any present numeric score, INCLUDING 0. Live judges only ever submit
      // 1..5 (a criterion they didn't score is absent/undefined, not 0), so the
      // only 0s in the data are absent-judge placeholders from ingested historical
      // events. The official workbooks kept those 0s and dropped them as the low in
      // the min/max trim, so we must count them here to reproduce the awarded totals
      // (e.g. Truffle Masters 2024, where Money Cat's absent 6th judge is a 0 that
      // gets trimmed away — giving its official 121.25, a tie for first).
      if (typeof v === "number" && !Number.isNaN(v) && v >= 0) vals.push(v);
    }
    const sum = vals.reduce((a, b) => a + b, 0);
    fives += vals.filter((v) => v === 5).length;
    let trimmed = sum;
    if (vals.length >= 3) {
      trimmed = sum - Math.max(...vals) - Math.min(...vals);
    }
    const scaledPts = sf * sum;
    const minmaxPts = sf * trimmed;
    scaled += scaledPts;
    minmax += minmaxPts;
    perCriterion.push({
      id: crit.id,
      sum,
      count: vals.length,
      scaledPts,
      minmaxPts,
    });
  }

  return {
    scaled: round2(scaled),
    minmax: round2(minmax),
    perCriterion,
    fives,
    judgeCount: judgeIds.length,
  };
}

// Build the full leaderboard for an event.
// teams:  [ { code, name, table, dishNumber, serveTime } ]
// scores: [ { judgeId, teamCode, criterionScores:{critId:val} } ]  (one per judge/dish)
// Returns { scaled:[...ranked], minmax:[...ranked] } each row:
//   { code, name, table, dishNumber, scaled, minmax, judgeCount, place }
export function computeLeaderboards(criteria, teams, scores) {
  const byTeam = {};
  for (const t of teams) {
    byTeam[t.code] = { team: t, scoresByJudge: {} };
  }
  for (const s of scores) {
    const bucket = byTeam[s.teamCode];
    if (!bucket) continue; // score for an unknown/removed team code — skip
    bucket.scoresByJudge[s.judgeId] = s.criterionScores || {};
  }

  const rows = [];
  for (const code of Object.keys(byTeam)) {
    const { team, scoresByJudge } = byTeam[code];
    const totals = computeDishTotals(criteria, scoresByJudge);
    rows.push({
      code,
      name: team.name,
      table: team.table,
      dishNumber: team.dishNumber,
      scaled: totals.scaled,
      minmax: totals.minmax,
      judgeCount: totals.judgeCount,
      perCriterion: totals.perCriterion,
      fives: totals.fives,
    });
  }

  const scaledRanked = rankBy(rows, "scaled", criteria);
  const minmaxRanked = rankBy(rows, "minmax", criteria);
  return { scaled: scaledRanked, minmax: minmaxRanked };
}

// Strict, never-tied ranking. Order:
//   1) higher primary total (scaled or minmax)
//   2) TIEBREAK "criterion priority": higher summed judge score on the
//      highest-WEIGHTED criterion, then the next-highest, and so on
//   3) deterministic fallback: higher raw total across all criteria, then more
//      top (perfect-5) scores, then lower code string — so places are unique.
// `tieBroken` is set on any row whose rank over the row above it was decided by
// step 2 or 3 (i.e. the primary totals were equal) so the UI can flag it.
function rankBy(rows, key, criteria) {
  // criteria in descending weight order for the priority tiebreak
  const byWeight = [...criteria].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const critSum = (row, cid) => {
    const pc = (row.perCriterion || []).find((p) => p.id === cid);
    return pc ? pc.sum : 0;
  };
  const rawTotal = (row) => (row.perCriterion || []).reduce((a, p) => a + p.sum, 0);

  const other = key === "minmax" ? "scaled" : "minmax";
  const cmp = (a, b) => {
    if (b[key] !== a[key]) return { d: b[key] - a[key], tie: false };
    // primary totals equal → tiebreak cascade.
    // (1) The *other* aggregation total: a dish that also scores higher across all
    // judges (or on the trimmed mean) is the stronger dish. This matches how the
    // official workbooks resolved exact ties — e.g. WFW 2025, where Swift & Company
    // and Phat Eatery both hit min-max 165.24 but Swift's Scaled total (270.00 vs
    // 266.76) made it the winner. Critical when weights are flat (equal across all
    // criteria), which makes the criterion-priority step below meaningless.
    if (b[other] !== a[other]) return { d: b[other] - a[other], tie: true };
    // (2) criterion priority: higher summed score on the highest-weighted criterion.
    for (const c of byWeight) {
      const d = critSum(b, c.id) - critSum(a, c.id);
      if (d !== 0) return { d, tie: true };
    }
    const rt = rawTotal(b) - rawTotal(a);
    if (rt !== 0) return { d: rt, tie: true };
    const fives = (b.fives || 0) - (a.fives || 0);
    if (fives !== 0) return { d: fives, tie: true };
    // last resort: stable, deterministic
    return { d: String(a.code).localeCompare(String(b.code)), tie: true };
  };

  const scored = rows.filter((r) => r[key] > 0).map((r) => ({ ...r }));
  const unscored = rows.filter((r) => !(r[key] > 0)).map((r) => ({ ...r, place: null }));

  scored.sort((a, b) => cmp(a, b).d);
  scored.forEach((r, i) => {
    r.place = i + 1; // strictly unique — no ties, ever
    r.tieBroken = i > 0 && cmp(scored[i - 1], r).tie;
  });

  return [...scored, ...unscored];
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// The 0.5-step 1..5 scale used on the judge form ("circle one").
export const SCORE_STEPS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
