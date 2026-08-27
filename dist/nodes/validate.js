// ============================================================================
// GENERATED FILE — do not edit by hand.
// Source: src/core/validate.js
// Regenerate with: npm run build:nodes
//
// This is the paste-ready body for an n8n Code node. src/core/ is the
// source of truth; a hand edit here will be silently overwritten and will
// not survive the next build (PROJECT_SPEC.md section 1).
// ============================================================================
/**
 * validate.js — required field checks on a canonical lead.
 *
 * ZERO IMPORTS (see schema.js for why).
 *
 * Validation decides whether a lead can proceed down the happy path. It never
 * decides whether a lead is KEPT — a failing lead is still persisted and routed
 * to human review, because a malformed email is usually a typo by someone who
 * genuinely wants to buy something.
 */

/**
 * Pragmatic email check, not an RFC 5322 implementation.
 *
 * Requires a local part, an @, and a dotted domain. RFC-complete validation
 * accepts addresses no mail provider will deliver to and is a well-known source
 * of false negatives on legitimate addresses; this is the useful middle.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Sources accepted by the database CHECK constraint. */
const VALID_SOURCES = Object.freeze(['website', 'meta', 'email']);

/** True if the value is a usable non-empty string. */
function present(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** Is this a plausibly deliverable email address? */
function isValidEmail(value) {
  if (!present(value)) return false;
  if (value.length > 254) return false;
  return EMAIL_PATTERN.test(value);
}

/** Is this an E.164 phone number? */
function isValidPhone(value) {
  if (!present(value)) return false;
  return /^\+[1-9]\d{7,14}$/.test(value);
}

/**
 * Validate a canonical lead.
 *
 * Rules:
 *   1. source must be one of the three known values
 *   2. at least one contact method must be present and well-formed —
 *      a lead nobody can reply to has no business value
 *   3. email, if supplied, must be well-formed
 *   4. phone, if supplied, must be E.164
 *
 * Rule 2 is why "missing phone, valid email" passes while "malformed email,
 * no phone" fails.
 *
 * @param {object} lead canonical lead fields
 * @returns {{ok: boolean, errors: Array<{field: string, code: string, message: string}>,
 *            needsHumanReview: boolean, reviewReason: string|null}}
 */
function validateLead(lead) {
  const errors = [];
  const l = lead ?? {};

  if (!present(l.source)) {
    errors.push({ field: 'source', code: 'REQUIRED', message: 'source is required' });
  } else if (!VALID_SOURCES.includes(l.source)) {
    errors.push({
      field: 'source',
      code: 'INVALID_ENUM',
      message: `source must be one of ${VALID_SOURCES.join(', ')}`,
    });
  }

  const hasEmail = present(l.email);
  const hasPhone = present(l.phone);

  if (hasEmail && !isValidEmail(l.email)) {
    errors.push({ field: 'email', code: 'INVALID_FORMAT', message: 'email is not a valid address' });
  }

  if (hasPhone && !isValidPhone(l.phone)) {
    errors.push({ field: 'phone', code: 'INVALID_FORMAT', message: 'phone is not in E.164 format' });
  }

  const hasUsableContact =
    (hasEmail && isValidEmail(l.email)) || (hasPhone && isValidPhone(l.phone));

  if (!hasUsableContact) {
    errors.push({
      field: 'contact',
      code: 'NO_CONTACT_METHOD',
      message: 'a lead needs at least one valid email or phone number',
    });
  }

  const ok = errors.length === 0;

  return {
    ok,
    errors,
    // A validation failure never drops the lead; it routes it to a person.
    needsHumanReview: !ok,
    reviewReason: ok ? null : `validation_failed:${errors.map((e) => e.field).join(',')}`,
  };
}
