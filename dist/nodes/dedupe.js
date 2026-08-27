// ============================================================================
// GENERATED FILE — do not edit by hand.
// Source: src/core/dedupe.js
// Regenerate with: npm run build:nodes
//
// This is the paste-ready body for an n8n Code node. src/core/ is the
// source of truth; a hand edit here will be silently overwritten and will
// not survive the next build (PROJECT_SPEC.md section 1).
// ============================================================================
/**
 * dedupe.js — dedupe_key generation and match rules.
 *
 * ZERO IMPORTS (see schema.js for why).
 *
 * The key produced here is written to a UNIQUE column, so this function is the
 * thing that makes intake idempotent. Two submissions describing the same person
 * must produce the same string, byte for byte, or the database guarantee is
 * worthless.
 *
 * Everything here is a pure function of its inputs — including the clock, which
 * is passed in rather than read. A key that silently changed at midnight would
 * be an unreproducible duplicate-lead bug.
 */

/** Key strategies, in the precedence order of spec section 7. */
const DEDUPE_STRATEGY = Object.freeze({
  SOURCE_ID: 'source_id',
  EMAIL: 'email',
  PHONE: 'phone',
  FALLBACK: 'fallback',
});

/**
 * FNV-1a, 32-bit.
 *
 * Deliberately NOT a cryptographic hash. This bucket exists to group repeated
 * anonymous submissions on the same day; it guards nothing and protects nothing,
 * so a fast dependency-free hash is the right tool. Node's crypto module would
 * be an import, which Code nodes cannot resolve.
 *
 * @param {string} input
 * @returns {string} 8 lowercase hex characters
 */
function fnv1a32(input) {
  const text = String(input ?? '');
  let hash = 0x811c9dc5;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // hash * 16777619 with 32-bit overflow, via shifts to stay in int range.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
}

/** UTC day bucket, YYYY-MM-DD. UTC so the bucket does not depend on server locale. */
function dayBucket(now) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(ms)) {
    throw new TypeError('dayBucket: now must be a Date or epoch milliseconds');
  }
  return new Date(ms).toISOString().slice(0, 10);
}

function present(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Build the dedupe key for a canonical lead.
 *
 * Precedence (spec section 7):
 *   1. source:source_id   when source_id exists
 *   2. email:<email>
 *   3. phone:<E.164>
 *   4. fallback:<hash>    and flag for human review
 *
 * The fallback case flags because a key derived from name + company + day is a
 * guess. Two different people at the same company on the same day would collide,
 * so a person confirms rather than the system silently merging them.
 *
 * @param {object} lead canonical lead fields (already normalised)
 * @param {{now: Date|number}} options
 */
function buildDedupeKey(lead, options) {
  const l = lead ?? {};

  if (present(l.source) && present(l.source_id)) {
    return {
      key: `${l.source.trim()}:${l.source_id.trim()}`,
      strategy: DEDUPE_STRATEGY.SOURCE_ID,
      needsHumanReview: false,
      reviewReason: null,
    };
  }

  if (present(l.email)) {
    return {
      key: `email:${l.email.trim().toLowerCase()}`,
      strategy: DEDUPE_STRATEGY.EMAIL,
      needsHumanReview: false,
      reviewReason: null,
    };
  }

  if (present(l.phone)) {
    return {
      key: `phone:${l.phone.trim()}`,
      strategy: DEDUPE_STRATEGY.PHONE,
      needsHumanReview: false,
      reviewReason: null,
    };
  }

  if (options?.now === undefined || options?.now === null) {
    throw new TypeError('buildDedupeKey: options.now is required for the fallback strategy');
  }

  const parts = [
    (l.first_name ?? '').trim().toLowerCase(),
    (l.last_name ?? '').trim().toLowerCase(),
    (l.company ?? '').trim().toLowerCase(),
    dayBucket(options.now),
  ].join('|');

  return {
    key: `fallback:${fnv1a32(parts)}`,
    strategy: DEDUPE_STRATEGY.FALLBACK,
    needsHumanReview: true,
    reviewReason: 'dedupe_fallback_key',
  };
}

/**
 * Detect a cross-key conflict between an inbound lead and the row it matched.
 *
 * The scenario: the same email address arrives under a different source_id. The
 * dedupe key is the source_id, so the database sees a brand-new lead — but the
 * email says otherwise. Auto-merging risks fusing two real people who share an
 * inbox; ignoring it risks duplicate outreach. Neither is safe to automate, so
 * it goes to a person.
 *
 * @returns {{conflict: boolean, reasons: string[], reviewReason: string|null}}
 */
function detectCrossKeyConflict(incoming, existing) {
  const a = incoming ?? {};
  const b = existing ?? {};
  const reasons = [];

  const sameKey = present(a.dedupe_key) && present(b.dedupe_key) && a.dedupe_key === b.dedupe_key;

  if (present(a.email) && present(b.email) && a.email.toLowerCase() !== b.email.toLowerCase()) {
    if (sameKey) reasons.push('same_dedupe_key_different_email');
  }

  if (present(a.phone) && present(b.phone) && a.phone !== b.phone) {
    if (sameKey) reasons.push('same_dedupe_key_different_phone');
  }

  if (!sameKey) {
    if (present(a.email) && present(b.email) && a.email.toLowerCase() === b.email.toLowerCase()) {
      reasons.push('same_email_different_dedupe_key');
    }
    if (present(a.phone) && present(b.phone) && a.phone === b.phone) {
      reasons.push('same_phone_different_dedupe_key');
    }
  }

  const conflict = reasons.length > 0;

  return {
    conflict,
    reasons,
    reviewReason: conflict ? `cross_key_conflict:${reasons.join(',')}` : null,
  };
}

/**
 * Merge an inbound lead into the existing row on a duplicate.
 *
 * Rules from spec section 7: fill empty fields from the newcomer, never
 * overwrite an existing non-empty value, and append the new message to
 * message_history. Notably absent: anything that would re-trigger the HOT alert
 * or restart the follow-up sequence. A customer who submits twice must not be
 * messaged twice.
 *
 * @returns {{patch: object, appendedMessage: boolean}}
 */
function mergeDuplicate(existing, incoming) {
  const base = existing ?? {};
  const next = incoming ?? {};
  const patch = {};

  const mergeable = [
    'first_name', 'last_name', 'email', 'phone', 'company',
    'service_interest', 'budget_raw', 'budget_amount', 'timeline', 'source_id',
  ];

  for (const field of mergeable) {
    const existingValue = base[field];
    const incomingValue = next[field];

    const existingEmpty = existingValue === null || existingValue === undefined || existingValue === '';
    const incomingUseful = incomingValue !== null && incomingValue !== undefined && incomingValue !== '';

    if (existingEmpty && incomingUseful) patch[field] = incomingValue;
  }

  let appendedMessage = false;
  const newMessage = next.message;

  if (typeof newMessage === 'string' && newMessage.trim() !== '' && newMessage !== base.message) {
    const history = Array.isArray(base.message_history) ? base.message_history : [];
    patch.message_history = [...history, newMessage];
    appendedMessage = true;
  }

  return { patch, appendedMessage };
}
