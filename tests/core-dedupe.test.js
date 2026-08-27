import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEDUPE_STRATEGY,
  fnv1a32,
  dayBucket,
  buildDedupeKey,
  detectCrossKeyConflict,
  mergeDuplicate,
} from '../src/core/dedupe.js';

const NOW = Date.parse('2026-03-02T18:00:00Z');

// The milestone's done-criterion names this explicitly: every dedupe precedence
// rule from spec section 7, including the order in which they win.
describe('dedupe precedence rule 1 — source + source_id', () => {
  test('wins when source_id is present', () => {
    const r = buildDedupeKey(
      { source: 'meta', source_id: 'abc123', email: 'ada@example.com', phone: '+14155550100' },
      { now: NOW },
    );
    assert.equal(r.key, 'meta:abc123');
    assert.equal(r.strategy, DEDUPE_STRATEGY.SOURCE_ID);
    assert.equal(r.needsHumanReview, false);
  });

  test('outranks email and phone even when both exist', () => {
    const withId = buildDedupeKey({ source: 'website', source_id: '7', email: 'a@b.com' }, { now: NOW });
    const withoutId = buildDedupeKey({ source: 'website', email: 'a@b.com' }, { now: NOW });
    assert.equal(withId.key, 'website:7');
    assert.equal(withoutId.key, 'email:a@b.com');
  });

  test('an empty or whitespace source_id falls through to the next rule', () => {
    for (const sourceId of ['', '   ', null, undefined]) {
      const r = buildDedupeKey({ source: 'website', source_id: sourceId, email: 'a@b.com' }, { now: NOW });
      assert.equal(r.strategy, DEDUPE_STRATEGY.EMAIL, `source_id ${JSON.stringify(sourceId)} should not win`);
    }
  });
});

describe('dedupe precedence rule 2 — email', () => {
  test('used when there is no source_id', () => {
    const r = buildDedupeKey({ source: 'website', email: 'ada@example.com', phone: '+14155550100' }, { now: NOW });
    assert.equal(r.key, 'email:ada@example.com');
    assert.equal(r.strategy, DEDUPE_STRATEGY.EMAIL);
    assert.equal(r.needsHumanReview, false);
  });

  test('outranks phone', () => {
    const r = buildDedupeKey({ source: 'website', email: 'a@b.com', phone: '+14155550100' }, { now: NOW });
    assert.equal(r.strategy, DEDUPE_STRATEGY.EMAIL);
  });

  test('is case-insensitive and whitespace-insensitive', () => {
    const a = buildDedupeKey({ source: 'website', email: 'Ada@Example.COM' }, { now: NOW });
    const b = buildDedupeKey({ source: 'website', email: '  ada@example.com  ' }, { now: NOW });
    assert.equal(a.key, b.key);
    assert.equal(a.key, 'email:ada@example.com');
  });
});

describe('dedupe precedence rule 3 — phone', () => {
  test('used when there is no source_id and no email', () => {
    const r = buildDedupeKey({ source: 'website', phone: '+14155550100' }, { now: NOW });
    assert.equal(r.key, 'phone:+14155550100');
    assert.equal(r.strategy, DEDUPE_STRATEGY.PHONE);
    assert.equal(r.needsHumanReview, false);
  });
});

