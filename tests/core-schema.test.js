import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SOURCES,
  CRM_STATUS,
  FOLLOWUP_STATUS,
  TEMPERATURE,
  BOOKING_STATUS,
  EVENT_TYPE,
  EVENT_STATUS,
  NOTIFICATION_KIND,
  CANONICAL_FIELDS,
  leadDefaults,
  isPlainObject,
  pickCanonical,
  createLead,
} from '../src/core/schema.js';

const ROOT = join(import.meta.dirname, '..');
const sql = readFileSync(join(ROOT, 'db', '001_schema.sql'), 'utf8');

describe('enums match the database CHECK constraints exactly', () => {
  // Drift between these constants and the SQL is a runtime INSERT failure, so
  // each set is checked against the migration rather than against a copy.
  const enumCases = [
    ['source', SOURCES],
    ['crm_status', Object.values(CRM_STATUS)],
    ['followup_status', Object.values(FOLLOWUP_STATUS)],
    ['lead_temperature', Object.values(TEMPERATURE)],
    ['booking_status', Object.values(BOOKING_STATUS)],
    ['event_type', Object.values(EVENT_TYPE)],
    ['event status', Object.values(EVENT_STATUS)],
    ['notification kind', Object.values(NOTIFICATION_KIND)],
  ];

  for (const [label, values] of enumCases) {
    test(`every ${label} value appears in 001_schema.sql`, () => {
      for (const value of values) {
        assert.ok(sql.includes(`'${value}'`), `${label} value '${value}' is missing from the schema`);
      }
    });
  }

  test('the enums have the sizes the spec states', () => {
    assert.equal(SOURCES.length, 3);
    assert.equal(Object.keys(CRM_STATUS).length, 7);
    assert.equal(Object.keys(FOLLOWUP_STATUS).length, 4);
    assert.equal(Object.keys(TEMPERATURE).length, 3);
    assert.equal(Object.keys(BOOKING_STATUS).length, 3);
    assert.equal(Object.keys(EVENT_TYPE).length, 15);
    assert.equal(Object.keys(EVENT_STATUS).length, 3);
    assert.equal(Object.keys(NOTIFICATION_KIND).length, 3);
  });

  test('the enum objects are frozen', () => {
    assert.throws(() => { CRM_STATUS.INVENTED = 'X'; }, TypeError);
  });
});

describe('canonical field list', () => {
  test('holds the 30 fields code is allowed to write', () => {
    // 33 database columns minus lead_id, created_at and updated_at, which the
    // database generates and code must never set.
    assert.equal(CANONICAL_FIELDS.length, 30);
  });

  test('every canonical field is a real column in 001_schema.sql', () => {
    for (const field of CANONICAL_FIELDS) {
      assert.match(sql, new RegExp(`^\\s+${field}\\s`, 'm'), `${field} is not a column`);
    }
  });

  test('excludes the database-generated columns', () => {
    for (const generated of ['lead_id', 'created_at', 'updated_at']) {
      assert.ok(!CANONICAL_FIELDS.includes(generated), `${generated} must not be writable by code`);
    }
  });

  test('has no duplicates', () => {
    assert.equal(new Set(CANONICAL_FIELDS).size, CANONICAL_FIELDS.length);
  });
});

describe('defaults mirror the database DEFAULT clauses', () => {
  const defaults = leadDefaults();

  test('match the values 001_schema.sql declares', () => {
    assert.equal(defaults.crm_status, 'NEW');
    assert.equal(defaults.followup_status, 'PENDING');
    assert.equal(defaults.booking_status, 'NONE');
    assert.equal(defaults.budget_currency, 'USD');
    assert.equal(defaults.followup_step, 0);
    assert.equal(defaults.needs_human_review, false);
    assert.deepEqual(defaults.raw_payload, {});
    assert.deepEqual(defaults.message_history, []);
  });

  test('nullable-with-meaning fields start null', () => {
    assert.equal(defaults.next_followup_at, null, 'null means no scheduled follow-up');
    assert.equal(defaults.replied_at, null);
    assert.equal(defaults.lead_score, null);
    assert.equal(defaults.lead_temperature, null);
  });

  test('cover exactly the canonical fields', () => {
    assert.deepEqual(Object.keys(defaults).sort(), [...CANONICAL_FIELDS].sort());
  });

  test('return a fresh object each call, so leads cannot share state', () => {
    const a = leadDefaults();
    const b = leadDefaults();
    a.message_history.push('mutated');
    assert.deepEqual(b.message_history, [], 'defaults must not be shared by reference');
  });
});

describe('pickCanonical is an allowlist', () => {
  test('drops unknown keys', () => {
    // Inbound payloads are attacker-influenced; an unknown key must never reach
    // an INSERT statement.
    const picked = pickCanonical({ email: 'a@b.com', lead_id: 'forged', is_admin: true, '; DROP TABLE': 1 });
    assert.deepEqual(picked, { email: 'a@b.com' });
  });

  test('keeps every canonical key that is present', () => {
    const picked = pickCanonical({ source: 'website', email: 'a@b.com', followup_step: 2 });
    assert.deepEqual(picked, { source: 'website', email: 'a@b.com', followup_step: 2 });
  });

  test('preserves explicit nulls', () => {
    assert.deepEqual(pickCanonical({ email: null }), { email: null });
  });

  test('returns an empty object for non-objects', () => {
    for (const bad of [null, undefined, 42, 'text', []]) {
      assert.deepEqual(pickCanonical(bad), {});
    }
  });
});

describe('createLead', () => {
  test('applies defaults then allowlisted overrides', () => {
    const lead = createLead({ source: 'website', email: 'a@b.com', is_admin: true });
    assert.equal(lead.source, 'website');
    assert.equal(lead.email, 'a@b.com');
    assert.equal(lead.crm_status, 'NEW');
    assert.equal(lead.is_admin, undefined, 'an unknown key must not survive');
  });

  test('produces every canonical field, so an INSERT never has a hole', () => {
    assert.deepEqual(Object.keys(createLead({})).sort(), [...CANONICAL_FIELDS].sort());
  });

  test('handles no argument at all', () => {
    assert.equal(createLead().crm_status, 'NEW');
  });
});

describe('isPlainObject', () => {
  test('accepts plain objects only', () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject({ a: 1 }), true);
  });

  test('rejects arrays, null and primitives', () => {
    for (const bad of [null, undefined, [], 42, 'text', true]) {
      assert.equal(isPlainObject(bad), false);
    }
  });
});
