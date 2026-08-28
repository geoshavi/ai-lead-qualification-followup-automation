/**
 * crm-contract-suite.js — one behavioural suite, run against every CRM adapter.
 *
 * This file is NOT a test file. `node --test` matches `*.test.js`, so it is
 * imported by tests/adapter-parity.test.js rather than executed directly.
 *
 * The point of writing it once and running it twice: `mockCrm` is what every
 * developer and every CI run actually exercises, while `supabaseCrm` is what a
 * client would see in the hosted demo. If those two drift, the demo stops
 * matching the tests. This suite is the thing that notices.
 *
 * Nothing here asserts an absolute timestamp. Postgres stamps `created_at` and
 * `updated_at` with its own `now()`, which no test can freeze, so the shared
 * assertions cover format, ordering and monotonicity. The mock's injected clock
 * is exercised separately in tests/adapter-mock.test.js.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { CANONICAL_FIELDS, createLead } from '../../src/core/schema.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/** A minimal valid canonical lead. Overrides land on top of the defaults. */
export function leadFixture(overrides) {
  return createLead({
    source: 'website',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.com',
    message: 'We need a quote.',
    dedupe_key: 'email:ada@example.com',
    ...overrides,
  });
}

/**
 * @param {{name: string, setup: () => Promise<{adapter: object, cleanup?: () => Promise<void>}>}} config
 */
