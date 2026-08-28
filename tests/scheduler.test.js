/**
 * scheduler.test.js — the M6 "done when", proven end to end.
 *
 * PROJECT_SPEC.md section 9: "a seeded lead with a past `next_followup_at`
 * advances exactly one step per run and stops correctly at every stop
 * condition."
 *
 * There is no n8n canvas to run this against yet — section 9 assigns M6 no
 * canvas/curl deliverable the way M4 got one; "cron workflow" here means
 * `docs/scheduler.md`, which a human still has to build by hand (spec
 * section 0). So this file is the literal, automatable half of "done when":
 * it runs one scheduler TICK — due-query, stop check, idempotency claim,
 * message log, step advance — against `mockCrm`, using only already-shipped
 * pieces (`followup.js` from M1, `listDueFollowups`/`claimNotification` from
 * M2/M6) wired together exactly as `docs/scheduler.md` documents wiring them
 * in n8n Code/Postgres nodes. Nothing here is a new product module — see
 * that file's own note on why a reusable orchestration module would be
 * architecturally wrong (spec section 1: the canvas is the product).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMockCrm } from '../src/adapters/mockCrm.js';
import { leadFixture } from './helpers/crm-contract-suite.js';
import { evaluateStopConditions, advanceFollowup, totalSteps } from '../src/core/followup.js';
import { buildFollowupPrompt } from '../src/core/followupPrompt.js';
import { prepareUntrustedText } from '../src/core/sanitize.js';

const TZ = 'America/Los_Angeles';
// Verified against Intl in tests/core-followup.test.js: Mon 2026-03-02, 10:00 PST.
const MON_10AM = Date.parse('2026-03-02T18:00:00Z');
// One second later, so a follow-up "due at MON_10AM" reads as already-due.
const NOW = MON_10AM + 1000;

/**
 * One scheduler tick for one already-due lead — exactly what
 * docs/scheduler.md's Code nodes do, in the order they do it. Not a product
 * module (see file docstring); this is test-only glue proving the documented
 * sequence behaves the way the guide says it does.
 */
async function tick(crm, lead, { now, timeZone }) {
  const stop = evaluateStopConditions(lead);
  if (stop.stop) {
    await crm.updateLead(lead.lead_id, { followup_status: stop.followup_status, next_followup_at: null });
    await crm.recordEvent({
      lead_id: lead.lead_id,
      event_type: 'FOLLOWUP_STOPPED',
      status: 'SUCCESS',
      details: { reason: stop.reason },
    });
    return { sent: false, stopped: true, reason: stop.reason };
  }

  const claim = await crm.claimNotification({ leadId: lead.lead_id, kind: 'FOLLOWUP', step: lead.followup_step });
  if (!claim.claimed) {
    return { sent: false, stopped: false, alreadyClaimed: true };
  }

  // The prompt is real (proves buildFollowupPrompt composes with a live lead
  // row); the "call an LLM" half is the n8n canvas's HTTP Request node
  // (spec 1: Code nodes cannot make network calls that belong to the
  // canvas), so here it is stood in for by a fixed string — this test suite
  // stays network-free like every other one in the project.
  //
  // lead.message is stored RAW (M4 never persists the sanitized form — see
  // docs/workflow.md step 2.10), so spec 4.2 applies here exactly as it does
  // at scoring time: sanitize fresh, at the point the text reaches a prompt.
  const sanitized = prepareUntrustedText(lead.message);
  const total = totalSteps(lead.lead_temperature);
  const prompt = buildFollowupPrompt({ lead: { ...lead, message: sanitized.value }, step: lead.followup_step, totalSteps: total });
  const message = `[stub message for step ${lead.followup_step}]`;

  await crm.recordEvent({
    lead_id: lead.lead_id,
    event_type: 'FOLLOWUP_SENT',
    status: 'SUCCESS',
    details: { step: lead.followup_step, message },
  });

  // Anchored to when the lead was created — not to `now` — because
  // followup.js measures every step from ONE fixed point (spec 6.2's own
  // reasoning: an anchored schedule catches up after a scheduler outage; a
  // schedule re-anchored to "now" on every tick would silently stretch every
  // later step by however late this one ran). `created_at` is the same
  // instant startFollowup used for step 0 (M4's canvas scores a lead
  // synchronously right after intake), and reusing it needs no new column.
  const patch = advanceFollowup(lead, { now, timeZone, anchor: Date.parse(lead.created_at) });
  const updated = await crm.updateLead(lead.lead_id, patch);

  if (patch.stop_reason) {
    await crm.recordEvent({
      lead_id: lead.lead_id,
      event_type: 'FOLLOWUP_STOPPED',
      status: 'SUCCESS',
      details: { reason: patch.stop_reason },
    });
  }

  return { sent: true, stopped: Boolean(patch.stop_reason), lead: updated, prompt };
}

