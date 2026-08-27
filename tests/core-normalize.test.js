import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWhitespace,
  normalizeEmail,
  normalizeName,
  splitFullName,
  normalizePhone,
  parseBudget,
  toCanonicalFields,
  mapWebsitePayload,
  normalizeLead,
  supportedSources,
} from '../src/core/normalize.js';

describe('whitespace and email normalisation', () => {
  test('collapses internal whitespace and trims', () => {
    assert.equal(normalizeWhitespace('  Ada   Lovelace  '), 'Ada Lovelace');
    assert.equal(normalizeWhitespace('a\n\nb'), 'a b');
  });

  test('returns null for empty or non-string input', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}]) {
      assert.equal(normalizeWhitespace(bad), null);
    }
  });

  test('email is lowercased and trimmed', () => {
    assert.equal(normalizeEmail('  Ada@Example.COM '), 'ada@example.com');
  });

  test('a malformed email still normalises consistently', () => {
    // Validation rejects it later, but the same bad input must always produce
    // the same dedupe key rather than a new row per submission.
    assert.equal(normalizeEmail('NOT-AN-EMAIL'), 'not-an-email');
    assert.equal(normalizeEmail('NOT-AN-EMAIL'), normalizeEmail('  not-an-email  '));
  });

  test('email returns null when unusable', () => {
    for (const bad of ['', '   ', null, undefined, 42]) {
      assert.equal(normalizeEmail(bad), null);
    }
  });
});

describe('name handling', () => {
  test('splits a full name into first and last', () => {
    assert.deepEqual(splitFullName('Ada Lovelace'), { first_name: 'Ada', last_name: 'Lovelace' });
  });

  test('treats everything after the first token as the surname', () => {
    assert.deepEqual(splitFullName('Ana Maria de la Cruz'), {
      first_name: 'Ana',
      last_name: 'Maria de la Cruz',
    });
  });

  test('a single token becomes the first name', () => {
    assert.deepEqual(splitFullName('Ada'), { first_name: 'Ada', last_name: null });
  });

  test('empty input yields two nulls', () => {
    assert.deepEqual(splitFullName('   '), { first_name: null, last_name: null });
    assert.deepEqual(splitFullName(null), { first_name: null, last_name: null });
  });

  test('normalizeName collapses whitespace', () => {
    assert.equal(normalizeName('  Analytical   Engines  '), 'Analytical Engines');
  });
});

describe('phone to E.164', () => {
  test('formats a 10-digit North American number', () => {
    assert.equal(normalizePhone('4155550100'), '+14155550100');
    assert.equal(normalizePhone('(415) 555-0100'), '+14155550100');
    assert.equal(normalizePhone('415.555.0100'), '+14155550100');
    assert.equal(normalizePhone('415 555 0100'), '+14155550100');
  });

  test('formats an 11-digit number that already carries the country code', () => {
    assert.equal(normalizePhone('14155550100'), '+14155550100');
    assert.equal(normalizePhone('1-415-555-0100'), '+14155550100');
  });

  test('every written form of one number converges on the same string', () => {
    const forms = ['4155550100', '(415) 555-0100', '415-555-0100', '+1 415 555 0100', '1 (415) 555-0100'];
    const results = forms.map((f) => normalizePhone(f));
    assert.equal(new Set(results).size, 1, `expected one form, got ${JSON.stringify(results)}`);
    assert.equal(results[0], '+14155550100');
  });

  test('preserves an explicit international number', () => {
    assert.equal(normalizePhone('+44 20 7183 8750'), '+442071838750');
    assert.equal(normalizePhone('0044 20 7183 8750'), '+442071838750');
  });

  test('returns null when E.164 is not derivable rather than guessing', () => {
    // A 7-digit local number has no derivable area code. Inventing one would
    // silently produce a wrong dedupe key.
    for (const bad of ['5550100', '123', '', null, undefined, 'not a phone', '+123']) {
      assert.equal(normalizePhone(bad), null, `should not derive E.164 from ${JSON.stringify(bad)}`);
    }
  });

  test('rejects numbers outside the E.164 length range', () => {
    assert.equal(normalizePhone(`+${'1'.repeat(16)}`), null);
  });

  test('honours a different default country', () => {
    assert.equal(normalizePhone('020 7183 8750', { defaultCountryCode: '44' }), '+442071838750');
  });

  test('a non-default country still refuses to exceed the E.164 length', () => {
    // 15 national digits plus a country code overflows E.164, so there is no
    // valid number to derive.
    assert.equal(normalizePhone('123456789012345', { defaultCountryCode: '44' }), null);
  });
});

