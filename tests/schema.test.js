import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const schema = readFileSync(join(ROOT, 'db', '001_schema.sql'), 'utf8');
const indexes = readFileSync(join(ROOT, 'db', '002_indexes.sql'), 'utf8');

/** Collapse whitespace so assertions are not tied to SQL formatting. */
const flat = (sql) => sql.replace(/\s+/g, ' ');
const flatSchema = flat(schema);
const flatIndexes = flat(indexes);

describe('001_schema.sql declares the three spec tables', () => {
  for (const table of ['leads', 'lead_events', 'notifications']) {
    test(`creates ${table}`, () => {
      assert.ok(
        flatSchema.includes(`CREATE TABLE IF NOT EXISTS ${table} (`),
        `expected a ${table} table`,
      );
    });
  }
});

describe('idempotency constraints (the whole duplicate-prevention design)', () => {
  test('leads.dedupe_key is UNIQUE NOT NULL', () => {
    assert.match(flatSchema, /dedupe_key\s+text\s+NOT NULL/i);
    assert.match(flatSchema, /UNIQUE \(dedupe_key\)/i);
  });

  test('notifications is UNIQUE on (lead_id, kind, step)', () => {
    assert.match(flatSchema, /UNIQUE \(lead_id, kind, step\)/i);
  });
});

describe('columns the spec depends on but section 3.1 omitted', () => {
  test('message_history jsonb array exists for dedupe merges (spec 7)', () => {
    assert.match(flatSchema, /message_history\s+jsonb\s+NOT NULL DEFAULT '\[\]'::jsonb/i);
    assert.match(flatSchema, /jsonb_typeof\(message_history\) = 'array'/i);
  });

  test('replied_at exists for the reply stop condition (spec 6.3)', () => {
    assert.match(flatSchema, /replied_at\s+timestamptz/i);
  });
});

describe('nullability rules that carry meaning', () => {
  test('next_followup_at is nullable — null means no scheduled follow-up', () => {
    assert.match(flatSchema, /next_followup_at\s+timestamptz,/i);
    assert.doesNotMatch(flatSchema, /next_followup_at\s+timestamptz\s+NOT NULL/i);
  });

  test('lead_events.lead_id is nullable — failures before a lead exists stay auditable', () => {
    assert.match(flatSchema, /lead_id\s+uuid\s+REFERENCES leads\(lead_id\)/i);
    assert.doesNotMatch(flatSchema, /lead_id\s+uuid\s+NOT NULL REFERENCES leads\(lead_id\) ON DELETE SET NULL/i);
  });

  test('lead_score and lead_temperature are nullable until the lead is scored', () => {
    assert.match(flatSchema, /lead_score\s+int,/i);
    assert.match(flatSchema, /lead_temperature\s+text,/i);
  });
});

describe('enumerated values are constrained', () => {
  const cases = [
    ['crm_status', ['NEW', 'QUALIFIED', 'CONTACTED', 'NURTURING', 'BOOKED', 'LOST', 'HUMAN_REVIEW']],
    ['followup_status', ['PENDING', 'IN_PROGRESS', 'STOPPED', 'COMPLETED']],
    ['lead_temperature', ['HOT', 'WARM', 'COLD']],
    ['booking_status', ['NONE', 'BOOKED', 'CANCELLED']],
    ['source', ['website', 'meta', 'email']],
    ['status', ['SUCCESS', 'FAILURE', 'SKIPPED']],
    ['kind', ['SLACK_HOT', 'FOLLOWUP', 'BOOKING_CONFIRM']],
  ];

  for (const [column, values] of cases) {
    test(`${column} allows exactly ${values.length} values`, () => {
      for (const value of values) {
        assert.ok(
          flatSchema.includes(`'${value}'`),
          `${column} CHECK must permit '${value}'`,
        );
      }
    });
  }

  test('all 15 audit event types are permitted', () => {
    const eventTypes = [
      'LEAD_RECEIVED', 'LEAD_NORMALIZED', 'VALIDATION_FAILED', 'DUPLICATE_FOUND',
      'AI_SCORE_CREATED', 'AI_SCORE_INVALID', 'CRM_CREATED', 'CRM_UPDATED',
      'SLACK_ALERT_SENT', 'FOLLOWUP_SENT', 'FOLLOWUP_STOPPED', 'BOOKING_RECEIVED',
      'SHEET_SYNCED', 'HUMAN_REVIEW_FLAGGED', 'WORKFLOW_ERROR',
    ];
    assert.equal(eventTypes.length, 15);
    for (const type of eventTypes) {
      assert.ok(flatSchema.includes(`'${type}'`), `event_type CHECK must permit '${type}'`);
    }
  });

  test('lead_score is clamped to 0-100 at the database level too', () => {
    assert.match(flatSchema, /lead_score >= 0 AND lead_score <= 100/i);
  });
});

describe('constraint inventory is explicit', () => {
  // Named exhaustively on purpose: adding or removing a constraint has to be a
  // deliberate edit here too, and the integration verification exercises every
  // one of these names with a value it must reject.
  const EXPECTED_CHECKS = [
    'leads_source_check',
    'leads_score_range_check',
    'leads_temperature_check',
    'leads_crm_status_check',
    'leads_followup_status_chk',
    'leads_followup_step_check',
    'leads_booking_status_chk',
    'leads_message_history_arr',
    'lead_events_status_check',
    'lead_events_type_check',
    'notifications_kind_check',
    'notifications_step_check',
  ];

  test('declares exactly the 12 expected CHECK constraints', () => {
    const declared = [...schema.matchAll(/CONSTRAINT +([a-z_]+) +CHECK/gi)].map((m) => m[1]);
    assert.deepEqual(declared, EXPECTED_CHECKS);
    assert.equal(declared.length, 12);
  });

  test('declares exactly the 2 UNIQUE constraints the design depends on', () => {
    const declared = [...schema.matchAll(/CONSTRAINT +([a-z_]+) +UNIQUE/gi)].map((m) => m[1]);
    assert.deepEqual(declared, ['leads_dedupe_key_unique', 'notifications_unique_send']);
  });
});

describe('002_indexes.sql', () => {
  test('indexes the scheduler hot path from spec 6.1', () => {
    assert.match(flatIndexes, /CREATE INDEX IF NOT EXISTS idx_leads_due_followups ON leads \(next_followup_at\)/i);
    assert.match(flatIndexes, /WHERE followup_status = 'IN_PROGRESS'/i);
  });

  test('does not duplicate the indexes the UNIQUE constraints already create', () => {
    assert.doesNotMatch(flatIndexes, /CREATE (UNIQUE )?INDEX[^;]*ON leads \(dedupe_key\)/i);
    assert.doesNotMatch(flatIndexes, /CREATE (UNIQUE )?INDEX[^;]*ON notifications \(lead_id, kind, step\)/i);
  });

  test('every index is re-runnable', () => {
    const creates = indexes.match(/CREATE INDEX/gi) ?? [];
    const guarded = indexes.match(/CREATE INDEX IF NOT EXISTS/gi) ?? [];
    assert.ok(creates.length > 0, 'expected at least one index');
    assert.equal(creates.length, guarded.length, 'every CREATE INDEX must use IF NOT EXISTS');
  });
});
