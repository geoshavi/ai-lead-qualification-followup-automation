/**
 * leadRow.js — the `leads` row as the database defines it.
 *
 * Column types, the CHECK constraints from db/001_schema.sql expressed in
 * JavaScript, and the coercion that makes any store hand back the same shape.
 *
 * Shared by both CRM adapters on purpose. A store that reports `budget_amount`
 * as a string where the other reports a number is a bug in the adapter, not a
 * behaviour worth preserving — so the type map is declared once, next to the
 * enumerations it depends on, rather than reimplemented per adapter. What is
 * NOT shared is behaviour: conflict handling, ordering and filtering are
 * written independently in each adapter and compared by the parity suite.
 *
 * This is adapter-layer code. It is not in src/core/, it never reaches a Code
 * node, and it is free to import — but it happens to import only from
 * src/core/schema.js, which owns the enumerations.
 */

import {
  BOOKING_STATUS,
  CANONICAL_FIELDS,
  CRM_STATUS,
  EVENT_STATUS,
  EVENT_TYPE,
  FOLLOWUP_STATUS,
  NOTIFICATION_KIND,
  SOURCES,
  TEMPERATURE,
  createLead,
  isPlainObject,
  pickCanonical,
} from '../core/schema.js';

/** Column type per canonical field, mirroring db/001_schema.sql. */
export const COLUMN_TYPES = Object.freeze({
  source: 'text',
  source_id: 'text',
  first_name: 'text',
  last_name: 'text',
  email: 'text',
  phone: 'text',
  company: 'text',
  service_interest: 'text',
  message: 'text',
  budget_raw: 'text',
  budget_amount: 'numeric',
  budget_currency: 'text',
  timeline: 'text',
  lead_score: 'int',
  lead_temperature: 'text',
  ai_reasoning: 'text',
  recommended_action: 'text',
  crm_status: 'text',
  followup_status: 'text',
  followup_step: 'int',
  next_followup_at: 'timestamptz',
  last_contacted_at: 'timestamptz',
  replied_at: 'timestamptz',
  assigned_to: 'text',
  booking_status: 'text',
  needs_human_review: 'boolean',
  review_reason: 'text',
  dedupe_key: 'text',
  raw_payload: 'jsonb',
  message_history: 'jsonb',
});

/** The three columns the database generates. Code never sets them. */
export const GENERATED_FIELDS = Object.freeze(['lead_id', 'created_at', 'updated_at']);

const NULLISH = (value) => value === null || value === undefined || value === '';

/**
 * Normalise any timestamp representation to ISO-8601 UTC.
 *
 * PostgREST renders `timestamptz` as `2026-03-10T16:00:00+00:00`; a JSON file
 * round-trips whatever it was given. Both become `2026-03-10T16:00:00.000Z`,
 * so a row from either store compares equal.
 */
export function toIsoUtc(value, column) {
  if (NULLISH(value)) return null;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`leads.${column}: not a valid timestamp — received ${JSON.stringify(value)}`);
  }
  return date.toISOString();
}

