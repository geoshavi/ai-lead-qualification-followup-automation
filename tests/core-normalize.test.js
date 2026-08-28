import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeWhitespace,
  normalizeEmail,
  normalizeName,
  splitFullName,
  normalizePhone,
  parseBudget,
  toCanonicalFields,
  mapWebsitePayload,
  mapMetaPayload,
  parseFromHeader,
  extractEmailBodyFields,
  mapEmailPayload,
  normalizeLead,
  supportedSources,
} from '../src/core/normalize.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'sources');
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

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

  test('an unsupported source still fails loudly rather than half-populating a lead', () => {
    // meta and email shipped at M5 (spec 9). A source outside the three the
    // schema's CHECK constraint allows must still refuse rather than silently
    // producing an empty lead that looks successful in the audit log.
    assert.throws(() => normalizeLead('carrier-pigeon', {}), /no mapper/);
  });

  test('reports which sources it supports', () => {
    assert.deepEqual(supportedSources(), ['website', 'meta', 'email']);
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

describe('meta lead ads payload mapping (spec 9, M5)', () => {
  test('maps field_data entries by name into canonical concepts', () => {
    const mapped = mapMetaPayload({
      id: 'LG-1',
      field_data: [
        { name: 'full_name', values: ['Ada Lovelace'] },
        { name: 'email', values: ['ada@example.com'] },
        { name: 'phone_number', values: ['+14155550100'] },
        { name: 'company_name', values: ['Analytical Engines'] },
        { name: 'estimated_budget', values: ['$12,000'] },
      ],
    });
    assert.equal(mapped.source, 'meta');
    assert.equal(mapped.source_id, 'LG-1');
    assert.equal(mapped.full_name, 'Ada Lovelace');
    assert.equal(mapped.email, 'ada@example.com');
    assert.equal(mapped.phone, '+14155550100');
    assert.equal(mapped.company, 'Analytical Engines');
    assert.equal(mapped.budget_raw, '$12,000');
  });

  test('accepts separate first_name/last_name fields instead of a combined name', () => {
    const mapped = mapMetaPayload({
      field_data: [
        { name: 'first_name', values: ['Ada'] },
        { name: 'last_name', values: ['Lovelace'] },
      ],
    });
    assert.equal(mapped.full_name, null);
    assert.equal(mapped.first_name, 'Ada');
    assert.equal(mapped.last_name, 'Lovelace');
  });

  test('accepts field-name aliases, since advertisers name custom questions freely', () => {
    const aliases = [
      [{ name: 'what_service_are_you_interested_in', values: ['Automation'] }, 'service_interest', 'Automation'],
      [{ name: 'when_are_you_looking_to_start', values: ['Q3'] }, 'timeline', 'Q3'],
      [{ name: 'additional_details', values: ['hello'] }, 'message', 'hello'],
    ];
    for (const [entry, field, expected] of aliases) {
      const mapped = mapMetaPayload({ field_data: [entry] });
      assert.equal(mapped[field], expected, `alias for ${field}`);
    }
  });

  test('field names are matched case-insensitively', () => {
    const mapped = mapMetaPayload({ field_data: [{ name: 'EMAIL', values: ['a@b.com'] }] });
    assert.equal(mapped.email, 'a@b.com');
  });

  test('an empty payload does not throw', () => {
    const mapped = mapMetaPayload({});
    assert.equal(mapped.source, 'meta');
    assert.equal(mapped.email, null);
  });

  test('a payload with no field_data array does not throw', () => {
    const mapped = mapMetaPayload({ id: 'LG-2' });
    assert.equal(mapped.source_id, 'LG-2');
    assert.equal(mapped.email, null);
  });
});

describe('inbound email parsing (spec 9, M5)', () => {
  describe('parseFromHeader', () => {
    test('extracts a display name and address from "Name <email>"', () => {
      assert.deepEqual(parseFromHeader('Ada Lovelace <ada@example.com>'), {
        full_name: 'Ada Lovelace',
        email: 'ada@example.com',
      });
    });

    test('handles a quoted display name', () => {
      assert.deepEqual(parseFromHeader('"Lovelace, Ada" <ada@example.com>'), {
        full_name: 'Lovelace, Ada',
        email: 'ada@example.com',
      });
    });

    test('falls back to a bare address with no display name', () => {
      assert.deepEqual(parseFromHeader('ada@example.com'), { full_name: null, email: 'ada@example.com' });
    });

    test('non-string or empty input yields two nulls', () => {
      assert.deepEqual(parseFromHeader(null), { full_name: null, email: null });
      assert.deepEqual(parseFromHeader(''), { full_name: null, email: null });
    });
  });

  describe('extractEmailBodyFields', () => {
    test('pulls recognised "Label: value" lines out of the body', () => {
      const body = 'Phone: 415-555-0100\nCompany: Analytical Engines\nBudget: $12k\nTimeline: Next month';
      const fields = extractEmailBodyFields(body);
      assert.equal(fields.phone, '415-555-0100');
      assert.equal(fields.company, 'Analytical Engines');
      assert.equal(fields.budget_raw, '$12k');
      assert.equal(fields.timeline, 'Next month');
    });

    test('everything not a recognised label survives as the message', () => {
      const body = 'Hi,\n\nWe need help automating lead routing.\n\nThanks,\nAda';
      const fields = extractEmailBodyFields(body);
      assert.equal(fields.message, 'Hi, We need help automating lead routing. Thanks, Ada');
    });

    test('label matching is case-insensitive and alias-aware', () => {
      assert.equal(extractEmailBodyFields('PHONE: 415-555-0100').phone, '415-555-0100');
      assert.equal(extractEmailBodyFields('Organisation: Acme').company, 'Acme');
      assert.equal(extractEmailBodyFields('Interested in: Automation').service_interest, 'Automation');
    });

    test('non-string or empty input does not throw', () => {
      assert.deepEqual(extractEmailBodyFields(null), { message: null });
      assert.deepEqual(extractEmailBodyFields(''), { message: null });
    });
  });

  describe('mapEmailPayload', () => {
    test('maps the from header and recognised body labels', () => {
      const mapped = mapEmailPayload({
        message_id: 'MSG-1',
        from: 'Ada Lovelace <ada@example.com>',
        text: 'Company: Analytical Engines\n\nWe need help automating lead routing.',
      });
      assert.equal(mapped.source, 'email');
      assert.equal(mapped.source_id, 'MSG-1');
      assert.equal(mapped.full_name, 'Ada Lovelace');
      assert.equal(mapped.email, 'ada@example.com');
      assert.equal(mapped.company, 'Analytical Engines');
      assert.equal(mapped.message, 'We need help automating lead routing.');
    });

    test('accepts common inbound-parse field aliases for the body', () => {
      assert.equal(mapEmailPayload({ body: 'hello' }).message, 'hello');
      assert.equal(mapEmailPayload({ 'body-plain': 'hello' }).message, 'hello');
      assert.equal(mapEmailPayload({ sender: 'a@b.com' }).email, 'a@b.com');
    });

    test('an empty payload does not throw', () => {
      const mapped = mapEmailPayload({});
      assert.equal(mapped.source, 'email');
      assert.equal(mapped.email, null);
      assert.equal(mapped.message, null);
    });
  });
});

describe('normalizeLead accepts meta and email now that M5 has shipped', () => {
  test('produces canonical fields for a meta lead ads submission', () => {
    const { fields, rawMessage } = normalizeLead('meta', {
      id: 'LG-9',
      field_data: [
        { name: 'full_name', values: ['Ada Lovelace'] },
        { name: 'email', values: ['ADA@Example.com'] },
        { name: 'phone_number', values: ['(415) 555-0100'] },
        { name: 'company_name', values: ['Analytical Engines'] },
        { name: 'what_service_are_you_interested_in', values: ['Automation'] },
        { name: 'estimated_budget', values: ['$12,000'] },
        { name: 'when_are_you_looking_to_start', values: ['Next month'] },
        { name: 'additional_details', values: ['We need help.'] },
      ],
    });

    assert.deepEqual(fields, {
      source: 'meta',
      source_id: 'LG-9',
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
    assert.equal(rawMessage, 'We need help.');
  });

  test('produces canonical fields for an inbound email submission', () => {
    const { fields, rawMessage } = normalizeLead('email', {
      message_id: 'MSG-9',
      from: 'Ada Lovelace <ADA@Example.com>',
      text: 'Phone: (415) 555-0100\nCompany: Analytical Engines\nService: Automation\nBudget: $12,000\nTimeline: Next month\n\nWe need help.',
    });

    assert.deepEqual(fields, {
      source: 'email',
      source_id: 'MSG-9',
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
    assert.equal(rawMessage, 'We need help.');
  });
});

describe('M5 acceptance test, verbatim (spec 9): three payload shapes, one person', () => {
  // "three different payload shapes produce byte-identical canonical output
  // for the same underlying person." website/meta/email deliberately use
  // different field vocabularies, different phone/budget spellings, and
  // (website+email vs. meta) a combined name vs. separate first/last fields —
  // the same coverage the M1 groundwork test gave a single source shape,
  // now proven across all three real source mappers via the fixtures spec 9
  // asks for ("fixtures for each").
  const results = {
    website: normalizeLead('website', fixture('website')),
    meta: normalizeLead('meta', fixture('meta')),
    email: normalizeLead('email', fixture('email')),
  };

  test('source and source_id are preserved per-channel, not merged away', () => {
    assert.equal(results.website.fields.source, 'website');
    assert.equal(results.meta.fields.source, 'meta');
    assert.equal(results.email.fields.source, 'email');
    // Each channel's own identifier — these are legitimately different per
    // source and are exactly what lets dedupe.js fall through to email-based
    // matching (spec 7 precedence) to recognise this as one returning person.
    assert.equal(results.website.fields.source_id, 'WEB-2201');
    assert.equal(results.meta.fields.source_id, '120211999888777');
    assert.equal(results.email.fields.source_id, '<CAF=abc123@mail.example.com>');
  });

  test('every other canonical field is byte-identical across all three shapes', () => {
    // budget_raw is excluded for the same reason the M1 groundwork test
    // excludes it: spec 3.1 defines it as "as submitted", so three different
    // spellings of the same figure is correct behaviour, not drift.
    const comparable = Object.entries(results).map(([sourceName, { fields }]) => {
      const { source, source_id, budget_raw, ...rest } = fields;
      return [sourceName, JSON.stringify(rest)];
    });

    const distinct = new Set(comparable.map(([, json]) => json));
    assert.equal(
      distinct.size,
      1,
      `expected byte-identical canonical output, got:\n${comparable.map(([n, j]) => `${n}: ${j}`).join('\n')}`,
    );

    assert.deepEqual(comparable[0][1] && JSON.parse(comparable[0][1]), {
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.com',
      phone: '+14155550100',
      company: 'Analytical Engines',
      service_interest: 'Workflow automation',
      timeline: 'Next month',
      budget_amount: 12000,
      budget_currency: 'USD',
    });
  });

  test('budget wording differs per channel while the parsed amount converges', () => {
    assert.deepEqual(
      {
        website: results.website.fields.budget_raw,
        meta: results.meta.fields.budget_raw,
        email: results.email.fields.budget_raw,
      },
      { website: '$12,000', meta: '12000', email: '$12k' },
      'three spellings of the same figure must survive untouched',
    );

    for (const { fields } of Object.values(results)) {
      assert.equal(fields.budget_amount, 12000);
      assert.equal(fields.budget_currency, 'USD');
    }
  });
});
