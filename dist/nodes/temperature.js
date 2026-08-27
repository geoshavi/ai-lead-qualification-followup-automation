// ============================================================================
// GENERATED FILE — do not edit by hand.
// Source: src/core/temperature.js
// Regenerate with: npm run build:nodes
//
// This is the paste-ready body for an n8n Code node. src/core/ is the
// source of truth; a hand edit here will be silently overwritten and will
// not survive the next build (PROJECT_SPEC.md section 1).
// ============================================================================
/**
 * temperature.js — score to temperature band.
 *
 * ZERO IMPORTS (see schema.js for why).
 *
 * The model returns a score and never a temperature. Letting it return both
 * produces contradictions like { score: 30, temperature: 'HOT' }, which is an
 * entire class of bug that simply cannot occur if the band is derived.
 *
 * Thresholds are parameters rather than literals so HOT_SCORE_THRESHOLD from
 * the environment can drive the HOT cutoff without editing this file.
 */

/** Defaults from PROJECT_SPEC.md section 5.1. */
const DEFAULT_THRESHOLDS = Object.freeze({ hot: 75, warm: 40 });

/**
 * Map a 0-100 score onto HOT / WARM / COLD.
 *
 *   score >= hot          -> HOT
 *   warm <= score < hot   -> WARM
 *   score <  warm         -> COLD
 *
 * Defensive by design: scoreParse.js is responsible for clamping, but this
 * function is also reachable from the scheduler and from replayed fixtures, so
 * a non-finite or out-of-range score must not silently become HOT.
 *
 * @param {number} score
 * @param {{hot?: number, warm?: number}} [thresholds]
 * @returns {'HOT'|'WARM'|'COLD'}
 */
function scoreToTemperature(score, thresholds) {
  const hot = Number(thresholds?.hot ?? DEFAULT_THRESHOLDS.hot);
  const warm = Number(thresholds?.warm ?? DEFAULT_THRESHOLDS.warm);

  if (!Number.isFinite(hot) || !Number.isFinite(warm)) {
    throw new TypeError('scoreToTemperature: thresholds must be finite numbers');
  }
  if (warm > hot) {
    throw new RangeError('scoreToTemperature: warm threshold cannot exceed hot threshold');
  }

  // Reject by TYPE before coercing. Number(null) is 0 and Number([]) is 0, so a
  // plain isFinite check would quietly turn a missing score into COLD — exactly
  // the silent misclassification this function exists to prevent.
  if (typeof score !== 'number' && typeof score !== 'string') {
    throw new TypeError('scoreToTemperature: score must be a finite number');
  }

  const n = Number(score);
  if (!Number.isFinite(n)) {
    throw new TypeError('scoreToTemperature: score must be a finite number');
  }

  // Clamp defensively so a score of 900 cannot produce a band the database
  // would then reject on its own CHECK constraint.
  const clamped = Math.min(100, Math.max(0, Math.round(n)));

  if (clamped >= hot) return 'HOT';
  if (clamped >= warm) return 'WARM';
  return 'COLD';
}

/**
 * Read the HOT threshold from an environment-shaped object.
 * Falls back to the spec default when unset or unparseable, because a typo in
 * an env var must not silently reclassify every lead.
 */
function thresholdsFromEnv(env) {
  const raw = env?.HOT_SCORE_THRESHOLD;
  const parsed = Number(raw);
  const hot = Number.isFinite(parsed) && raw !== '' && raw !== null && raw !== undefined
    ? parsed
    : DEFAULT_THRESHOLDS.hot;
  return { hot, warm: DEFAULT_THRESHOLDS.warm };
}