describe('dedupe precedence rule 4 — fallback hash', () => {
  const anonymous = { source: 'website', first_name: 'Ada', last_name: 'Lovelace', company: 'Analytical Eng' };

  test('used only when no identifier at all is available', () => {
    const r = buildDedupeKey(anonymous, { now: NOW });
    assert.equal(r.strategy, DEDUPE_STRATEGY.FALLBACK);
    assert.match(r.key, /^fallback:[0-9a-f]{8}$/);
  });

  test('flags for human review, because the key is a guess', () => {
    const r = buildDedupeKey(anonymous, { now: NOW });
    assert.equal(r.needsHumanReview, true);
    assert.equal(r.reviewReason, 'dedupe_fallback_key');
  });

  test('is stable for the same person on the same day', () => {
    const a = buildDedupeKey(anonymous, { now: NOW });
    const b = buildDedupeKey(anonymous, { now: NOW + 3600000 });
    assert.equal(a.key, b.key, 'same UTC day must produce the same key');
  });

  test('is case-insensitive across name and company', () => {
    const upper = buildDedupeKey(
      { source: 'website', first_name: 'ADA', last_name: 'LOVELACE', company: 'ANALYTICAL ENG' },
      { now: NOW },
    );
    assert.equal(upper.key, buildDedupeKey(anonymous, { now: NOW }).key);
  });

  test('differs on the next day, so a repeat submission is a new lead', () => {
    const today = buildDedupeKey(anonymous, { now: NOW });
    const tomorrow = buildDedupeKey(anonymous, { now: NOW + 86400000 });
    assert.notEqual(today.key, tomorrow.key);
  });

  test('differs for different people', () => {
    const other = buildDedupeKey({ ...anonymous, last_name: 'Byron' }, { now: NOW });
    assert.notEqual(other.key, buildDedupeKey(anonymous, { now: NOW }).key);
  });

  test('requires an explicit clock rather than reading Date.now()', () => {
    assert.throws(() => buildDedupeKey(anonymous, {}), /options.now is required/);
    assert.throws(() => buildDedupeKey(anonymous, { now: null }), /options.now is required/);
  });
});

describe('the four strategies are mutually exclusive and ordered', () => {
  test('removing identifiers walks the precedence list downwards', () => {
    const full = { source: 'website', source_id: 'X1', email: 'a@b.com', phone: '+14155550100', first_name: 'Ada' };
    assert.equal(buildDedupeKey(full, { now: NOW }).strategy, DEDUPE_STRATEGY.SOURCE_ID);
    assert.equal(buildDedupeKey({ ...full, source_id: null }, { now: NOW }).strategy, DEDUPE_STRATEGY.EMAIL);
    assert.equal(buildDedupeKey({ ...full, source_id: null, email: null }, { now: NOW }).strategy, DEDUPE_STRATEGY.PHONE);
    assert.equal(
      buildDedupeKey({ ...full, source_id: null, email: null, phone: null }, { now: NOW }).strategy,
      DEDUPE_STRATEGY.FALLBACK,
    );
  });

  test('only the fallback strategy flags for review', () => {
    const full = { source: 'website', source_id: 'X1', email: 'a@b.com', phone: '+14155550100' };
    assert.equal(buildDedupeKey(full, { now: NOW }).needsHumanReview, false);
    assert.equal(buildDedupeKey({ ...full, source_id: null }, { now: NOW }).needsHumanReview, false);
    assert.equal(buildDedupeKey({ source: 'website', phone: '+1415' + '5550100' }, { now: NOW }).needsHumanReview, false);
    assert.equal(buildDedupeKey({ source: 'website', first_name: 'A' }, { now: NOW }).needsHumanReview, true);
  });
});

describe('fnv1a32', () => {
  test('is deterministic', () => {
    assert.equal(fnv1a32('hello'), fnv1a32('hello'));
  });

  test('always returns 8 lowercase hex characters', () => {
    for (const input of ['', 'a', 'hello world', 'x'.repeat(500), 'ünïcødé']) {
      assert.match(fnv1a32(input), /^[0-9a-f]{8}$/, `bad digest for ${JSON.stringify(input.slice(0, 12))}`);
    }
  });

  test('distinguishes similar inputs', () => {
    assert.notEqual(fnv1a32('ada|lovelace'), fnv1a32('ada|lovelacf'));
    assert.notEqual(fnv1a32('a|b'), fnv1a32('b|a'));
  });

  test('matches the known FNV-1a digest for "hello"', () => {
    // Reference value for 32-bit FNV-1a.
    assert.equal(fnv1a32('hello'), '4f9f2cab');
  });
});

describe('dayBucket', () => {
  test('is a UTC calendar date', () => {
    assert.equal(dayBucket(Date.parse('2026-03-02T23:59:59Z')), '2026-03-02');
    assert.equal(dayBucket(Date.parse('2026-03-03T00:00:00Z')), '2026-03-03');
  });

  test('accepts a Date or epoch milliseconds', () => {
    assert.equal(dayBucket(new Date(NOW)), dayBucket(NOW));
  });

  test('rejects nonsense rather than producing "Invalid Date"', () => {
    assert.throws(() => dayBucket('not a date'), /must be a Date or epoch milliseconds/);
    assert.throws(() => dayBucket(undefined), /must be a Date or epoch milliseconds/);
  });
});

