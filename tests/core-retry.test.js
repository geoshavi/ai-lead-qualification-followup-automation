/**
 * core-retry.test.js — retry-with-backoff policy (spec 9, M8).
 *
 * These are pure-function tests: no timers, no fetch, no clock. The applied
 * version — actually sleeping and re-calling a real external call — is
 * exercised against the LLM provider path in tests/llm-score-lead.test.js
 * ("scenario 16"), since that is the one real transport call this project's
 * code makes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RETRY_POLICY,
  backoffDelayMs,
  isRetryableFailure,
  shouldRetry,
} from '../src/core/retry.js';

describe('shouldRetry', () => {
  test('true while the attempt that just failed is below the bound', () => {
    assert.equal(shouldRetry(1, { maxAttempts: 3 }), true);
    assert.equal(shouldRetry(2, { maxAttempts: 3 }), true);
  });

  test('false once the attempt that just failed reaches the bound', () => {
    assert.equal(shouldRetry(3, { maxAttempts: 3 }), false);
  });

  test('defaults to DEFAULT_RETRY_POLICY.maxAttempts when unset', () => {
    assert.equal(shouldRetry(DEFAULT_RETRY_POLICY.maxAttempts, {}), false);
    assert.equal(shouldRetry(DEFAULT_RETRY_POLICY.maxAttempts - 1, {}), true);
  });

  test('rejects a non-positive-integer attempt', () => {
    assert.throws(() => shouldRetry(0, { maxAttempts: 3 }));
    assert.throws(() => shouldRetry(1.5, { maxAttempts: 3 }));
    assert.throws(() => shouldRetry(-1, { maxAttempts: 3 }));
  });

  test('rejects a non-positive-integer maxAttempts', () => {
    assert.throws(() => shouldRetry(1, { maxAttempts: 0 }));
    assert.throws(() => shouldRetry(1, { maxAttempts: 1.5 }));
  });
});

describe('backoffDelayMs', () => {
  test('the first attempt waits exactly baseDelayMs', () => {
    assert.equal(backoffDelayMs(1, { baseDelayMs: 200, factor: 2 }), 200);
  });

  test('doubles each attempt with the default factor', () => {
    assert.equal(backoffDelayMs(2, { baseDelayMs: 200, factor: 2 }), 400);
    assert.equal(backoffDelayMs(3, { baseDelayMs: 200, factor: 2 }), 800);
  });

  test('is capped at maxDelayMs', () => {
    assert.equal(backoffDelayMs(10, { baseDelayMs: 200, factor: 2, maxDelayMs: 500 }), 500);
  });

  test('is deterministic — same attempt, same delay, every time (no jitter, no clock)', () => {
    const a = backoffDelayMs(3, { baseDelayMs: 50, factor: 3 });
    const b = backoffDelayMs(3, { baseDelayMs: 50, factor: 3 });
    assert.equal(a, b);
  });

  test('uses DEFAULT_RETRY_POLICY when no options are given', () => {
    assert.equal(backoffDelayMs(1), DEFAULT_RETRY_POLICY.baseDelayMs);
  });

  test('rejects a non-positive-integer attempt', () => {
    assert.throws(() => backoffDelayMs(0));
    assert.throws(() => backoffDelayMs(1.5));
  });

  test('rejects an out-of-range policy', () => {
    assert.throws(() => backoffDelayMs(1, { baseDelayMs: -1 }));
    assert.throws(() => backoffDelayMs(1, { factor: 0.5 }));
    assert.throws(() => backoffDelayMs(1, { maxDelayMs: -1 }));
  });
});

describe('isRetryableFailure', () => {
  test('timeout and unreachable are always retryable', () => {
    assert.equal(isRetryableFailure({ kind: 'timeout' }), true);
    assert.equal(isRetryableFailure({ kind: 'unreachable' }), true);
  });

  test('an http_error is retryable at 429 and any 5xx', () => {
    assert.equal(isRetryableFailure({ kind: 'http_error', status: 429 }), true);
    assert.equal(isRetryableFailure({ kind: 'http_error', status: 500 }), true);
    assert.equal(isRetryableFailure({ kind: 'http_error', status: 503 }), true);
  });

  test('an http_error is not retryable at other statuses — a fixed problem, not a transient one', () => {
    assert.equal(isRetryableFailure({ kind: 'http_error', status: 400 }), false);
    assert.equal(isRetryableFailure({ kind: 'http_error', status: 401 }), false);
    assert.equal(isRetryableFailure({ kind: 'http_error', status: 404 }), false);
  });

  test('empty_response is not retryable — a deliberate refusal or genuinely empty answer', () => {
    assert.equal(isRetryableFailure({ kind: 'empty_response' }), false);
  });

  test('an unrecognised kind is not retryable', () => {
    assert.equal(isRetryableFailure({ kind: 'something_else' }), false);
  });

  test('a non-object is not retryable', () => {
    assert.equal(isRetryableFailure(null), false);
    assert.equal(isRetryableFailure(undefined), false);
    assert.equal(isRetryableFailure('nope'), false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 13 (spec 10) — "Slack API returns 500 → retried, logged, lead
// unaffected". Slack itself has no adapter code (it is an n8n built-in node
// on the canvas, like every other outbound send in this project), so nothing
// in this suite calls it — that would be inventing an integration the spec
// never asks for (section 0, rule 2). What IS this project's code is the
// generic retry mechanism such a send would use; this proves the mechanism
// composes correctly for any external call shaped like Slack's failure mode
// (a transient 5xx, then success), which is the part of scenario 13 this
// codebase can actually assert on.
// ---------------------------------------------------------------------------
describe('scenario 13: a failing external call is retried with backoff, then succeeds', () => {
  async function withRetry(callExternal, options = {}) {
    const policy = { maxAttempts: options.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts };
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return { ok: true, attempts: attempt, result: await callExternal(attempt) };
      } catch (error) {
        if (!isRetryableFailure(error) || !shouldRetry(attempt, policy)) {
          return { ok: false, attempts: attempt, error };
        }
        // No real sleep: backoffDelayMs's own value is asserted separately above.
      }
    }
  }

  test('a 500 twice, then a 200, resolves after exactly three attempts', async () => {
    let calls = 0;
    const send = async () => {
      calls += 1;
      if (calls < 3) throw { kind: 'http_error', status: 500 };
      return { status: 200 };
    };

    const outcome = await withRetry(send);

    assert.equal(outcome.ok, true);
    assert.equal(outcome.attempts, 3);
    assert.equal(calls, 3, 'retried exactly twice before the call that succeeded');
  });

  test('a persistent 500 exhausts the bound and reports failure without throwing', async () => {
    let calls = 0;
    const send = async () => {
      calls += 1;
      throw { kind: 'http_error', status: 500 };
    };

    const outcome = await withRetry(send);

    assert.equal(outcome.ok, false);
    assert.equal(calls, DEFAULT_RETRY_POLICY.maxAttempts, 'bounded — never a loop');
  });

  test('a 400 is not retried — the caller is told immediately', async () => {
    let calls = 0;
    const send = async () => {
      calls += 1;
      throw { kind: 'http_error', status: 400 };
    };

    const outcome = await withRetry(send);

    assert.equal(calls, 1);
    assert.equal(outcome.ok, false);
  });
});