describe('budget parsing', () => {
  const cases = [
    ['$5,000', 5000, 'USD'],
    ['5000', 5000, 'USD'],
    ['5k', 5000, 'USD'],
    ['$12k', 12000, 'USD'],
    ['1.5k', 1500, 'USD'],
    ['2m', 2000000, 'USD'],
    ['GBP 2,500', 2500, 'GBP'],
    ['2500 EUR', 2500, 'EUR'],
    ['about $2,500 or so', 2500, 'USD'],
    ['10000 dollars', 10000, 'USD'],
  ];

  for (const [raw, amount, currency] of cases) {
    test(`${JSON.stringify(raw)} -> ${amount} ${currency}`, () => {
      const r = parseBudget(raw);
      assert.equal(r.budget_amount, amount);
      assert.equal(r.budget_currency, currency);
      assert.equal(r.budget_raw, raw.replace(/\s+/g, ' ').trim());
    });
  }

  test('a range resolves to its lower bound', () => {
    // Scoring on the optimistic end of a vague range would inflate lead quality
    // on the customer's least specific input.
    assert.equal(parseBudget('10-15k').budget_amount, 10000);
    assert.equal(parseBudget('$5,000 - $8,000').budget_amount, 5000);
  });

  test('an explicit currency code beats a symbol', () => {
    assert.equal(parseBudget('$2,500 USD').budget_currency, 'USD');
    assert.equal(parseBudget('2500 GBP').budget_currency, 'GBP');
  });

  test('unparseable budgets keep the raw text and a null amount', () => {
    const r = parseBudget('not sure yet');
    assert.equal(r.budget_amount, null);
    assert.equal(r.budget_raw, 'not sure yet');
    assert.equal(r.budget_currency, 'USD');
  });

  test('a missing budget yields nulls and the default currency', () => {
    for (const bad of [null, undefined, '', '   ']) {
      const r = parseBudget(bad);
      assert.equal(r.budget_raw, null);
      assert.equal(r.budget_amount, null);
      assert.equal(r.budget_currency, 'USD');
    }
  });

  test('a numeric budget is accepted', () => {
    assert.equal(parseBudget(5000).budget_amount, 5000);
  });
});

describe('website payload mapping', () => {
  test('maps the canonical field names', () => {
    const mapped = mapWebsitePayload({
      name: 'Ada Lovelace',
      email: 'ADA@example.com',
      phone: '(415) 555-0100',
      company: 'Analytical Engines',
      service: 'Automation',
      budget: '$12,000',
      timeline: 'Next month',
      message: 'We need help.',
    });
    assert.equal(mapped.source, 'website');
    assert.equal(mapped.full_name, 'Ada Lovelace');
    assert.equal(mapped.service_interest, 'Automation');
  });

  test('accepts common field aliases so a renamed form field is not lost', () => {
    const aliases = [
      [{ email_address: 'a@b.com' }, 'email', 'a@b.com'],
      [{ phone_number: '4155550100' }, 'phone', '4155550100'],
      [{ company_name: 'Acme' }, 'company', 'Acme'],
      [{ organisation: 'Acme' }, 'company', 'Acme'],
      [{ firstName: 'Ada' }, 'first_name', 'Ada'],
      [{ comments: 'hello' }, 'message', 'hello'],
      [{ budget_range: '5k' }, 'budget_raw', '5k'],
      [{ timeframe: 'Q3' }, 'timeline', 'Q3'],
      [{ submission_id: 'S1' }, 'source_id', 'S1'],
    ];
    for (const [payload, field, expected] of aliases) {
      assert.equal(mapWebsitePayload(payload)[field], expected, `alias for ${field}`);
    }
  });

  test('an empty payload does not throw', () => {
    const mapped = mapWebsitePayload({});
    assert.equal(mapped.source, 'website');
    assert.equal(mapped.email, null);
  });
});