let dir;
let crm;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lead-engine-scheduler-'));
  // Frozen so a seeded lead's created_at — the anchor tick() reuses — is the
  // same known instant (MON_10AM) every run, not whatever wall-clock time the
  // test happened to execute at.
  crm = createMockCrm({ file: join(dir, 'mock-crm.json'), now: () => new Date(MON_10AM) });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Seed a lead already mid-sequence, past due. Mirrors listDueFollowups's own seed() helper. */
async function seedDue(overrides = {}) {
  const email = `lead-${Math.random().toString(36).slice(2)}@example.com`;
  const { leadId } = await crm.upsertLead(leadFixture({ dedupe_key: `email:${email}`, email }));
  await crm.updateLead(leadId, {
    lead_temperature: 'HOT',
    crm_status: 'CONTACTED',
    followup_status: 'IN_PROGRESS',
    followup_step: 0,
    next_followup_at: new Date(MON_10AM).toISOString(),
    booking_status: 'NONE',
    ...overrides,
  });
  return crm.getLeadByDedupeKey(`email:${email}`);
}

describe('M6 acceptance, verbatim (spec 9): a seeded lead advances exactly one step per run', () => {
  test('the full loop — due, ticked, no longer due, advanced by exactly one step', async () => {
    const lead = await seedDue();

    const dueBefore = await crm.listDueFollowups(NOW);
    assert.deepEqual(dueBefore.map((l) => l.lead_id), [lead.lead_id], 'the seeded lead must be due');

    const result = await tick(crm, lead, { now: NOW, timeZone: TZ });
    assert.equal(result.sent, true);

    const updated = await crm.getLeadByDedupeKey(lead.dedupe_key);
    assert.equal(updated.followup_step, 1, 'exactly one step forward, not zero, not two');
    assert.equal(updated.followup_status, 'IN_PROGRESS');
    assert.equal(updated.next_followup_at, '2026-03-03T18:00:00.000Z', 'HOT step 1 is +24h, clamped to Tue 10:00 PST');

    const dueAfter = await crm.listDueFollowups(NOW);
    assert.deepEqual(dueAfter, [], 'the same tick must not find this lead due again immediately');

    const sent = await crm.listEvents({ leadId: lead.lead_id, eventType: 'FOLLOWUP_SENT' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].details.step, 0);
  });

  test('running the tick twice for the same due state sends exactly once (spec 3.3 idempotency)', async () => {
    const lead = await seedDue();

    const first = await tick(crm, lead, { now: NOW, timeZone: TZ });
    const second = await tick(crm, lead, { now: NOW, timeZone: TZ }); // same pre-tick snapshot, simulating a retry

    assert.equal(first.sent, true);
    assert.equal(second.sent, false);
    assert.equal(second.alreadyClaimed, true);

    const sent = await crm.listEvents({ leadId: lead.lead_id, eventType: 'FOLLOWUP_SENT' });
    assert.equal(sent.length, 1, 'a retried tick must not produce a second send');

    const updated = await crm.getLeadByDedupeKey(lead.dedupe_key);
    assert.equal(updated.followup_step, 1, 'the retried call must not advance the step a second time');
  });

  test('a WARM lead advances through its full three-step cadence, one step per tick', async () => {
    const lead = await seedDue({ lead_temperature: 'WARM' });

    const afterStep0 = (await tick(crm, lead, { now: NOW, timeZone: TZ })).lead;
    assert.equal(afterStep0.followup_step, 1);
    assert.equal(afterStep0.followup_status, 'IN_PROGRESS');

    const afterStep1 = (await tick(crm, afterStep0, { now: NOW, timeZone: TZ })).lead;
    assert.equal(afterStep1.followup_step, 2);
    assert.equal(afterStep1.followup_status, 'IN_PROGRESS');

    const afterStep2 = (await tick(crm, afterStep1, { now: NOW, timeZone: TZ })).lead;
    assert.equal(afterStep2.followup_step, 3);
    assert.equal(afterStep2.followup_status, 'COMPLETED');
    assert.equal(afterStep2.next_followup_at, null);

    const sent = await crm.listEvents({ leadId: lead.lead_id, eventType: 'FOLLOWUP_SENT' });
    assert.equal(sent.length, 3, 'three sends for a three-step cadence, no more, no fewer');
  });
});

