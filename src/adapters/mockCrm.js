/**
 * mockCrm.js — the CRM adapter that needs no hosted service.
 *
 * This is the DEFAULT adapter (`CRM_ADAPTER=mock`). It keeps the whole system
 * demoable and testable with nothing installed: state is a JSON file on disk.
 * Every log line, function name and file name says `mock`, because the spec
 * forbids a mocked integration that reads as a real one.
 *
 * It is deliberately held to the same behaviour as supabaseCrm.js by
 * tests/helpers/crm-contract-suite.js. Where the two must differ, the
 * difference is documented rather than hidden — see "single process" below.
 *
 * SINGLE PROCESS. Mutations are serialised through an in-process queue and the
 * file is replaced atomically (write a temp file, then rename), so two
 * concurrent calls inside one Node process cannot produce two rows. Two
 * separate processes writing the same file still can. The real guarantee is
 * `leads.dedupe_key UNIQUE` in Postgres; this imitates it. Do not demo the
 * concurrency claim on the mock.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { detectCrossKeyConflict, mergeDuplicate } from '../core/dedupe.js';
import { EVENT_STATUS, EVENT_TYPE } from '../core/schema.js';
import {
  buildEventRow,
  buildInsertRow,
  buildNotificationRow,
  buildUpdatePatch,
  coerceEventRow,
  coerceLeadRow,
  coerceNotificationRow,
  toIsoUtc,
} from './leadRow.js';

/** Where state lives when the caller does not say. `.data/` is gitignored. */
export const DEFAULT_MOCK_FILE = '.data/mock-crm.json';

const STATE_VERSION = 1;

function emptyState() {
  return { version: STATE_VERSION, leads: [], lead_events: [], notifications: [] };
}

