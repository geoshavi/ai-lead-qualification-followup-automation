import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isValidEmail, isValidPhone, validateLead } from '../src/core/validate.js';

const base = { source: 'website', email: 'ada@example.com', phone: null };

describe('email validation', () => {
  const valid = [
    'ada@example.com',
    'ada.lovelace@sub.example.co.uk',
    'ada+leads@example.com',
    "o'brien@example.com",
  ];
  for (const email of valid) {
    test(`accepts ${email}`, () => assert.equal(isValidEmail(email), true));
  }

  const invalid = [
    ['no-at-sign', 'missing @'],
    ['ada@', 'no domain'],
    ['@example.com', 'no local part'],
    ['ada@example', 'no dot in domain'],
    ['ada @example.com', 'embedded space'],
    ['ada@exam ple.com', 'space in domain'],
    ['', 'empty'],
    ['ada@@example.com', 'double @'],
  ];
  for (const [email, why] of invalid) {
    test(`rejects ${JSON.stringify(email)} (${why})`, () => assert.equal(isValidEmail(email), false));
  }

  test('rejects an absurdly long address', () => {
    assert.equal(isValidEmail(`${'a'.repeat(250)}@example.com`), false);
  });

  test('rejects non-strings', () => {
    for (const bad of [null, undefined, 42, {}]) assert.equal(isValidEmail(bad), false);
  });
});

describe('phone validation (E.164)', () => {
  test('accepts E.164 numbers', () => {
    assert.equal(isValidPhone('+14155550100'), true);
    assert.equal(isValidPhone('+442071838750'), true);
  });

  test('rejects anything not already normalised', () => {
    for (const bad of ['4155550100', '(415) 555-0100', '+0155550100', '+1415', '', null, '+' + '1'.repeat(16)]) {
      assert.equal(isValidPhone(bad), false, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('validateLead', () => {
  test('a lead with a valid email passes', () => {
    const r = validateLead(base);
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
    assert.equal(r.needsHumanReview, false);
    assert.equal(r.reviewReason, null);
  });

  // Spec scenario 8.
  test('missing phone with a valid email passes', () => {
    assert.equal(validateLead({ source: 'website', email: 'ada@example.com', phone: null }).ok, true);
  });

  test('a valid phone with no email passes', () => {
    assert.equal(validateLead({ source: 'website', email: null, phone: '+14155550100' }).ok, true);
  });

  // Spec scenario 7.
  test('a malformed email with no phone fails and routes to human review', () => {
    const r = validateLead({ source: 'website', email: 'not-an-email', phone: null });
    assert.equal(r.ok, false);
    assert.equal(r.needsHumanReview, true);
    assert.match(r.reviewReason, /^validation_failed:/);
    assert.ok(r.errors.some((e) => e.field === 'email' && e.code === 'INVALID_FORMAT'));
  });

  test('a malformed email is still reported even when a valid phone rescues the lead', () => {
    const r = validateLead({ source: 'website', email: 'bad', phone: '+14155550100' });
    assert.equal(r.ok, false, 'a bad address is a data-quality problem worth surfacing');
    assert.ok(r.errors.some((e) => e.field === 'email'));
  });

  test('no contact method at all fails', () => {
    const r = validateLead({ source: 'website', email: null, phone: null });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === 'NO_CONTACT_METHOD'));
  });

  test('a missing source fails', () => {
    const r = validateLead({ email: 'ada@example.com' });
    assert.ok(r.errors.some((e) => e.field === 'source' && e.code === 'REQUIRED'));
  });

  test('an unknown source fails before it can violate the database CHECK', () => {
    const r = validateLead({ ...base, source: 'carrier-pigeon' });
    assert.ok(r.errors.some((e) => e.field === 'source' && e.code === 'INVALID_ENUM'));
  });

  test('all three known sources are accepted', () => {
    for (const source of ['website', 'meta', 'email']) {
      assert.equal(validateLead({ ...base, source }).ok, true, `${source} should be valid`);
    }
  });

  test('a non-E.164 phone is reported', () => {
    const r = validateLead({ source: 'website', email: 'ada@example.com', phone: '415-555-0100' });
    assert.ok(r.errors.some((e) => e.field === 'phone' && e.code === 'INVALID_FORMAT'));
  });

  test('every error names its field, code and message', () => {
    const r = validateLead({});
    assert.ok(r.errors.length > 0);
    for (const e of r.errors) {
      assert.equal(typeof e.field, 'string');
      assert.equal(typeof e.code, 'string');
      assert.equal(typeof e.message, 'string');
    }
  });

  test('null and undefined leads are handled without throwing', () => {
    assert.equal(validateLead(null).ok, false);
    assert.equal(validateLead(undefined).ok, false);
  });

  test('failure never means discard — it means review', () => {
    const r = validateLead({ source: 'website', email: 'bad', phone: null });
    assert.equal(r.needsHumanReview, true, 'a lead is never lost to a validation failure');
  });
});