describe('normalizeLead', () => {
  test('produces canonical fields for a website submission', () => {
    const { fields, rawMessage } = normalizeLead('website', {
      name: '  Ada   Lovelace ',
      email: '  ADA@Example.COM ',
      phone: '(415) 555-0100',
      company: 'Analytical  Engines',
      service: 'Automation',
      budget: '$12,000',
      timeline: 'Next month',
      message: 'We need help with lead routing.',
    });

    assert.deepEqual(fields, {
      source: 'website',
      source_id: null,
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.com',
      phone: '+14155550100',
      company: 'Analytical Engines',
      service_interest: 'Automation',
      timeline: 'Next month',
      budget_raw: '$12,000',
      budget_amount: 12000,
      budget_currency: 'USD',
    });
    assert.equal(rawMessage, 'We need help with lead routing.');
  });

  test('leaves the message unsanitised for sanitize.js to handle', () => {
    const { fields, rawMessage } = normalizeLead('website', { email: 'a@b.com', message: '  raw  text  ' });
    assert.equal(rawMessage, '  raw  text  ');
    assert.equal(fields.message, undefined, 'message must not appear in canonical fields here');
  });

  test('separate first/last fields are preferred over a combined name', () => {
    const { fields } = normalizeLead('website', {
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'a@b.com',
    });
    assert.equal(fields.first_name, 'Ada');
    assert.equal(fields.last_name, 'Lovelace');
  });

  test('an unimplemented source fails loudly rather than half-populating a lead', () => {
    // Meta and inbound email arrive at M5. Until then they must not silently
    // produce an empty lead that looks successful in the audit log.
    assert.throws(() => normalizeLead('meta', {}), /no mapper for source "meta"/);
    assert.throws(() => normalizeLead('email', {}), /no mapper for source "email"/);
    assert.throws(() => normalizeLead('carrier-pigeon', {}), /no mapper/);
  });

  test('reports which sources it supports', () => {
    assert.deepEqual(supportedSources(), ['website']);
  });
});

describe('normalisation is shape-agnostic (spec 5 / M5 groundwork)', () => {
  // The same person, three field vocabularies and three ways of writing the
  // same budget.
  const shapes = [
    { source: 'website', full_name: 'Ada Lovelace', email: 'ADA@example.com', phone: '(415) 555-0100', company: 'Analytical Engines', budget_raw: '$12,000' },
    { source: 'website', first_name: 'Ada', last_name: 'Lovelace', email: '  ada@example.com', phone: '415-555-0100', company: 'Analytical  Engines', budget_raw: '12000' },
    { source: 'website', full_name: '  Ada    Lovelace  ', email: 'Ada@Example.Com', phone: '+1 415 555 0100', company: 'Analytical Engines ', budget_raw: '12k' },
  ];

  test('every derived field converges', () => {
    const derived = shapes.map((s) => {
      // budget_raw is excluded deliberately: spec 3.1 defines it as "as
      // submitted", so preserving the customer's own wording is correct
      // behaviour, not drift. Everything computed FROM it must still agree.
      const { budget_raw, ...rest } = toCanonicalFields(s);
      return JSON.stringify(rest);
    });

    assert.equal(
      new Set(derived).size,
      1,
      `expected identical derived output, got:\n${derived.join('\n')}`,
    );
  });

  test('budget_raw is preserved verbatim while budget_amount converges', () => {
    const parsed = shapes.map((s) => toCanonicalFields(s));

    assert.deepEqual(
      parsed.map((p) => p.budget_raw),
      ['$12,000', '12000', '12k'],
      'the customer wording must survive untouched',
    );

    for (const p of parsed) {
      assert.equal(p.budget_amount, 12000, 'three spellings, one parsed amount');
      assert.equal(p.budget_currency, 'USD');
    }
  });
});