function toNumber(value, column) {
  if (NULLISH(value)) return null;

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`leads.${column}: not a valid number — received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function toInt(value, column) {
  const parsed = toNumber(value, column);
  if (parsed === null) return null;
  if (!Number.isInteger(parsed)) {
    throw new TypeError(`leads.${column}: expected an integer — received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function toText(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

/** Deep copy, so a stored jsonb value can never be mutated through the caller's reference. */
function cloneJson(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

/** Coerce one canonical field to its column type. */
export function coerceField(field, value) {
  switch (COLUMN_TYPES[field]) {
    case 'numeric':
      return toNumber(value, field);
    case 'int':
      return toInt(value, field);
    case 'timestamptz':
      return toIsoUtc(value, field);
    case 'boolean':
      return NULLISH(value) && value !== false ? null : Boolean(value);
    case 'jsonb':
      return cloneJson(value);
    case 'text':
      return toText(value);
    default:
      return value;
  }
}

/**
 * Coerce a whole row — canonical fields plus the generated three — into the
 * shape every adapter promises. Fields absent from the input stay absent, so
 * this is safe to run over a partial row read back from PostgREST.
 */
export function coerceLeadRow(row) {
  if (!isPlainObject(row)) {
    throw new TypeError('coerceLeadRow: expected an object');
  }

  const out = {};

  for (const field of CANONICAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      out[field] = coerceField(field, row[field]);
    }
  }

  if ('lead_id' in row) out.lead_id = toText(row.lead_id);
  if ('created_at' in row) out.created_at = toIsoUtc(row.created_at, 'created_at');
  if ('updated_at' in row) out.updated_at = toIsoUtc(row.updated_at, 'updated_at');

  return out;
}

// ---------------------------------------------------------------------------
// Constraints
//
// Every rule below is a CHECK or NOT NULL in db/001_schema.sql. Checking them
// in the adapter is not a substitute for the database constraint — Postgres
// remains the authority, and a race can only be settled there. It exists so
// that both adapters reject the same value with the same message, which is
// what makes one parity suite meaningful, and so that a bad write fails before
// an HTTP round trip rather than after one.
// ---------------------------------------------------------------------------

function oneOf(value, allowed, column, { nullable }) {
  if (NULLISH(value)) {
    if (nullable) return;
    throw new TypeError(`leads.${column}: required — received ${JSON.stringify(value)}`);
  }
  if (!allowed.includes(value)) {
    throw new TypeError(
      `leads.${column}: expected one of ${allowed.join(', ')} — received ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Assert a complete leads row satisfies every constraint the schema declares.
 * Pass the merged result of an update, not the patch — `followup_step >= 0`
 * is a property of the row, not of the change.
 */
export function assertValidLead(row) {
  if (!isPlainObject(row)) {
    throw new TypeError('assertValidLead: expected an object');
  }

  oneOf(row.source, SOURCES, 'source', { nullable: false });
  oneOf(row.crm_status, Object.values(CRM_STATUS), 'crm_status', { nullable: false });
  oneOf(row.followup_status, Object.values(FOLLOWUP_STATUS), 'followup_status', { nullable: false });
  oneOf(row.booking_status, Object.values(BOOKING_STATUS), 'booking_status', { nullable: false });
  oneOf(row.lead_temperature, Object.values(TEMPERATURE), 'lead_temperature', { nullable: true });

  if (typeof row.dedupe_key !== 'string' || row.dedupe_key.trim() === '') {
    throw new TypeError(
      `leads.dedupe_key: required, must be a non-empty string — received ${JSON.stringify(row.dedupe_key)}`,
    );
  }

  if (typeof row.budget_currency !== 'string' || row.budget_currency === '') {
    throw new TypeError(
      `leads.budget_currency: required — received ${JSON.stringify(row.budget_currency)}`,
    );
  }

  if (row.lead_score !== null && !(Number.isInteger(row.lead_score) && row.lead_score >= 0 && row.lead_score <= 100)) {
    throw new TypeError(
      `leads.lead_score: expected an integer between 0 and 100 — received ${JSON.stringify(row.lead_score)}`,
    );
  }

  if (!Number.isInteger(row.followup_step) || row.followup_step < 0) {
    throw new TypeError(
      `leads.followup_step: expected a non-negative integer — received ${JSON.stringify(row.followup_step)}`,
    );
  }

  if (typeof row.needs_human_review !== 'boolean') {
    throw new TypeError(
      `leads.needs_human_review: expected a boolean — received ${JSON.stringify(row.needs_human_review)}`,
    );
  }

  if (!Array.isArray(row.message_history)) {
    throw new TypeError(
      `leads.message_history: expected an array — received ${JSON.stringify(row.message_history)}`,
    );
  }

  if (!isPlainObject(row.raw_payload) && !Array.isArray(row.raw_payload)) {
    throw new TypeError(
      `leads.raw_payload: expected a JSON object — received ${JSON.stringify(row.raw_payload)}`,
    );
  }

  return row;
}

/**
 * Build the row an INSERT should write: defaults, allowlisted input on top,
 * coerced to column types, then checked.
 *
 * `pickCanonical` is what stops an attacker-supplied `lead_id` or `is_admin`
 * from ever reaching the statement.
 */
export function buildInsertRow(input) {
  return assertValidLead(coerceLeadRow(createLead(input)));
}

/**
 * Build the patch an UPDATE should write, and the merged row to validate it
 * against.
 *
 * @returns {{patch: object, merged: object, fields: string[]}}
 */
export function buildUpdatePatch(existing, patch) {
  const allowed = pickCanonical(patch);
  const coerced = coerceLeadRow(allowed);
  const merged = assertValidLead({ ...existing, ...coerced });

  // CANONICAL_FIELDS order rather than key-insertion order, so the audit entry
  // for a given change is the same string every time.
  const fields = CANONICAL_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(coerced, f));

  return { patch: coerced, merged, fields };
}

// ---------------------------------------------------------------------------
// lead_events
// ---------------------------------------------------------------------------

/**
 * Validate and fill in an audit event.
 *
 * `lead_id` is nullable on purpose: a payload can fail validation before any
 * lead row exists, and that failure still has to be auditable.
 */
export function buildEventRow(event) {
  if (!isPlainObject(event)) {
    throw new TypeError('recordEvent: expected an event object');
  }

  const eventTypes = Object.values(EVENT_TYPE);
  if (!eventTypes.includes(event.event_type)) {
    throw new TypeError(
      `lead_events.event_type: expected one of ${eventTypes.join(', ')} — received ${JSON.stringify(event.event_type)}`,
    );
  }

  const statuses = Object.values(EVENT_STATUS);
  if (!statuses.includes(event.status)) {
    throw new TypeError(
      `lead_events.status: expected one of ${statuses.join(', ')} — received ${JSON.stringify(event.status)}`,
    );
  }

  const details = event.details === undefined || event.details === null ? {} : event.details;
  if (!isPlainObject(details) && !Array.isArray(details)) {
    throw new TypeError(`lead_events.details: expected a JSON object — received ${JSON.stringify(details)}`);
  }

  return {
    lead_id: NULLISH(event.lead_id) ? null : String(event.lead_id),
    event_type: event.event_type,
    status: event.status,
    details: cloneJson(details),
    error_message: NULLISH(event.error_message) ? null : String(event.error_message),
  };
}

/** Coerce an event row read back out of a store. */
export function coerceEventRow(row) {
  return {
    event_id: toText(row.event_id),
    lead_id: NULLISH(row.lead_id) ? null : toText(row.lead_id),
    event_type: row.event_type,
    status: row.status,
    details: cloneJson(row.details ?? {}),
    error_message: NULLISH(row.error_message) ? null : toText(row.error_message),
    created_at: toIsoUtc(row.created_at, 'created_at'),
  };
}

// ---------------------------------------------------------------------------
// notifications — the idempotency guard (spec 3.3 / M6)
// ---------------------------------------------------------------------------

/**
 * Validate a notification claim before the adapter attempts the insert.
 *
 * `UNIQUE (lead_id, kind, step)` is the entire duplicate-prevention mechanism
 * for a send: "before sending anything, attempt the insert. If it violates
 * the constraint, the message was already sent — skip" (spec 3.3). This
 * function only shapes and validates the row; the claim-or-refuse decision is
 * the adapter's, because only the adapter knows whether the insert landed.
 */
export function buildNotificationRow(input) {
  if (!isPlainObject(input)) {
    throw new TypeError('claimNotification: expected an object');
  }

  const leadId = input.lead_id ?? input.leadId;
  if (typeof leadId !== 'string' || leadId.trim() === '') {
    throw new TypeError(`notifications.lead_id: required — received ${JSON.stringify(leadId)}`);
  }

  const kinds = Object.values(NOTIFICATION_KIND);
  if (!kinds.includes(input.kind)) {
    throw new TypeError(
      `notifications.kind: expected one of ${kinds.join(', ')} — received ${JSON.stringify(input.kind)}`,
    );
  }

  const step = input.step ?? 0;
  if (!Number.isInteger(step) || step < 0) {
    throw new TypeError(`notifications.step: expected a non-negative integer — received ${JSON.stringify(step)}`);
  }

  return { lead_id: leadId, kind: input.kind, step };
}

/** Coerce a notification row read back out of a store. */
export function coerceNotificationRow(row) {
  return {
    id: toText(row.id),
    lead_id: toText(row.lead_id),
    kind: row.kind,
    step: toInt(row.step, 'step'),
    sent_at: toIsoUtc(row.sent_at, 'sent_at'),
  };
}
