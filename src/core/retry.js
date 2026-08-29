/**
 * retry.js — deterministic retry-with-backoff policy (spec 9, M8).
 *
 * ZERO IMPORTS. This decides WHETHER another attempt is worth making and HOW
 * LONG to wait first. Actually sleeping and re-invoking the external call is
 * the caller's job — an adapter, which is allowed to do I/O — because that is
 * the only way to keep this file free of the clock and still testable
 * against an exact schedule. The price of that determinism is no jitter:
 * nothing here calls `Math.random`, so a given attempt number always yields
 * the same delay.
 *
 * Bounded on purpose, the same reasoning as clampToBusinessHours's own guard:
 * a policy that is not obviously bounded is a policy that can retry forever.
 */

/** 3 total attempts, 200ms base delay, doubling each time, capped at 5s. */
export const DEFAULT_RETRY_POLICY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 200,
  factor: 2,
  maxDelayMs: 5000,
});

/**
 * Should the attempt after `attempt` (1-indexed — the attempt that just
 * failed) happen at all?
 *
 * @param {number} attempt the attempt number that just failed
 * @param {{maxAttempts?: number}} [options]
 */
export function shouldRetry(attempt, options = {}) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError('shouldRetry: attempt must be a positive integer');
  }
  const maxAttempts = options.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('shouldRetry: maxAttempts must be a positive integer');
  }
  return attempt < maxAttempts;
}

/**
 * Exponential backoff in whole milliseconds for the given attempt, capped at
 * `maxDelayMs`.
 *
 * @param {number} attempt the attempt number about to be retried after (1-indexed)
 * @param {{baseDelayMs?: number, factor?: number, maxDelayMs?: number}} [options]
 */
export function backoffDelayMs(attempt, options = {}) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError('backoffDelayMs: attempt must be a positive integer');
  }
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs;
  const factor = options.factor ?? DEFAULT_RETRY_POLICY.factor;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs;

  if (!(Number.isFinite(baseDelayMs) && baseDelayMs >= 0)) {
    throw new TypeError('backoffDelayMs: baseDelayMs must be a non-negative number');
  }
  if (!(Number.isFinite(factor) && factor >= 1)) {
    throw new TypeError('backoffDelayMs: factor must be a number >= 1');
  }
  if (!(Number.isFinite(maxDelayMs) && maxDelayMs >= 0)) {
    throw new TypeError('backoffDelayMs: maxDelayMs must be a non-negative number');
  }

  const delay = baseDelayMs * factor ** (attempt - 1);
  return Math.min(delay, maxDelayMs);
}

/**
 * Is this a transient failure worth retrying, as opposed to one an identical
 * retry cannot fix?
 *
 * Shaped for the normalised `{kind, status}` every `LlmError` already carries
 * (`src/adapters/llm/llmError.js`), but reads only that generic shape —
 * nothing provider- or service-specific — so the same function applies to
 * any external call that classifies its own failures the same way.
 *
 * | `kind`                       | Retryable? | Why |
 * |---|---|---|
 * | `timeout`, `unreachable`     | yes        | transient — the same request may simply work next time |
 * | `http_error`, status 429/5xx | yes        | the server itself said "not now" |
 * | `http_error`, other status   | no         | a fixed problem (bad auth, bad request) — retrying resends the identical mistake |
 * | `empty_response`             | no         | not a transport failure — a deliberate refusal or genuinely empty answer, which retrying will not change |
 */
export function isRetryableFailure(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.kind === 'timeout' || error.kind === 'unreachable') return true;
  if (error.kind === 'http_error') {
    const status = error.status;
    return status === 429 || (Number.isInteger(status) && status >= 500);
  }
  return false;
}
