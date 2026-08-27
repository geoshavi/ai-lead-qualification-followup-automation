/**
 * schema.js — the canonical lead shape and its defaults.
 *
 * ZERO IMPORTS. This file is concatenated into an n8n Code node, which cannot
 * require() local files. Every helper it needs is defined here, even where that
 * means a few lines are repeated across core modules. That duplication is the
 * deliberate price of keeping each module independently pasteable.
 *
 * This mirrors db/001_schema.sql. The three columns the database generates
 * (lead_id, created_at, updated_at) are absent by design — code never sets them.
 */

/** Valid inbound sources (matches leads_source_check). */
export const SOURCES = Object.freeze(['website', 'meta', 'email']);

/** Pipeline status values (matches leads_crm_status_check). */
export const CRM_STATUS = Object.freeze({
  NEW: 'NEW',
  QUALIFIED: 'QUALIFIED',
  CONTACTED: 'CONTACTED',
  NURTURING: 'NURTURING',
  BOOKED: 'BOOKED',
  LOST: 'LOST',
  HUMAN_REVIEW: 'HUMAN_REVIEW',
});

/** Follow-up sequence states (matches leads_followup_status_chk). */
export const FOLLOWUP_STATUS = Object.freeze({
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  STOPPED: 'STOPPED',
  COMPLETED: 'COMPLETED',
});

/** Derived temperature bands (matches leads_temperature_check). */
export const TEMPERATURE = Object.freeze({
  HOT: 'HOT',
  WARM: 'WARM',
  COLD: 'COLD',
});

/** Booking states (matches leads_booking_status_chk). */
export const BOOKING_STATUS = Object.freeze({
  NONE: 'NONE',
  BOOKED: 'BOOKED',
  CANCELLED: 'CANCELLED',
});

/** Audit event types (matches lead_events_type_check). */
export const EVENT_TYPE = Object.freeze({
  LEAD_RECEIVED: 'LEAD_RECEIVED',
  LEAD_NORMALIZED: 'LEAD_NORMALIZED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  DUPLICATE_FOUND: 'DUPLICATE_FOUND',
  AI_SCORE_CREATED: 'AI_SCORE_CREATED',
  AI_SCORE_INVALID: 'AI_SCORE_INVALID',
  CRM_CREATED: 'CRM_CREATED',
  CRM_UPDATED: 'CRM_UPDATED',
  SLACK_ALERT_SENT: 'SLACK_ALERT_SENT',
  FOLLOWUP_SENT: 'FOLLOWUP_SENT',
  FOLLOWUP_STOPPED: 'FOLLOWUP_STOPPED',
  BOOKING_RECEIVED: 'BOOKING_RECEIVED',
  SHEET_SYNCED: 'SHEET_SYNCED',
  HUMAN_REVIEW_FLAGGED: 'HUMAN_REVIEW_FLAGGED',
  WORKFLOW_ERROR: 'WORKFLOW_ERROR',
});

/** Audit event outcomes (matches lead_events_status_check). */
export const EVENT_STATUS = Object.freeze({
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  SKIPPED: 'SKIPPED',
});

/** Notification kinds (matches notifications_kind_check). */
export const NOTIFICATION_KIND = Object.freeze({
  SLACK_HOT: 'SLACK_HOT',
  FOLLOWUP: 'FOLLOWUP',
  BOOKING_CONFIRM: 'BOOKING_CONFIRM',
});

/**
 * Every field code is allowed to write, in database column order.
 * Anything outside this list is dropped by pickCanonical.
 */
export const CANONICAL_FIELDS = Object.freeze([
  'source',
  'source_id',
  'first_name',
  'last_name',
  'email',
  'phone',
  'company',
  'service_interest',
  'message',
  'budget_raw',
  'budget_amount',
  'budget_currency',
  'timeline',
  'lead_score',
  'lead_temperature',
  'ai_reasoning',
  'recommended_action',
  'crm_status',
  'followup_status',
  'followup_step',
  'next_followup_at',
  'last_contacted_at',
  'replied_at',
  'assigned_to',
  'booking_status',
  'needs_human_review',
  'review_reason',
  'dedupe_key',
  'raw_payload',
  'message_history',
]);

/**
 * Defaults for a brand-new lead. These intentionally mirror the DEFAULT
 * clauses in 001_schema.sql so that a row created through the mock adapter and
 * a row created through Postgres are indistinguishable.
 */
export function leadDefaults() {
  return {
    source: null,
    source_id: null,
    first_name: null,
    last_name: null,
    email: null,
    phone: null,
    company: null,
    service_interest: null,
    message: null,
    budget_raw: null,
    budget_amount: null,
    budget_currency: 'USD',
    timeline: null,
    lead_score: null,
    lead_temperature: null,
    ai_reasoning: null,
    recommended_action: null,
    crm_status: CRM_STATUS.NEW,
    followup_status: FOLLOWUP_STATUS.PENDING,
    followup_step: 0,
    next_followup_at: null,
    last_contacted_at: null,
    replied_at: null,
    assigned_to: null,
    booking_status: BOOKING_STATUS.NONE,
    needs_human_review: false,
    review_reason: null,
    dedupe_key: null,
    raw_payload: {},
    message_history: [],
  };
}

/** True for a non-null, non-array object. */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Drop any key that is not a canonical field.
 *
 * Inbound payloads are attacker-influenced, so an unknown key must never reach
 * an INSERT. This is the allowlist that guarantees it.
 */
export function pickCanonical(input) {
  const out = {};
  if (!isPlainObject(input)) return out;
  for (const field of CANONICAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      out[field] = input[field];
    }
  }
  return out;
}

/** Build a canonical lead: defaults, then allowlisted overrides on top. */
export function createLead(overrides) {
  return { ...leadDefaults(), ...pickCanonical(overrides) };
}
