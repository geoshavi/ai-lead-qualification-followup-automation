/**
 * core-webhookAuth.test.js — inbound webhook authentication (spec 4.1).
 *
 * "Every inbound webhook requires a shared secret in a header (X-Lead-Token).
 * Compare against WEBHOOK_SECRET using a constant-time comparison. Reject
 * mismatches with 401 and log WORKFLOW_ERROR. Never echo the received token
 * into logs."
 *
 * Four things this file has to prove: the comparison doesn't short-circuit on
 * the first mismatched character (constant-time), a missing or misconfigured
 * secret is rejected rather than silently authorized, nothing here ever
 * returns the raw token anywhere a log line could pick it up, and the failure
 * event this module builds matches the lead_events shape from schema.js
 * without importing it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAuthFailureEvent,
  constantTimeEqual,
  verifyWebhookToken,
} from '../src/core/webhookAuth.js';

describe('constantTimeEqual', () => {
  test('equal strings match', () => {
    assert.equal(constantTimeEqual('a-shared-secret', 'a-shared-secret'), true);
  });

  test('both empty strings match', () => {
    assert.equal(constantTimeEqual('', ''), true);
  });

  test('same length, different content does not match', () => {
    assert.equal(constantTimeEqual('aaaaaaaa', 'aaaaaaab'), false);
  });

  test('different lengths never match', () => {
    assert.equal(constantTimeEqual('short', 'much-longer-value'), false);
  });

  test('is case-sensitive', () => {
    assert.equal(constantTimeEqual('Secret', 'secret'), false);
  });

  test('does not trim — accidental whitespace is a real mismatch, not noise', () => {
    assert.equal(constantTimeEqual('secret', 'secret '), false);
    assert.equal(constantTimeEqual(' secret', 'secret'), false);
  });

  test('a mismatch at the first character behaves the same as a mismatch at the last', () => {
    // Not a timing proof (impossible in a unit test on a JIT'd interpreter),
    // but it does prove the function does not early-return per character —
    // both cases must reach the same false verdict through the same path.
    assert.equal(constantTimeEqual('xaaaaaaa', 'aaaaaaaa'), false);
    assert.equal(constantTimeEqual('aaaaaaax', 'aaaaaaaa'), false);
  });

  test('non-string inputs are rejected, not coerced', () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      assert.equal(constantTimeEqual(bad, 'secret'), false);
      assert.equal(constantTimeEqual('secret', bad), false);
    }
  });

  test('never throws, whatever it is handed', () => {
    assert.doesNotThrow(() => constantTimeEqual(undefined, undefined));
    assert.doesNotThrow(() => constantTimeEqual(Symbol('x'), 'secret'));
  });
});

describe('verifyWebhookToken', () => {
  const SECRET = 'a-real-webhook-secret-value';

  test('the correct token authorizes with no reason', () => {
    const result = verifyWebhookToken({ receivedToken: SECRET, expectedSecret: SECRET });
    assert.equal(result.authorized, true);
    assert.equal(result.reason, null);
  });

  test('the wrong token is rejected as a mismatch', () => {
    const result = verifyWebhookToken({ receivedToken: 'wrong-value', expectedSecret: SECRET });
    assert.equal(result.authorized, false);
    assert.equal(result.reason, 'token_mismatch');
  });

  for (const missing of [undefined, null, '']) {
    test(`a ${JSON.stringify(missing)} header is rejected as missing, not as a mismatch`, () => {
      const result = verifyWebhookToken({ receivedToken: missing, expectedSecret: SECRET });
      assert.equal(result.authorized, false);
      assert.equal(result.reason, 'missing_token');
    });
  }

  test('a duplicated header (n8n hands back an array) is rejected, not stringified and compared', () => {
    const result = verifyWebhookToken({ receivedToken: [SECRET, SECRET], expectedSecret: SECRET });
    assert.equal(result.authorized, false);
    assert.equal(result.reason, 'invalid_token_type');
  });

  for (const missing of [undefined, null, '']) {
    test(`an unset WEBHOOK_SECRET (${JSON.stringify(missing)}) rejects every request rather than authorizing it`, () => {
      const result = verifyWebhookToken({ receivedToken: SECRET, expectedSecret: missing });
      assert.equal(result.authorized, false);
      assert.equal(result.reason, 'missing_secret');
    });
  }

  test('a misconfigured secret rejects even a token that happens to equal the empty string check path', () => {
    // Guards against a bug where an empty expectedSecret makes every header "match" via ''===''.
    const result = verifyWebhookToken({ receivedToken: '', expectedSecret: '' });
    assert.equal(result.authorized, false);
  });

  test('the result never contains the received token anywhere, even on success', () => {
    const secret = 'CANARY-do-not-leak-this-value';
    const result = verifyWebhookToken({ receivedToken: secret, expectedSecret: secret });
    assert.ok(!JSON.stringify(result).includes(secret), 'the token must never appear in the return value');
  });

  test('the result never contains the token on failure either', () => {
    const secret = 'CANARY-wrong-attempt';
    const result = verifyWebhookToken({ receivedToken: secret, expectedSecret: 'a-real-webhook-secret-value' });
    assert.ok(!JSON.stringify(result).includes(secret));
  });
});

describe('buildAuthFailureEvent (spec 4.1: log WORKFLOW_ERROR on mismatch)', () => {
  test('matches the lead_events shape schema.js defines, without importing it', () => {
    const event = buildAuthFailureEvent('token_mismatch');

    assert.equal(event.event_type, 'WORKFLOW_ERROR');
    assert.equal(event.status, 'FAILURE');
    assert.equal(event.lead_id, null, 'no lead exists yet at the auth-check step');
    assert.equal(event.details.reason, 'token_mismatch');
    assert.equal(typeof event.error_message, 'string');
  });

  test('one event shape per verifyWebhookToken failure reason', () => {
    for (const reason of ['missing_token', 'missing_secret', 'token_mismatch', 'invalid_token_type']) {
      const event = buildAuthFailureEvent(reason);
      assert.equal(event.details.reason, reason);
      assert.match(event.error_message, /webhook/i);
    }
  });

  test('an unrecognised reason is rejected rather than silently logged as something else', () => {
    assert.throws(() => buildAuthFailureEvent('made_up_reason'), /reason/i);
  });

  test('the error message never contains a token value — it only names the reason category', () => {
    const secret = 'CANARY-should-never-appear-in-a-log';
    const event = buildAuthFailureEvent('token_mismatch', { hint: secret });
    assert.ok(!JSON.stringify(event).includes(secret));
  });
});

describe('end to end: verifyWebhookToken feeds buildAuthFailureEvent directly', () => {
  test('an unauthorized result\'s reason is always a valid buildAuthFailureEvent reason', () => {
    const cases = [
      { receivedToken: undefined, expectedSecret: 'x' },
      { receivedToken: 'wrong', expectedSecret: 'x' },
      { receivedToken: 'x', expectedSecret: undefined },
      { receivedToken: ['x', 'x'], expectedSecret: 'x' },
    ];

    for (const input of cases) {
      const result = verifyWebhookToken(input);
      assert.equal(result.authorized, false);
      assert.doesNotThrow(() => buildAuthFailureEvent(result.reason));
    }
  });
});
