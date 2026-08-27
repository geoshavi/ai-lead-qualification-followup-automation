// ============================================================================
// GENERATED FILE — do not edit by hand.
// Source: src/core/webhookAuth.js
// Regenerate with: npm run build:nodes
//
// This is the paste-ready body for an n8n Code node. src/core/ is the
// source of truth; a hand edit here will be silently overwritten and will
// not survive the next build (PROJECT_SPEC.md section 1).
// ============================================================================
/**
 * webhookAuth.js — inbound webhook authentication (spec 4.1).
 *
 * ZERO IMPORTS (see schema.js for why).
 *
 * "Every inbound webhook requires a shared secret in a header (X-Lead-Token).
 * Compare against WEBHOOK_SECRET using a constant-time comparison. Reject
 * mismatches with 401 and log WORKFLOW_ERROR. Never echo the received token
 * into logs."
 *
 * This module makes the decision. It does not read a header, does not set an
 * HTTP status, and does not write to the audit log — that is n8n's job at the
 * webhook node and whatever CRM adapter call follows. 401 is the n8n-level
 * response for an unauthorized result; see docs/workflow.md for how that is
 * wired.
 *
 * WORKFLOW_ERROR and FAILURE below are the literal values of schema.js's
 * EVENT_TYPE.WORKFLOW_ERROR and EVENT_STATUS.FAILURE. They are not imported —
 * core modules stay independently pasteable — so if those enums ever change,
 * both places need updating together. followup.js does the same thing with
 * the HOT/WARM/COLD keys.
 */

/** Reasons verifyWebhookToken can report. Mirrors the failure branches below. */
const AUTH_FAILURE_REASONS = Object.freeze([
  'missing_token',
  'missing_secret',
  'invalid_token_type',
  'token_mismatch',
]);

/**
 * Constant-time string comparison.
 *
 * Walks the full length of the longer string regardless of where the first
 * difference falls, so a mismatch on character 1 and a mismatch on the last
 * character take the same number of comparisons. This is the property a
 * timing attack needs broken — an early `return false` on the first
 * difference is exactly what would leak the secret one byte at a time.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  const maxLength = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;

  for (let i = 0; i < maxLength; i += 1) {
    const charA = i < a.length ? a.charCodeAt(i) : 0;
    const charB = i < b.length ? b.charCodeAt(i) : 0;
    mismatch |= charA ^ charB;
  }

  return mismatch === 0;
}

/**
 * Decide whether an inbound webhook is authorized.
 *
 * An unset expectedSecret rejects every request rather than authorizing them —
 * a misconfigured deployment must fail closed, not fail open. A header n8n
 * hands back as an array (a client sent the header twice) is rejected as a
 * type error rather than silently compared against its first or joined value.
 *
 * @param {{receivedToken: unknown, expectedSecret: unknown}} input
 * @returns {{authorized: boolean, reason: string|null}}
 */
function verifyWebhookToken(input) {
  const { receivedToken, expectedSecret } = input ?? {};

  if (typeof expectedSecret !== 'string' || expectedSecret === '') {
    return { authorized: false, reason: 'missing_secret' };
  }

  if (receivedToken === undefined || receivedToken === null || receivedToken === '') {
    return { authorized: false, reason: 'missing_token' };
  }

  if (typeof receivedToken !== 'string') {
    return { authorized: false, reason: 'invalid_token_type' };
  }

  if (!constantTimeEqual(receivedToken, expectedSecret)) {
    return { authorized: false, reason: 'token_mismatch' };
  }

  return { authorized: true, reason: null };
}

const REASON_MESSAGES = Object.freeze({
  missing_token: 'webhook request carried no X-Lead-Token header',
  missing_secret: 'WEBHOOK_SECRET is not configured — rejecting every request',
  invalid_token_type: 'webhook X-Lead-Token header was not a single string value',
  token_mismatch: 'webhook X-Lead-Token did not match the configured secret',
});

/**
 * Build the WORKFLOW_ERROR audit event for a rejected webhook (spec 4.1).
 *
 * lead_id is null: no lead row exists yet at the auth-check step, which is
 * exactly why lead_events.lead_id is nullable (spec 3.2).
 *
 * @param {string} reason one of AUTH_FAILURE_REASONS
 * @returns {{event_type: string, status: string, lead_id: null, details: {reason: string}, error_message: string}}
 */
function buildAuthFailureEvent(reason) {
  if (!AUTH_FAILURE_REASONS.includes(reason)) {
    throw new TypeError(
      `buildAuthFailureEvent: unknown reason "${reason}". Expected one of ${AUTH_FAILURE_REASONS.join(', ')}.`,
    );
  }

  return {
    event_type: 'WORKFLOW_ERROR',
    status: 'FAILURE',
    lead_id: null,
    details: { reason },
    // Deliberately built from the fixed REASON_MESSAGES table, never from the
    // request itself — the received token must never reach a log line.
    error_message: REASON_MESSAGES[reason],
  };
}
