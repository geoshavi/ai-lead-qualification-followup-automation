/**
 * adapter-parity.test.js — the M2 "done when" gate.
 *
 * The same contract suite is run against every CRM adapter. mockCrm always
 * runs; supabaseCrm runs when SUPABASE_URL and SUPABASE_SERVICE_KEY point at a
 * reachable PostgREST endpoint — a hosted Supabase Free project, or the local
 * Postgres + PostgREST stack described in docs/testing notes.
 *
 * The default `npm test` therefore stays offline, free and fast, which is the
 * $0 development path the spec asks for. Nothing here calls a paid service.
 */

import { test, describe, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMockCrm } from '../src/adapters/mockCrm.js';
import { DEFAULT_REST_PATH, createSupabaseCrm } from '../src/adapters/supabaseCrm.js';
import { runCrmContractSuite } from './helpers/crm-contract-suite.js';

// ---------------------------------------------------------------------------
// mock — always runs
// ---------------------------------------------------------------------------
const mockDirs = [];

runCrmContractSuite({
  name: 'mockCrm (JSON file on disk)',
  setup: async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lead-engine-mock-'));
    mockDirs.push(dir);

    return {
      adapter: createMockCrm({ file: join(dir, 'mock-crm.json') }),
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    };
  },
});

// ---------------------------------------------------------------------------
// supabase — runs only when an endpoint is configured
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Supabase mounts PostgREST under /rest/v1; a bare PostgREST container is
// mounted at the root. Test-only knob — the product never reads it, and it is
// not in .env.example, because a real deployment is always Supabase.
const REST_PATH = process.env.SUPABASE_REST_PATH ?? DEFAULT_REST_PATH;
const REST_BASE = SUPABASE_URL ? `${SUPABASE_URL.replace(/\/+$/, '')}${REST_PATH}` : null;

const supabaseConfigured = Boolean(SUPABASE_URL);

if (!supabaseConfigured) {
  describe('CRM adapter contract — supabaseCrm (PostgREST)', () => {
    test('skipped: SUPABASE_URL is not set', (t) => {
      t.skip('set SUPABASE_URL (and SUPABASE_SERVICE_KEY) to run the hosted-parity half of this suite');
    });
  });
} else {
  /** Empty the tables between tests, over the same HTTP surface the adapter uses. */
  async function truncate() {
    const headers = {
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    };
    if (SUPABASE_SERVICE_KEY) {
      headers.apikey = SUPABASE_SERVICE_KEY;
      headers.Authorization = `Bearer ${SUPABASE_SERVICE_KEY}`;
    }

    // lead_events first: its lead_id is ON DELETE SET NULL, so deleting leads
    // would orphan rather than remove them. Filtering on the primary key is
    // PostgREST's way of saying "every row" — it refuses an unfiltered DELETE.
    const tables = [['lead_events', 'event_id'], ['notifications', 'id'], ['leads', 'lead_id']];

    for (const [table, primaryKey] of tables) {
      const response = await fetch(`${REST_BASE}/${table}?${primaryKey}=not.is.null`, {
        method: 'DELETE',
        headers,
      });
      if (!response.ok) {
        throw new Error(`truncate ${table} failed: ${response.status} ${await response.text()}`);
      }
    }
  }

  runCrmContractSuite({
    name: 'supabaseCrm (PostgREST)',
    setup: async () => {
      await truncate();
      return {
        adapter: createSupabaseCrm({
          url: SUPABASE_URL,
          serviceKey: SUPABASE_SERVICE_KEY,
          restPath: REST_PATH,
        }),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------
after(async () => {
  await Promise.all(mockDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