export function runCrmContractSuite(config) {
  const { name, setup } = config;

  describe(`CRM adapter contract — ${name}`, () => {
    let crm;
    let cleanup;

    beforeEach(async () => {
      const started = await setup();
      crm = started.adapter;
      cleanup = started.cleanup;
    });

    afterEach(async () => {
      if (cleanup) await cleanup();
      crm = undefined;
      cleanup = undefined;
    });

    // -----------------------------------------------------------------------
    // Reading an empty store
    // -----------------------------------------------------------------------
    describe('getLeadByDedupeKey', () => {
      test('returns null for a key that was never written', async () => {
        assert.equal(await crm.getLeadByDedupeKey('email:nobody@example.com'), null);
      });

      test('returns null rather than throwing for an empty key', async () => {
        assert.equal(await crm.getLeadByDedupeKey(''), null);
      });
    });

    // -----------------------------------------------------------------------
    // Insert
    // -----------------------------------------------------------------------
    describe('upsertLead — insert', () => {
      test('reports created and returns a uuid lead id', async () => {
        const result = await crm.upsertLead(leadFixture());

        assert.equal(result.created, true);
        assert.equal(result.duplicate, false);
        assert.match(result.leadId, UUID_RE);
      });

      test('returns a row carrying every canonical field plus the three the database generates', async () => {
        const { lead } = await crm.upsertLead(leadFixture());

        for (const field of CANONICAL_FIELDS) {
          assert.ok(field in lead, `expected the returned row to carry ${field}`);
        }
        for (const generated of ['lead_id', 'created_at', 'updated_at']) {
          assert.ok(generated in lead, `expected the database to supply ${generated}`);
        }
      });

      test('applies the same defaults the schema declares', async () => {
        const { lead } = await crm.upsertLead(
          createLead({ source: 'website', email: 'min@example.com', dedupe_key: 'email:min@example.com' }),
        );

        assert.equal(lead.budget_currency, 'USD');
        assert.equal(lead.crm_status, 'NEW');
        assert.equal(lead.followup_status, 'PENDING');
        assert.equal(lead.followup_step, 0);
        assert.equal(lead.booking_status, 'NONE');
        assert.equal(lead.needs_human_review, false);
        assert.deepEqual(lead.raw_payload, {});
        assert.deepEqual(lead.message_history, []);
        assert.equal(lead.next_followup_at, null);
        assert.equal(lead.lead_score, null);
        assert.equal(lead.lead_temperature, null);
      });

      test('the row is readable back by dedupe key', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        const found = await crm.getLeadByDedupeKey('email:ada@example.com');

        assert.equal(found.lead_id, leadId);
        assert.equal(found.email, 'ada@example.com');
      });

      test('drops a key that is not a column instead of writing it', async () => {
        const { lead } = await crm.upsertLead({
          ...leadFixture(),
          lead_id: 'attacker-chosen-id',
          is_admin: true,
          stop_reason: 'sequence_complete',
        });

        assert.notEqual(lead.lead_id, 'attacker-chosen-id');
        assert.ok(!('is_admin' in lead));
        assert.ok(!('stop_reason' in lead));
      });

      test('rejects a lead with no dedupe key', async () => {
        await assert.rejects(
          () => crm.upsertLead(leadFixture({ dedupe_key: null })),
          /dedupe_key/,
        );
      });

      test('rejects a source outside the allowed set', async () => {
        await assert.rejects(
          () => crm.upsertLead(leadFixture({ source: 'carrier-pigeon' })),
          /source/,
        );
      });
    });

    // -----------------------------------------------------------------------
    // Conflict — the guarantee the whole design rests on
    // -----------------------------------------------------------------------
    describe('upsertLead — duplicate dedupe key', () => {
      test('a webhook fired twice produces one row, not two', async () => {
        const first = await crm.upsertLead(leadFixture());
        const second = await crm.upsertLead(leadFixture());

        assert.equal(first.created, true);
        assert.equal(second.created, false);
        assert.equal(second.duplicate, true);
        assert.equal(second.leadId, first.leadId);
      });

      test('two concurrent identical submissions still produce one row', async () => {
        const [a, b] = await Promise.all([
          crm.upsertLead(leadFixture()),
          crm.upsertLead(leadFixture()),
        ]);

        assert.equal(a.leadId, b.leadId);
        assert.equal([a.created, b.created].filter(Boolean).length, 1, 'exactly one call should have inserted');
      });

      test('fills a field that was empty', async () => {
        await crm.upsertLead(leadFixture({ phone: null, company: null }));
        const { lead } = await crm.upsertLead(leadFixture({ phone: '+15551234567', company: 'Analytical Engines' }));

        assert.equal(lead.phone, '+15551234567');
        assert.equal(lead.company, 'Analytical Engines');
      });

      test('never overwrites a field that already had a value', async () => {
        await crm.upsertLead(leadFixture({ company: 'Analytical Engines' }));
        const { lead } = await crm.upsertLead(leadFixture({ company: 'Difference Engines' }));

        assert.equal(lead.company, 'Analytical Engines');
      });

      test('appends a new message to message_history', async () => {
        await crm.upsertLead(leadFixture({ message: 'First enquiry.' }));
        const { lead } = await crm.upsertLead(leadFixture({ message: 'Actually, make it urgent.' }));

        assert.deepEqual(lead.message_history, ['Actually, make it urgent.']);
        assert.equal(lead.message, 'First enquiry.', 'the original message stays put');
      });

      test('does not append when the resubmitted message is identical', async () => {
        await crm.upsertLead(leadFixture({ message: 'Same text.' }));
        const { lead } = await crm.upsertLead(leadFixture({ message: 'Same text.' }));

        assert.deepEqual(lead.message_history, []);
      });

      test('does not re-score the lead or restart the follow-up sequence', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        await crm.updateLead(leadId, {
          lead_score: 88,
          lead_temperature: 'HOT',
          crm_status: 'QUALIFIED',
          followup_status: 'IN_PROGRESS',
          followup_step: 2,
          next_followup_at: '2026-01-05T17:00:00.000Z',
        });

        const { lead } = await crm.upsertLead(leadFixture({ message: 'Following up.' }));

        assert.equal(lead.lead_score, 88);
        assert.equal(lead.lead_temperature, 'HOT');
        assert.equal(lead.crm_status, 'QUALIFIED');
        assert.equal(lead.followup_status, 'IN_PROGRESS');
        assert.equal(lead.followup_step, 2);
        assert.equal(lead.next_followup_at, '2026-01-05T17:00:00.000Z');
      });

      test('flags human review when the same key arrives with a different email', async () => {
        await crm.upsertLead(leadFixture({ dedupe_key: 'website:form-1', email: 'ada@example.com' }));
        const result = await crm.upsertLead(leadFixture({ dedupe_key: 'website:form-1', email: 'grace@example.com' }));

        assert.equal(result.review.needsHumanReview, true);
        assert.match(result.review.reason, /cross_key_conflict/);
        assert.equal(result.lead.needs_human_review, true);
      });
    });

    // -----------------------------------------------------------------------
    // Cross-key conflict on insert (spec 7: same person, different key)
    // -----------------------------------------------------------------------
    describe('upsertLead — cross-key conflict on insert', () => {
      test('a second row sharing an email under a different key is flagged, not merged', async () => {
        const first = await crm.upsertLead(
          leadFixture({ dedupe_key: 'website:form-1', source_id: 'form-1' }),
        );
        const second = await crm.upsertLead(
          leadFixture({ dedupe_key: 'website:form-2', source_id: 'form-2' }),
        );

        assert.equal(second.created, true, 'a different key is a different row');
        assert.notEqual(second.leadId, first.leadId);
        assert.equal(second.review.needsHumanReview, true);
        assert.match(second.review.reason, /same_email_different_dedupe_key/);
        assert.equal(second.lead.needs_human_review, true);
      });

      test('a second row sharing a phone under a different key is flagged', async () => {
        await crm.upsertLead(
          leadFixture({ dedupe_key: 'website:form-1', email: 'ada@example.com', phone: '+15551234567' }),
        );
        const second = await crm.upsertLead(
          leadFixture({ dedupe_key: 'website:form-2', email: 'ada.l@example.com', phone: '+15551234567' }),
        );

        assert.equal(second.review.needsHumanReview, true);
        assert.match(second.review.reason, /same_phone_different_dedupe_key/);
      });

      test('an unrelated lead is not flagged', async () => {
        await crm.upsertLead(leadFixture());
        const second = await crm.upsertLead(
          leadFixture({ dedupe_key: 'email:grace@example.com', email: 'grace@example.com' }),
        );

        assert.equal(second.review.needsHumanReview, false);
        assert.equal(second.lead.needs_human_review, false);
      });
    });

    // -----------------------------------------------------------------------
    // updateLead
    // -----------------------------------------------------------------------
    describe('updateLead', () => {
      test('applies the patch and returns the whole row', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        const updated = await crm.updateLead(leadId, { lead_score: 91, lead_temperature: 'HOT' });

        assert.equal(updated.lead_id, leadId);
        assert.equal(updated.lead_score, 91);
        assert.equal(updated.lead_temperature, 'HOT');
        assert.equal(updated.email, 'ada@example.com', 'untouched fields survive');
      });

      test('drops stop_reason, which is control flow and not a column', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        const updated = await crm.updateLead(leadId, {
          followup_status: 'COMPLETED',
          next_followup_at: null,
          stop_reason: 'sequence_complete',
        });

        assert.ok(!('stop_reason' in updated));
        assert.equal(updated.followup_status, 'COMPLETED');
      });

      test('leaves updated_at at or after created_at', async () => {
        const { leadId, lead } = await crm.upsertLead(leadFixture());
        const updated = await crm.updateLead(leadId, { assigned_to: 'sales@example.com' });

        assert.ok(
          Date.parse(updated.updated_at) >= Date.parse(lead.created_at),
          'updated_at must not move backwards',
        );
      });

      test('throws for an unknown lead id', async () => {
        await assert.rejects(
          () => crm.updateLead('00000000-0000-4000-8000-000000000000', { lead_score: 10 }),
          /not found/i,
        );
      });

      test('rejects a value the schema forbids', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        await assert.rejects(() => crm.updateLead(leadId, { crm_status: 'ARCHIVED' }), /crm_status/);
      });

      test('rejects a score outside 0-100', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        await assert.rejects(() => crm.updateLead(leadId, { lead_score: 140 }), /lead_score/);
      });
    });

    // -----------------------------------------------------------------------
    // Audit log — M2 requires logging on every write
    // -----------------------------------------------------------------------
    describe('audit logging', () => {
      test('an insert records CRM_CREATED against the new lead', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        const events = await crm.listEvents({ leadId });

        const created = events.filter((e) => e.event_type === 'CRM_CREATED');
        assert.equal(created.length, 1);
        assert.equal(created[0].status, 'SUCCESS');
        assert.equal(created[0].lead_id, leadId);
      });

      test('a duplicate records DUPLICATE_FOUND and no second CRM_CREATED', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        await crm.upsertLead(leadFixture({ message: 'Second try.' }));
        const events = await crm.listEvents({ leadId });

        assert.equal(events.filter((e) => e.event_type === 'CRM_CREATED').length, 1);
        assert.equal(events.filter((e) => e.event_type === 'DUPLICATE_FOUND').length, 1);
      });

      test('an update records CRM_UPDATED carrying the fields that changed', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        await crm.updateLead(leadId, { lead_score: 91 });
        const [event] = await crm.listEvents({ leadId, eventType: 'CRM_UPDATED' });

        assert.equal(event.status, 'SUCCESS');
        assert.deepEqual(event.details.fields, ['lead_score']);
      });

      test('a cross-key conflict records HUMAN_REVIEW_FLAGGED', async () => {
        await crm.upsertLead(leadFixture({ dedupe_key: 'website:form-1' }));
        const second = await crm.upsertLead(leadFixture({ dedupe_key: 'website:form-2' }));
        const events = await crm.listEvents({ leadId: second.leadId, eventType: 'HUMAN_REVIEW_FLAGGED' });

        assert.equal(events.length, 1);
        assert.match(events[0].details.reason, /same_email_different_dedupe_key/);
      });

      test('a failed write is audited as a FAILURE', async () => {
        await assert.rejects(() => crm.upsertLead(leadFixture({ source: 'carrier-pigeon' })));
        const events = await crm.listEvents({ eventType: 'WORKFLOW_ERROR' });

        assert.equal(events.length, 1);
        assert.equal(events[0].status, 'FAILURE');
        assert.match(events[0].error_message, /source/);
      });

      test('events come back newest first', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        await crm.updateLead(leadId, { lead_score: 10 });
        await crm.updateLead(leadId, { lead_score: 20 });
        const events = await crm.listEvents({ leadId });

        const times = events.map((e) => Date.parse(e.created_at));
        assert.deepEqual(times, [...times].sort((a, b) => b - a));
        assert.equal(events[0].event_type, 'CRM_UPDATED');
      });
    });

    // -----------------------------------------------------------------------
    // recordEvent
    // -----------------------------------------------------------------------
    describe('recordEvent', () => {
      test('accepts a null lead id, so a pre-lead failure stays auditable', async () => {
        const event = await crm.recordEvent({
          lead_id: null,
          event_type: 'VALIDATION_FAILED',
          status: 'FAILURE',
          details: { field: 'email' },
          error_message: 'invalid email',
        });

        assert.match(event.event_id, UUID_RE);
        assert.equal(event.lead_id, null);
        assert.equal(event.details.field, 'email');
      });

      test('defaults details to an empty object', async () => {
        const event = await crm.recordEvent({ event_type: 'LEAD_RECEIVED', status: 'SUCCESS' });
        assert.deepEqual(event.details, {});
      });

      test('rejects an event type outside the audit enumeration', async () => {
        await assert.rejects(
          () => crm.recordEvent({ event_type: 'SOMETHING_ELSE', status: 'SUCCESS' }),
          /event_type/,
        );
      });

      test('rejects a status outside SUCCESS, FAILURE, SKIPPED', async () => {
        await assert.rejects(
          () => crm.recordEvent({ event_type: 'LEAD_RECEIVED', status: 'OK' }),
          /status/,
        );
      });
    });

    // -----------------------------------------------------------------------
    // listDueFollowups — the scheduler query, spec 6.1
    // -----------------------------------------------------------------------
    describe('listDueFollowups', () => {
      const NOW = '2026-03-10T17:00:00.000Z';

      /** Seed a lead already in flight, then apply the state under test. */
      async function seed(key, patch) {
        const { leadId } = await crm.upsertLead(leadFixture({ dedupe_key: key, email: `${key}@example.com` }));
        await crm.updateLead(leadId, {
          lead_temperature: 'WARM',
          followup_status: 'IN_PROGRESS',
          next_followup_at: '2026-03-10T16:00:00.000Z',
          ...patch,
        });
        return leadId;
      }

      test('returns a lead whose follow-up is due', async () => {
        const leadId = await seed('due');
        const due = await crm.listDueFollowups(NOW);

        assert.deepEqual(due.map((l) => l.lead_id), [leadId]);
      });

      test('accepts a Date as well as an ISO string', async () => {
        await seed('due');
        const due = await crm.listDueFollowups(new Date(NOW));

        assert.equal(due.length, 1);
      });

      test('excludes a follow-up scheduled in the future', async () => {
        await seed('future', { next_followup_at: '2026-03-10T18:00:00.000Z' });
        assert.deepEqual(await crm.listDueFollowups(NOW), []);
      });

      test('includes a follow-up due exactly now', async () => {
        await seed('exact', { next_followup_at: NOW });
        assert.equal((await crm.listDueFollowups(NOW)).length, 1);
      });

      test('excludes a lead with no scheduled follow-up', async () => {
        await seed('none', { next_followup_at: null });
        assert.deepEqual(await crm.listDueFollowups(NOW), []);
      });

      for (const status of ['PENDING', 'STOPPED', 'COMPLETED']) {
        test(`excludes a lead whose follow-up status is ${status}`, async () => {
          await seed(`status-${status}`, { followup_status: status });
          assert.deepEqual(await crm.listDueFollowups(NOW), []);
        });
      }

      test('excludes a lead that has booked', async () => {
        await seed('booked', { booking_status: 'BOOKED' });
        assert.deepEqual(await crm.listDueFollowups(NOW), []);
      });

      for (const status of ['LOST', 'BOOKED']) {
        test(`excludes a lead whose crm status is ${status}`, async () => {
          await seed(`crm-${status}`, { crm_status: status });
          assert.deepEqual(await crm.listDueFollowups(NOW), []);
        });
      }

      test('returns the oldest due follow-up first', async () => {
        const later = await seed('later', { next_followup_at: '2026-03-10T16:30:00.000Z' });
        const earlier = await seed('earlier', { next_followup_at: '2026-03-10T09:00:00.000Z' });
        const middle = await seed('middle', { next_followup_at: '2026-03-10T12:00:00.000Z' });

        assert.deepEqual(
          (await crm.listDueFollowups(NOW)).map((l) => l.lead_id),
          [earlier, middle, later],
        );
      });
    });

    // -----------------------------------------------------------------------
    // claimNotification — the idempotency guard, spec 3.3 / M6
    // -----------------------------------------------------------------------
    describe('claimNotification', () => {
      test('the first claim for a (lead, kind, step) succeeds', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        const result = await crm.claimNotification({ leadId, kind: 'FOLLOWUP', step: 0 });

        assert.equal(result.claimed, true);
        assert.match(result.notification.id, UUID_RE);
        assert.equal(result.notification.lead_id, leadId);
        assert.equal(result.notification.kind, 'FOLLOWUP');
        assert.equal(result.notification.step, 0);
        assert.match(result.notification.sent_at, ISO_UTC_RE);
      });

      test('a second claim for the same (lead, kind, step) is refused, not overwritten', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        const first = await crm.claimNotification({ leadId, kind: 'FOLLOWUP', step: 0 });
        const second = await crm.claimNotification({ leadId, kind: 'FOLLOWUP', step: 0 });

        assert.equal(second.claimed, false);
        // Reads back the ORIGINAL claim, proving nothing was overwritten.
        assert.equal(second.notification.id, first.notification.id);
        assert.equal(second.notification.sent_at, first.notification.sent_at);
      });

      test('the same step is claimable again under a different kind', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        await crm.claimNotification({ leadId, kind: 'FOLLOWUP', step: 0 });
        const other = await crm.claimNotification({ leadId, kind: 'BOOKING_CONFIRM', step: 0 });

        assert.equal(other.claimed, true);
      });

      test('the same kind is claimable again under a different step', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        await crm.claimNotification({ leadId, kind: 'FOLLOWUP', step: 0 });
        const nextStep = await crm.claimNotification({ leadId, kind: 'FOLLOWUP', step: 1 });

        assert.equal(nextStep.claimed, true);
      });

      test('the same (kind, step) is claimable again for a different lead', async () => {
        const a = await crm.upsertLead(leadFixture({ dedupe_key: 'email:a@example.com', email: 'a@example.com' }));
        const b = await crm.upsertLead(leadFixture({ dedupe_key: 'email:b@example.com', email: 'b@example.com' }));

        await crm.claimNotification({ leadId: a.leadId, kind: 'FOLLOWUP', step: 0 });
        const claim = await crm.claimNotification({ leadId: b.leadId, kind: 'FOLLOWUP', step: 0 });

        assert.equal(claim.claimed, true);
      });

      test('rejects a kind outside the notifications enumeration', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        await assert.rejects(
          () => crm.claimNotification({ leadId, kind: 'CARRIER_PIGEON', step: 0 }),
          /kind/,
        );
      });

      test('rejects a negative or non-integer step', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        await assert.rejects(() => crm.claimNotification({ leadId, kind: 'FOLLOWUP', step: -1 }), /step/);
        await assert.rejects(() => crm.claimNotification({ leadId, kind: 'FOLLOWUP', step: 1.5 }), /step/);
      });

      test('does not write a lead_events row of its own — the caller logs FOLLOWUP_SENT separately', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        const before = await crm.listEvents({ leadId });
        await crm.claimNotification({ leadId, kind: 'FOLLOWUP', step: 0 });
        const after = await crm.listEvents({ leadId });

        assert.equal(after.length, before.length);
      });
    });

    // -----------------------------------------------------------------------
    // Row shape — the parity that lets one suite cover two stores
    // -----------------------------------------------------------------------
    describe('row shape', () => {
      test('timestamps are ISO-8601 UTC strings', async () => {
        const { lead } = await crm.upsertLead(leadFixture());

        assert.match(lead.created_at, ISO_UTC_RE);
        assert.match(lead.updated_at, ISO_UTC_RE);
      });

      test('a written timestamp reads back in the same normalised form', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        const updated = await crm.updateLead(leadId, { next_followup_at: '2026-03-10T16:00:00+00:00' });

        assert.equal(updated.next_followup_at, '2026-03-10T16:00:00.000Z');
      });

      test('budget_amount is a number, not a string', async () => {
        const { lead } = await crm.upsertLead(leadFixture({ budget_raw: '$5,000', budget_amount: 5000 }));

        assert.equal(typeof lead.budget_amount, 'number');
        assert.equal(lead.budget_amount, 5000);
      });

      test('budget_amount keeps a fractional value', async () => {
        const { lead } = await crm.upsertLead(leadFixture({ budget_amount: 1234.56 }));
        assert.equal(lead.budget_amount, 1234.56);
      });

      test('needs_human_review is a boolean', async () => {
        const { lead } = await crm.upsertLead(leadFixture());
        assert.equal(typeof lead.needs_human_review, 'boolean');
      });

      test('lead_score and followup_step are numbers', async () => {
        const { leadId } = await crm.upsertLead(leadFixture());
        const updated = await crm.updateLead(leadId, { lead_score: 42, followup_step: 1 });

        assert.equal(typeof updated.lead_score, 'number');
        assert.equal(typeof updated.followup_step, 'number');
      });

      test('jsonb columns come back parsed', async () => {
        const payload = { form: 'contact', fields: { email: 'ada@example.com' }, tags: ['urgent'] };
        const { lead } = await crm.upsertLead(leadFixture({ raw_payload: payload }));

        assert.deepEqual(lead.raw_payload, payload);
      });

      test('the raw payload is stored unmodified', async () => {
        const payload = { weird: { nested: [1, 2, { deep: true }] }, empty: null };
        const { leadId } = await crm.upsertLead(leadFixture({ raw_payload: payload }));
        const found = await crm.getLeadByDedupeKey(leadFixture().dedupe_key);

        assert.equal(found.lead_id, leadId);
        assert.deepEqual(found.raw_payload, payload);
      });
    });
  });
}
