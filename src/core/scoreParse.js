/**
 * scoreParse.js — validates and repairs the model's JSON output.
 *
 * ZERO IMPORTS (see schema.js for why).
 *
 * Model output is untrusted regardless of provider — a local Ollama is not a
 * security boundary (spec 4.3). Everything here assumes the response may be
 * fenced, wrapped in an apology, missing keys, or carrying a score of 150.
 *
 * Two rules shape this file:
 *
 *   1. Never throw. A discriminated { ok: true, value } / { ok: false, error }
 *      keeps the caller on one code path, and a lead is never lost because the
 *      model misbehaved (spec 5.3).
 *   2. Never invent. Out-of-range values are clamped and over-long text is
 *      truncated, because those are repairs. A missing or wrong-typed field is
 *      rejected, because filling it in would be fabrication.
 *
 * The model never returns a temperature and never sets a status. It returns a
 * score; deterministic code derives, clamps and applies the rest (spec 4.3).
 */

/** Keys the section 5.1 contract requires. All five, every time. */
export const REQUIRED_KEYS = Object.freeze([
  'score',
  'reasoning',
  'recommended_action',
  'needs_human_review',
  'confidence',
]);

export const CONFIDENCE_LEVELS = Object.freeze(['HIGH', 'MEDIUM', 'LOW']);

/** Generous enough for two sentences; short enough that a runaway model cannot fill a column. */
export const MAX_REASONING_LENGTH = 600;
export const MAX_ACTION_LENGTH = 200;

const fail = (error) => ({ ok: false, error });

/** True for a non-null, non-array object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Remove a surrounding markdown fence (spec 5.3).
 *
 * Only strips a fence that wraps the WHOLE response. A stray ``` inside a
 * string value — a customer describing their code — is left alone.
 */
export function stripCodeFences(raw) {
  if (typeof raw !== 'string') return '';

  const text = raw.trim();
  const fenced = /^```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/.exec(text);

  return fenced ? fenced[1].trim() : text;
}

/** Parse, then retry on the widest {...} slice — models like to add a preamble. */
function parseJsonLoosely(text) {
  try {
    return { parsed: JSON.parse(text), found: true };
  } catch {
    // fall through
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return { parsed: null, found: false };

  try {
    return { parsed: JSON.parse(text.slice(start, end + 1)), found: true };
  } catch {
    return { parsed: null, found: false };
  }
}

/**
 * Validate a raw model response against the section 5.1 contract.
 *
 * @param {unknown} raw the provider's text, however it arrived
 * @returns {{ok: true, value: object, warnings: string[]} | {ok: false, error: string}}
 */
export function parseScoreResponse(raw) {
  if (typeof raw !== 'string') {
    return fail(`expected the model response as a string, received ${raw === null ? 'null' : typeof raw}`);
  }

  const text = stripCodeFences(raw);
  if (text === '') return fail('the model returned an empty response');

  const { parsed, found } = parseJsonLoosely(text);
  if (!found) return fail('the model response was not valid JSON');

  if (!isPlainObject(parsed)) {
    return fail(`expected a JSON object, received ${parsed === null ? 'null' : typeof parsed}`);
  }

  for (const key of REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
      return fail(`the model response is missing the required key "${key}"`);
    }
  }

  const warnings = [];

  // --- score: the only field worth repairing rather than rejecting ---------
  const rawScore = parsed.score;
  if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) {
    return fail(`"score" must be a finite number, received ${JSON.stringify(rawScore)}`);
  }

  let score = Math.round(rawScore);
  if (score !== rawScore) warnings.push(`score ${rawScore} rounded to ${score}`);
  if (score < 0 || score > 100) {
    const clamped = Math.min(100, Math.max(0, score));
    warnings.push(`score ${score} clamped to ${clamped}`);
    score = clamped;
  }

  // --- text fields --------------------------------------------------------
  if (typeof parsed.reasoning !== 'string') {
    return fail(`"reasoning" must be a string, received ${typeof parsed.reasoning}`);
  }
  if (typeof parsed.recommended_action !== 'string') {
    return fail(`"recommended_action" must be a string, received ${typeof parsed.recommended_action}`);
  }

  let reasoning = parsed.reasoning.trim();
  if (reasoning.length > MAX_REASONING_LENGTH) {
    warnings.push(`reasoning truncated to ${MAX_REASONING_LENGTH} characters`);
    reasoning = reasoning.slice(0, MAX_REASONING_LENGTH);
  }

  let action = parsed.recommended_action.trim();
  if (action.length > MAX_ACTION_LENGTH) {
    warnings.push(`recommended_action truncated to ${MAX_ACTION_LENGTH} characters`);
    action = action.slice(0, MAX_ACTION_LENGTH);
  }

  // --- flags --------------------------------------------------------------
  if (typeof parsed.needs_human_review !== 'boolean') {
    return fail(`"needs_human_review" must be a boolean, received ${typeof parsed.needs_human_review}`);
  }

  if (typeof parsed.confidence !== 'string') {
    return fail(`"confidence" must be a string, received ${typeof parsed.confidence}`);
  }
  const confidence = parsed.confidence.trim().toUpperCase();
  if (!CONFIDENCE_LEVELS.includes(confidence)) {
    return fail(`"confidence" must be one of ${CONFIDENCE_LEVELS.join(', ')}, received ${JSON.stringify(parsed.confidence)}`);
  }

  // Only the contract keys survive. Anything else the model volunteered —
  // a temperature, an invented field — is dropped here rather than downstream.
  return {
    ok: true,
    warnings,
    value: {
      score,
      reasoning,
      recommended_action: action,
      needs_human_review: parsed.needs_human_review,
      confidence,
    },
  };
}

/**
 * Turn a validated score into a patch for the leads row.
 *
 * Temperature is passed in rather than computed: deriving it is
 * temperature.js's job, and this module cannot import it.
 *
 * @param {object} value a validated value from parseScoreResponse
 * @param {{temperature: string|null, existingReviewReason?: string|null}} options
 */
export function buildScorePatch(value, options) {
  const reasons = [];

  // An injection flag raised during sanitisation must survive scoring. A model
  // that scores the lead happily is not evidence the message was benign.
  const existing = options?.existingReviewReason;
  if (typeof existing === 'string' && existing.trim() !== '') reasons.push(existing.trim());

  if (value.confidence === 'LOW') reasons.push('low_confidence');
  if (value.needs_human_review === true) reasons.push('model_requested_review');

  const needsReview = reasons.length > 0;

  return {
    lead_score: value.score,
    lead_temperature: options?.temperature ?? null,
    ai_reasoning: value.reasoning,
    recommended_action: value.recommended_action,
    // The model does not choose status. Deterministic code does.
    crm_status: needsReview ? 'HUMAN_REVIEW' : 'QUALIFIED',
    needs_human_review: needsReview,
    review_reason: needsReview ? reasons.join(',') : null,
  };
}

/**
 * The patch for a lead the model could not score (spec 5.3).
 *
 * Score and temperature stay null. Persisting a guess would be worse than
 * persisting nothing, and the lead itself is still saved either way.
 *
 * @param {{reason?: string|null}} [options] e.g. 'provider_unavailable'
 */
export function buildScoreFailurePatch(options) {
  const reason = options?.reason;
  const suffix = typeof reason === 'string' && reason.trim() !== '' ? `:${reason.trim()}` : '';

  return {
    lead_score: null,
    lead_temperature: null,
    crm_status: 'HUMAN_REVIEW',
    needs_human_review: true,
    review_reason: `ai_score_invalid${suffix}`,
  };
}
