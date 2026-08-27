/**
 * adapter-mock.test.js — the half of mockCrm that the parity suite cannot reach.
 *
 * tests/adapter-parity.test.js proves mockCrm behaves like supabaseCrm. It
 * cannot prove the things that are true only of the mock: that state really
 * lands in a file rather than in memory, that the injected clock is the only
 * clock, and that concurrent callers inside one process do not lose each
 * other's writes.
 *
 * The parity suite builds one adapter per test and never reopens the file, so
 * without the persistence test below, an entirely in-memory mock would pass
 * every contract assertion — and then lose the demo data between n8n
 * executions.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_MOCK_FILE, createMockCrm } from '../src/adapters/mockCrm.js';
import { leadFixture } from './helpers/crm-contract-suite.js';

let dir;
let file;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lead-engine-mock-only-'));
  file = join(dir, 'mock-crm.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('mockCrm identifies itself as a mock (spec 0.2)', () => {
  test('the adapter reports the name mock', () => {
    assert.equal(createMockCrm({ file }).name, 'mock');
  });

  test('the default state file lives under the gitignored .data directory', () => {
    assert.equal(DEFAULT_MOCK_FILE, '.data/mock-crm.json');
  });
});

describe('state lives in a file, not in memory', () => {
  test('a second adapter over the same file sees the first one\'s lead', async () => {
    const writer = createMockCrm({ file });
    const { leadId } = await writer.upsertLead(leadFixture());

    const reader = createMockCrm({ file });
    const found = await reader.getLeadByDedupeKey('email:ada@example.com');

    assert.equal(found.lead_id, leadId, 'a fresh adapter must read what the previous one wrote');
  });

  test('a second adapter sees the audit trail too', async () => {
    const writer = createMockCrm({ file });
    const { leadId } = await writer.upsertLead(leadFixture());

    const events = await createMockCrm({ file }).listEvents({ leadId });

    assert.deepEqual(events.map((e) => e.event_type), ['CRM_CREATED']);
  });

  test('a duplicate submitted through a different adapter instance still merges', async () => {
    await createMockCrm({ file }).upsertLead(leadFixture({ message: 'First.' }));
    const second = await createMockCrm({ file }).upsertLead(leadFixture({ message: 'Second.' }));

    assert.equal(second.created, false);
    assert.deepEqual(second.lead.message_history, ['Second.']);
  });

  test('reading before anything is written does not throw', async () => {
    const crm = createMockCrm({ file: join(dir, 'nested', 'never-written.json') });

    assert.equal(await crm.getLeadByDedupeKey('email:nobody@example.com'), null);
    assert.deepEqual(await crm.listDueFollowups('2026-03-10T17:00:00.000Z'), []);
  });

  test('the file is JSON carrying a table per schema object', async () => {
    await createMockCrm({ file }).upsertLead(leadFixture());
    const state = JSON.parse(await readFile(file, 'utf8'));

    assert.deepEqual(Object.keys(state).sort(), ['lead_events', 'leads', 'notifications', 'version']);
    assert.equal(state.leads.length, 1);
  });

  test('no temporary file is left behind', async () => {
    const crm = createMockCrm({ file });
    await crm.upsertLead(leadFixture());
    await crm.upsertLead(leadFixture({ dedupe_key: 'email:grace@example.com', email: 'grace@example.com' }));

    assert.deepEqual(await readdir(dir), ['mock-crm.json']);
  });
});

describe('the injected clock is the only clock', () => {
  /** Frozen, then advanced by hand — no sleeping, no ambient time. */
  function frozen(start) {
    const state = { at: new Date(start) };
    return { now: () => state.at, set: (iso) => { state.at = new Date(iso); } };
  }

  test('created_at and updated_at are the injected instant, exactly', async () => {
    const clock = frozen('2026-03-10T17:00:00.000Z');
    const { lead } = await createMockCrm({ file, now: clock.now }).upsertLead(leadFixture());

    assert.equal(lead.created_at, '2026-03-10T17:00:00.000Z');
    assert.equal(lead.updated_at, '2026-03-10T17:00:00.000Z');
  });

  test('an update moves updated_at and leaves created_at alone', async () => {
    const clock = frozen('2026-03-10T17:00:00.000Z');
    const crm = createMockCrm({ file, now: clock.now });
    const { leadId } = await crm.upsertLead(leadFixture());

    clock.set('2026-03-11T09:30:00.000Z');
    const updated = await crm.updateLead(leadId, { lead_score: 80 });

    assert.equal(updated.created_at, '2026-03-10T17:00:00.000Z');
    assert.equal(updated.updated_at, '2026-03-11T09:30:00.000Z');
  });

  test('an audit event is stamped with the injected instant', async () => {
    const clock = frozen('2026-03-10T17:00:00.000Z');
    const crm = createMockCrm({ file, now: clock.now });
    const event = await crm.recordEvent({ event_type: 'LEAD_RECEIVED', status: 'SUCCESS' });

    assert.equal(event.created_at, '2026-03-10T17:00:00.000Z');
  });

  test('a merge moves updated_at on the surviving row', async () => {
    const clock = frozen('2026-03-10T17:00:00.000Z');
    const crm = createMockCrm({ file, now: clock.now });
    await crm.upsertLead(leadFixture({ message: 'First.' }));

    clock.set('2026-03-12T11:00:00.000Z');
    const { lead } = await crm.upsertLead(leadFixture({ message: 'Second.' }));

    assert.equal(lead.created_at, '2026-03-10T17:00:00.000Z');
    assert.equal(lead.updated_at, '2026-03-12T11:00:00.000Z');
  });
});

describe('concurrent callers in one process do not lose writes', () => {
  // Every operation is a read-modify-write of one JSON file. Without
  // serialisation these interleave and the last writer silently wins, which
  // shows up as leads and audit events quietly going missing.
  test('twenty parallel inserts all survive', async () => {
    const crm = createMockCrm({ file });

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        crm.upsertLead(leadFixture({ dedupe_key: `email:lead-${i}@example.com`, email: `lead-${i}@example.com` })),
      ),
    );

    const state = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(state.leads.length, 20);
    assert.equal(state.lead_events.filter((e) => e.event_type === 'CRM_CREATED').length, 20);
  });

  test('parallel updates to one lead all land in the audit log', async () => {
    const crm = createMockCrm({ file });
    const { leadId } = await crm.upsertLead(leadFixture());

    await Promise.all(
      Array.from({ length: 10 }, (_, i) => crm.updateLead(leadId, { followup_step: i })),
    );

    const events = await crm.listEvents({ leadId, eventType: 'CRM_UPDATED' });
    assert.equal(events.length, 10);
  });
});