function present(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * @param {{file?: string, now?: () => Date}} [options]
 */
export function createMockCrm(options = {}) {
  const file = options.file ?? DEFAULT_MOCK_FILE;
  const now = options.now ?? (() => new Date());

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------

  async function load() {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }

    const parsed = JSON.parse(text);
    return {
      version: STATE_VERSION,
      leads: parsed.leads ?? [],
      lead_events: parsed.lead_events ?? [],
      notifications: parsed.notifications ?? [],
    };
  }

  async function save(state) {
    await mkdir(dirname(file), { recursive: true });

    // Write elsewhere, then rename. A rename is atomic, so a reader never sees
    // a half-written file and a crash mid-write cannot corrupt the state.
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
    await rename(temp, file);
  }

  // One mutation at a time. `tail` is kept resolved so a failed operation does
  // not poison the queue for the next caller.
  let tail = Promise.resolve();

  function transact(work) {
    const run = tail.then(async () => {
      const state = await load();
      try {
        const result = await work(state);
        await save(state);
        return result;
      } catch (error) {
        // `work` validates before it mutates, so at this point the only change
        // to `state` is the failure event. Persist it: an audit log that drops
        // failures is worse than none.
        await save(state);
        throw error;
      }
    });

    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function read(work) {
    return transact(async (state) => work(state));
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  function appendEvent(state, event) {
    const row = {
      event_id: randomUUID(),
      ...buildEventRow(event),
      created_at: now().toISOString(),
    };
    state.lead_events.push(row);
    return coerceEventRow(row);
  }

  function auditFailure(state, operation, error) {
    appendEvent(state, {
      lead_id: null,
      event_type: EVENT_TYPE.WORKFLOW_ERROR,
      status: EVENT_STATUS.FAILURE,
      details: { adapter: 'mock', operation },
      error_message: error.message,
    });
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  function findByDedupeKey(state, key) {
    if (!present(key)) return null;
    return state.leads.find((row) => row.dedupe_key === key) ?? null;
  }

  /**
   * Find a row that looks like the same person under a different dedupe key.
   *
   * Spec section 7: same email arriving with a different source_id is a
   * cross-key conflict. Auto-merging risks fusing two real people who share an
   * inbox, so it goes to a person instead.
   */
  function findCrossKeyCandidate(state, incoming) {
    const email = present(incoming.email) ? incoming.email.toLowerCase() : null;
    const phone = present(incoming.phone) ? incoming.phone.trim() : null;
    if (!email && !phone) return null;

    return state.leads.find((row) => {
      if (row.dedupe_key === incoming.dedupe_key) return false;
      if (email && present(row.email) && row.email.toLowerCase() === email) return true;
      return Boolean(phone && present(row.phone) && row.phone.trim() === phone);
    }) ?? null;
  }

  // -------------------------------------------------------------------------
  // Contract
  // -------------------------------------------------------------------------

  return {
    /** Identifies itself in logs, because a mock must never read as real. */
    name: 'mock',

    async upsertLead(canonicalLead) {
      return transact(async (state) => {
        let incoming;
        try {
          incoming = buildInsertRow(canonicalLead);
        } catch (error) {
          auditFailure(state, 'upsertLead', error);
          throw error;
        }

        const existing = findByDedupeKey(state, incoming.dedupe_key);

        // ---- duplicate: merge, never overwrite, never re-trigger ----------
        if (existing) {
          const conflict = detectCrossKeyConflict(incoming, existing);
          const { patch } = mergeDuplicate(existing, incoming);

          const needsReview =
            Boolean(existing.needs_human_review) || Boolean(incoming.needs_human_review) || conflict.conflict;
          if (needsReview !== existing.needs_human_review) patch.needs_human_review = needsReview;

          const reason = existing.review_reason ?? incoming.review_reason ?? conflict.reviewReason ?? null;
          if (reason !== existing.review_reason) patch.review_reason = reason;

          let merged;
          try {
            ({ merged } = buildUpdatePatch(existing, patch));
          } catch (error) {
            auditFailure(state, 'upsertLead', error);
            throw error;
          }

          merged.updated_at = now().toISOString();
          state.leads[state.leads.indexOf(existing)] = merged;

          appendEvent(state, {
            lead_id: merged.lead_id,
            event_type: EVENT_TYPE.DUPLICATE_FOUND,
            status: EVENT_STATUS.SUCCESS,
            details: {
              adapter: 'mock',
              dedupe_key: merged.dedupe_key,
              merged_fields: Object.keys(patch).sort(),
            },
          });

          if (conflict.conflict) {
            appendEvent(state, {
              lead_id: merged.lead_id,
              event_type: EVENT_TYPE.HUMAN_REVIEW_FLAGGED,
              status: EVENT_STATUS.SUCCESS,
              details: { adapter: 'mock', reason: conflict.reviewReason, reasons: conflict.reasons },
            });
          }

          return {
            leadId: merged.lead_id,
            created: false,
            duplicate: true,
            lead: coerceLeadRow(merged),
            review: {
              needsHumanReview: merged.needs_human_review,
              reason: merged.review_reason,
              conflictReasons: conflict.reasons,
            },
          };
        }

        // ---- insert -------------------------------------------------------
        const candidate = findCrossKeyCandidate(state, incoming);
        const conflict = candidate
          ? detectCrossKeyConflict(incoming, candidate)
          : { conflict: false, reasons: [], reviewReason: null };

        const timestamp = now().toISOString();
        const row = {
          ...incoming,
          needs_human_review: Boolean(incoming.needs_human_review) || conflict.conflict,
          review_reason: incoming.review_reason ?? conflict.reviewReason ?? null,
          lead_id: randomUUID(),
          created_at: timestamp,
          updated_at: timestamp,
        };

        state.leads.push(row);

        appendEvent(state, {
          lead_id: row.lead_id,
          event_type: EVENT_TYPE.CRM_CREATED,
          status: EVENT_STATUS.SUCCESS,
          details: { adapter: 'mock', dedupe_key: row.dedupe_key, source: row.source },
        });

        if (conflict.conflict) {
          appendEvent(state, {
            lead_id: row.lead_id,
            event_type: EVENT_TYPE.HUMAN_REVIEW_FLAGGED,
            status: EVENT_STATUS.SUCCESS,
            details: {
              adapter: 'mock',
              reason: conflict.reviewReason,
              reasons: conflict.reasons,
              conflicting_lead_id: candidate.lead_id,
            },
          });
        }

        return {
          leadId: row.lead_id,
          created: true,
          duplicate: false,
          lead: coerceLeadRow(row),
          review: {
            needsHumanReview: row.needs_human_review,
            reason: row.review_reason,
            conflictReasons: conflict.reasons,
          },
        };
      });
    },

    async getLeadByDedupeKey(key) {
      return read((state) => {
        const row = findByDedupeKey(state, key);
        return row ? coerceLeadRow(row) : null;
      });
    },

    async updateLead(leadId, patch) {
      return transact(async (state) => {
        const existing = state.leads.find((row) => row.lead_id === leadId);

        if (!existing) {
          const error = new Error(`updateLead: lead ${leadId} not found`);
          auditFailure(state, 'updateLead', error);
          throw error;
        }

        let merged;
        let fields;
        try {
          ({ merged, fields } = buildUpdatePatch(existing, patch));
        } catch (error) {
          auditFailure(state, 'updateLead', error);
          throw error;
        }

        merged.updated_at = now().toISOString();
        state.leads[state.leads.indexOf(existing)] = merged;

        appendEvent(state, {
          lead_id: leadId,
          event_type: EVENT_TYPE.CRM_UPDATED,
          status: EVENT_STATUS.SUCCESS,
          details: { adapter: 'mock', fields },
        });

        return coerceLeadRow(merged);
      });
    },

    async recordEvent(event) {
      return transact(async (state) => appendEvent(state, event));
    },

    async listEvents(filter = {}) {
      return read((state) => {
        const rows = state.lead_events
          .map((row, index) => ({ row, index }))
          .filter(({ row }) => {
            if (filter.leadId !== undefined && row.lead_id !== filter.leadId) return false;
            return !(filter.eventType !== undefined && row.event_type !== filter.eventType);
          });

        // Newest first. Two events can share a millisecond, so insertion order
        // breaks the tie — otherwise "newest" would be arbitrary.
        rows.sort((a, b) => Date.parse(b.row.created_at) - Date.parse(a.row.created_at) || b.index - a.index);

        const limited = filter.limit === undefined ? rows : rows.slice(0, filter.limit);
        return limited.map(({ row }) => coerceEventRow(row));
      });
    },

    /** The scheduler query from spec section 6.1, expressed in JavaScript. */
    async listDueFollowups(asOf) {
      const cutoff = Date.parse(toIsoUtc(asOf, 'now'));
      if (!Number.isFinite(cutoff)) {
        throw new TypeError(`listDueFollowups: expected a timestamp — received ${JSON.stringify(asOf)}`);
      }

      return read((state) =>
        state.leads
          .filter((row) => {
            if (row.followup_status !== 'IN_PROGRESS') return false;
            if (row.next_followup_at === null || row.next_followup_at === undefined) return false;
            if (Date.parse(row.next_followup_at) > cutoff) return false;
            if (row.booking_status === 'BOOKED') return false;
            return !(row.crm_status === 'LOST' || row.crm_status === 'BOOKED');
          })
          .sort((a, b) => Date.parse(a.next_followup_at) - Date.parse(b.next_followup_at))
          .map((row) => coerceLeadRow(row)),
      );
    },

    /**
     * Claim a (lead, kind, step) slot before sending (spec 3.3). The one and
     * only source of truth for "did this go out already" — never a boolean
     * flag on the lead row, because a flag races.
     */
    async claimNotification({ leadId, kind, step } = {}) {
      return transact(async (state) => {
        let candidate;
        try {
          candidate = buildNotificationRow({ lead_id: leadId, kind, step });
        } catch (error) {
          auditFailure(state, 'claimNotification', error);
          throw error;
        }

        const existing = state.notifications.find(
          (row) => row.lead_id === candidate.lead_id && row.kind === candidate.kind && row.step === candidate.step,
        );

        if (existing) {
          return { claimed: false, notification: coerceNotificationRow(existing) };
        }

        const row = { id: randomUUID(), ...candidate, sent_at: now().toISOString() };
        state.notifications.push(row);
        return { claimed: true, notification: coerceNotificationRow(row) };
      });
    },
  };
}
