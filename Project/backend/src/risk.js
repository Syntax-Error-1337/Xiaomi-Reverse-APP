'use strict';

// Deterministic scan risk scoring. Pure function of the verify `reasons` +
// clone `alerts` — no I/O, no time. Documented in README ("Risk scoring").
//
// Scoring: start 100. Each blocking code present sets
// score = min(score, value) (lowest wins when several apply). Each clone /
// note flag present subtracts its weight. Floor 0.
// Levels: score >= 80 → low ('accept'); 50–79 → watch ('accept, watch');
// < 50 → high ('do not accept'). Every table blocker maps to ≤ 40, and an
// unknown blocker caps at 40 with valid=false forcing high, so any
// validity-blocking scan is high.
// drivers: up to 3 score-reducing codes, in application order below
// (blockers first, then clone flags, then notes). Codes with no weight
// (UNKNOWN_ZONE, DUPLICATE_SCAN, EVENT_ACTIVE) never appear.
const BLOCKER_SCORE = {
  INVALID_SIGNATURE: 0,
  INVALID_FORMAT: 0, // same class as INVALID_SIGNATURE (malformed token)
  TAMPER_MISMATCH: 0,
  REVOKED: 5,
  CARD_REPORTED: 5,
  CARD_NOT_FOUND: 10,
  STATUS_EXPIRED: 20,
  OUT_OF_ZONE: 40,
};

const DEDUCTIONS = {
  IMPOSSIBLE_TRAVEL: 30,
  SIMULTANEOUS_FAR: 30,
  SAME_POST_RESCAN: 25,
  VELOCITY_BURST: 20,
  FIRST_SCAN_LATE: 10,
};

const APPLICATION_ORDER = [
  'INVALID_SIGNATURE',
  'INVALID_FORMAT',
  'TAMPER_MISMATCH',
  'REVOKED',
  'CARD_REPORTED',
  'CARD_NOT_FOUND',
  'STATUS_EXPIRED',
  'OUT_OF_ZONE',
  'IMPOSSIBLE_TRAVEL',
  'SIMULTANEOUS_FAR',
  'SAME_POST_RESCAN',
  'VELOCITY_BURST',
  'FIRST_SCAN_LATE',
];

function scoreRisk({ reasons = [], alerts = [], valid } = {}) {
  const present = new Set([...reasons, ...alerts]);
  let score = 100;
  for (const code of Object.keys(BLOCKER_SCORE)) {
    if (present.has(code)) score = Math.min(score, BLOCKER_SCORE[code]);
  }
  // Any other validity-blocking code not in the table (e.g. dynamic
  // STATUS_<X>) still caps at high-risk territory.
  if (valid === false && score > 40) score = 40;
  const applied = [];
  for (const code of APPLICATION_ORDER) {
    if (!present.has(code)) continue;
    if (code in BLOCKER_SCORE) {
      applied.push(code);
    } else if (code in DEDUCTIONS) {
      score -= DEDUCTIONS[code];
      applied.push(code);
    }
  }
  score = Math.max(0, score);
  let level = score >= 80 ? 'low' : score >= 50 ? 'watch' : 'high';
  // valid=false forces high regardless (contract) — covers blockers with
  // no table entry such as dynamic STATUS_<X>.
  if (valid === false) level = 'high';
  return { score, level, drivers: applied.slice(0, 3) };
}

module.exports = { scoreRisk, BLOCKER_SCORE, DEDUCTIONS, APPLICATION_ORDER };