describe('M6 acceptance, verbatim (spec 9): stops correctly at every stop condition (spec 6.3)', () => {
  const cases = [
    ['booking_status = BOOKED', { booking_status: 'BOOKED' }, 'booking_confirmed'],
    ['crm_status = LOST', { crm_status: 'LOST' }, 'crm_status_lost'],
    ['crm_status = BOOKED', { crm_status: 'BOOKED' }, 'crm_status_booked'],
    ['a reply is recorded', { replied_at: '2026-03-02T12:00:00Z' }, 'lead_replied'],
  ];

  for (const [label, patch, reason] of cases) {
    test(`${label} stops the sequence without sending`, async () => {
      const lead = await seedDue({ followup_step: 1, ...patch });

      const result = await tick(crm, lead, { now: NOW, timeZone: TZ });
      assert.equal(result.sent, false);
      assert.equal(result.stopped, true);
      assert.equal(result.reason, reason);

      const updated = await crm.getLeadByDedupeKey(lead.dedupe_key);
      assert.equal(updated.followup_status, 'STOPPED');
      assert.equal(updated.next_followup_at, null);
      assert.equal(updated.followup_step, 1, 'a stopped sequence must not advance its step');

      const sentEvents = await crm.listEvents({ leadId: lead.lead_id, eventType: 'FOLLOWUP_SENT' });
      assert.equal(sentEvents.length, 0, 'a stop condition must pre-empt the send, not follow it');

      const stoppedEvents = await crm.listEvents({ leadId: lead.lead_id, eventType: 'FOLLOWUP_STOPPED' });
      assert.equal(stoppedEvents.length, 1);
      assert.equal(stoppedEvents[0].details.reason, reason);

      // Nothing claimed the slot — a stop condition must pre-empt the idempotency
      // claim too, or a later legitimate send for this step would be refused.
      const claim = await crm.claimNotification({ leadId: lead.lead_id, kind: 'FOLLOWUP', step: 1 });
      assert.equal(claim.claimed, true);
    });
  }

  test('the final step being sent completes the sequence and logs FOLLOWUP_STOPPED with reason sequence_complete', async () => {
    // COLD has two steps (0, 1); step 1 is the last one.
    const lead = await seedDue({ lead_temperature: 'COLD', followup_step: 1 });

    const result = await tick(crm, lead, { now: NOW, timeZone: TZ });
    assert.equal(result.sent, true);
    assert.equal(result.stopped, true);

    const updated = await crm.getLeadByDedupeKey(lead.dedupe_key);
    assert.equal(updated.followup_step, 2);
    assert.equal(updated.followup_status, 'COMPLETED');
    assert.equal(updated.next_followup_at, null);

    const sent = await crm.listEvents({ leadId: lead.lead_id, eventType: 'FOLLOWUP_SENT' });
    assert.equal(sent.length, 1, 'the final step still gets its message sent and logged');

    const stopped = await crm.listEvents({ leadId: lead.lead_id, eventType: 'FOLLOWUP_STOPPED' });
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].details.reason, 'sequence_complete');
  });
});
