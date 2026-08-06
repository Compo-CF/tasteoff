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
  const perCriterion = [];
  const judgeIds = Object.keys(scoresByJudge || {});

  for (const crit of criteria) {
    const sf = scaleFactor(crit.weight);
    const vals = [];
    for (const jid of judgeIds) {
      const v = scoresByJudge[jid] ? scoresByJudge[jid][crit.id] : undefined;
      if (typeof v === "number" && !Number.isNaN(v) && v > 0) vals.push(v);
    }
    const sum = vals.reduce((a, b) => a + b, 0);
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
    });
  }

  const scaledRanked = rankBy(rows, "scaled");
  const minmaxRanked = rankBy(rows, "minmax");
  return { scaled: scaledRanked, minmax: minmaxRanked };
}

function rankBy(rows, key) {
  const sorted = rows
    .map((r) => ({ ...r }))
    .sort((a, b) => b[key] - a[key]);
  // Standard competition ranking (1,2,2,4) on ties.
  let place = 0;
  let prev = null;
  sorted.forEach((r, i) => {
    if (prev === null || r[key] !== prev) {
      place = i + 1;
    }
    r.place = r[key] > 0 ? place : null; // unscored dishes get no place
    prev = r[key];
  });
  return sorted;
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// The 0.5-step 1..5 scale used on the judge form ("circle one").
export const SCORE_STEPS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