describe('cross-key conflicts go to a human (spec 7)', () => {
  test('same email arriving under a different dedupe key is flagged', () => {
    const r = detectCrossKeyConflict(
      { dedupe_key: 'meta:999', email: 'ada@example.com' },
      { dedupe_key: 'website:1', email: 'ada@example.com' },
    );
    assert.equal(r.conflict, true);
    assert.ok(r.reasons.includes('same_email_different_dedupe_key'));
    assert.match(r.reviewReason, /^cross_key_conflict:/);
  });

  test('same phone arriving under a different dedupe key is flagged', () => {
    const r = detectCrossKeyConflict(
      { dedupe_key: 'meta:999', phone: '+14155550100' },
      { dedupe_key: 'website:1', phone: '+14155550100' },
    );
    assert.equal(r.conflict, true);
    assert.ok(r.reasons.includes('same_phone_different_dedupe_key'));
  });

  test('the same key with a different email is flagged', () => {
    const r = detectCrossKeyConflict(
      { dedupe_key: 'website:1', email: 'new@example.com' },
      { dedupe_key: 'website:1', email: 'old@example.com' },
    );
    assert.equal(r.conflict, true);
    assert.ok(r.reasons.includes('same_dedupe_key_different_email'));
  });

  test('the same key with a different phone is flagged', () => {
    const r = detectCrossKeyConflict(
      { dedupe_key: 'website:1', phone: '+14155550100' },
      { dedupe_key: 'website:1', phone: '+14155550199' },
    );
    assert.equal(r.conflict, true);
    assert.ok(r.reasons.includes('same_dedupe_key_different_phone'));
  });

  test('a genuine duplicate is not a conflict', () => {
    const r = detectCrossKeyConflict(
      { dedupe_key: 'email:ada@example.com', email: 'ada@example.com' },
      { dedupe_key: 'email:ada@example.com', email: 'ada@example.com' },
    );
    assert.equal(r.conflict, false);
    assert.equal(r.reviewReason, null);
  });

  test('missing fields do not manufacture a conflict', () => {
    assert.equal(detectCrossKeyConflict({}, {}).conflict, false);
    assert.equal(detectCrossKeyConflict(null, null).conflict, false);
  });
});

describe('merging a duplicate (spec 7)', () => {
  const existing = {
    first_name: 'Ada',
    last_name: null,
    email: 'ada@example.com',
    company: null,
    message: 'First enquiry',
    message_history: [],
  };

  test('fills empty fields from the newcomer', () => {
    const { patch } = mergeDuplicate(existing, { last_name: 'Lovelace', company: 'Analytical Eng' });
    assert.equal(patch.last_name, 'Lovelace');
    assert.equal(patch.company, 'Analytical Eng');
  });

  test('never overwrites an existing non-empty value', () => {
    const { patch } = mergeDuplicate(existing, { first_name: 'Augusta', email: 'other@example.com' });
    assert.equal(patch.first_name, undefined);
    assert.equal(patch.email, undefined);
  });

  test('appends the new message to message_history', () => {
    const { patch, appendedMessage } = mergeDuplicate(existing, { message: 'Second enquiry' });
    assert.equal(appendedMessage, true);
    assert.deepEqual(patch.message_history, ['Second enquiry']);
  });

  test('does not append an identical repeated message', () => {
    const { appendedMessage } = mergeDuplicate(existing, { message: 'First enquiry' });
    assert.equal(appendedMessage, false);
  });

  test('grows an existing history rather than replacing it', () => {
    const withHistory = { ...existing, message_history: ['Second enquiry'] };
    const { patch } = mergeDuplicate(withHistory, { message: 'Third enquiry' });
    assert.deepEqual(patch.message_history, ['Second enquiry', 'Third enquiry']);
  });

  test('never restarts the sequence or re-triggers the alert', () => {
    const { patch } = mergeDuplicate(
      { ...existing, followup_step: 2, followup_status: 'IN_PROGRESS', lead_temperature: 'HOT' },
      { message: 'Second enquiry', followup_step: 0, followup_status: 'PENDING', lead_temperature: 'HOT' },
    );
    for (const field of ['followup_step', 'followup_status', 'lead_temperature', 'next_followup_at', 'crm_status']) {
      assert.equal(patch[field], undefined, `${field} must never be merged from a duplicate`);
    }
  });
});
