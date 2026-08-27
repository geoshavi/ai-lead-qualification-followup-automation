/**
 * supabaseCrm.js — the CRM adapter for hosted Postgres.
 *
 * Speaks PostgREST over built-in `fetch`. No SDK, no Postgres driver, no npm
 * dependency: the project ships with an empty dependency tree and no lockfile
 * (tests/core-contract.test.js enforces it), and `SUPABASE_URL` +
 * `SUPABASE_SERVICE_KEY` from PROJECT_SPEC.md section 12 are PostgREST
 * credentials rather than a connection string.
 *
 * Works within Supabase Free. Nothing here uses a paid feature. It also runs
 * unchanged against a bare PostgREST container, which is how the parity suite
 * exercises it without anyone needing an account — pass `restPath: ''`, since
 * only Supabase mounts PostgREST under /rest/v1.
 *
 * Postgres owns the clock. `created_at` and `updated_at` come from `now()` and
 * the `trg_leads_updated_at` trigger, so unlike mockCrm there is no injectable
 * clock here — there is nothing for it to control.
 */

import { detectCrossKeyConflict, mergeDuplicate } from '../core/dedupe.js';
import { EVENT_STATUS, EVENT_TYPE } from '../core/schema.js';
import {
  buildEventRow,
  buildInsertRow,
  buildUpdatePatch,
  coerceEventRow,
  coerceLeadRow,
  toIsoUtc,
} from './leadRow.js';

/** Supabase mounts PostgREST here; a bare PostgREST is mounted at the root. */
export const DEFAULT_REST_PATH = '/rest/v1';

/** Postgres unique-violation SQLSTATE. This one is expected, not exceptional. */
const UNIQUE_VIOLATION = '23505';

/** An error carrying the PostgREST/Postgres detail, so failures stay diagnosable. */
export class SupabaseCrmError extends Error {
  constructor(message, { status, code, details, hint, operation }) {
    super(message);
    this.name = 'SupabaseCrmError';
    this.status = status ?? null;
    this.code = code ?? null;
    this.details = details ?? null;
    this.hint = hint ?? null;
    this.operation = operation ?? null;
  }
}

function present(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** PostgREST filter value: `eq.` stays literal, the value is escaped. */
function filter(operator, value) {
  return `${operator}.${encodeURIComponent(value)}`;
}

/**
 * @param {{url: string, serviceKey?: string, restPath?: string,
 *          fetchImpl?: typeof fetch, timeoutMs?: number}} options
 */
export function createSupabaseCrm(options = {}) {
  const { url, serviceKey } = options;

  if (!present(url)) {
    throw new TypeError('createSupabaseCrm: url is required (SUPABASE_URL)');
  }

  const restPath = options.restPath ?? DEFAULT_REST_PATH;
  const base = `${url.replace(/\/+$/, '')}${restPath}`;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10000;

  function headers(extra) {
    const out = { 'Content-Type': 'application/json', ...extra };
    // A bare PostgREST needs no key. Only send credentials when we have them,
    // and never log this object.
    if (present(serviceKey)) {
      out.apikey = serviceKey;
      out.Authorization = `Bearer ${serviceKey}`;
    }
    return out;
  }

  /**
   * One PostgREST round trip.
   *
   * Every call is bounded by a timeout — a hung request must not hold an n8n
   * execution open. Backoff/retry is the M8 resilience pass, deliberately not
   * smuggled in here.
   */
  async function request(operation, path, init = {}) {
    let response;
    try {
      response = await doFetch(`${base}${path}`, {
        ...init,
        headers: headers(init.headers),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const reason = cause?.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : cause?.message;
      throw new SupabaseCrmError(`supabaseCrm: ${operation} could not reach PostgREST — ${reason}`, {
        operation,
      });
    }

    const text = await response.text();
    let body = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }

    if (!response.ok) {
      const message = body?.message ?? text ?? response.statusText;
      throw new SupabaseCrmError(
        `supabaseCrm: ${operation} failed (${response.status}${body?.code ? ` ${body.code}` : ''}): ${message}`,
        { status: response.status, code: body?.code, details: body?.details, hint: body?.hint, operation },
      );
    }

    return body;
  }

  async function selectRows(operation, table, query) {
    return (await request(operation, `/${table}?${query}`, { method: 'GET' })) ?? [];
  }

  async function selectLead(operation, query) {
    const [row] = await selectRows(operation, 'leads', `${query}&limit=1`);
    return row ? coerceLeadRow(row) : null;
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  async function insertEvent(event) {
    const [row] = await request('recordEvent', '/lead_events', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(buildEventRow(event)),
    });
    return coerceEventRow(row);
  }

  /**
   * Audit a failed write without masking the failure.
   *
   * If the audit write fails too, the original error is still what the caller
   * sees — losing the real cause to a logging problem would be the worse bug.
   */
  async function auditFailure(operation, error, leadId = null) {
    try {
      await insertEvent({
        lead_id: leadId,
        event_type: EVENT_TYPE.WORKFLOW_ERROR,
        status: EVENT_STATUS.FAILURE,
        details: { adapter: 'supabase', operation },
        error_message: error.message,
      });
    } catch {
      // Deliberately swallowed. See above.
    }
  }

  /**
   * Find a row that looks like the same person under a different dedupe key.
   * Spec section 7 sends these to a human rather than auto-merging.
   */
  async function findCrossKeyCandidate(incoming) {
    // Values inside or=(...) must be percent-encoded, not just left literal:
    // a query string decodes a bare `+` to a space, which silently turned the
    // E.164 phone +15551234567 into " 15551234567" and matched nothing.
    const clauses = [];
    if (present(incoming.email)) clauses.push(`email.${filter('eq', incoming.email.toLowerCase())}`);
    if (present(incoming.phone)) clauses.push(`phone.${filter('eq', incoming.phone.trim())}`);
    if (clauses.length === 0) return null;

    const query = [
      `or=(${clauses.join(',')})`,
      `dedupe_key=${filter('neq', incoming.dedupe_key)}`,
      'order=created_at.asc',
    ].join('&');

    return selectLead('upsertLead', query);
  }

  // -------------------------------------------------------------------------
  // Contract
  // -------------------------------------------------------------------------

  return {
    name: 'supabase',

    async upsertLead(canonicalLead) {
      let incoming;
      try {
        incoming = buildInsertRow(canonicalLead);
      } catch (error) {
        await auditFailure('upsertLead', error);
        throw error;
      }

      try {
        const candidate = await findCrossKeyCandidate(incoming);
        const conflict = candidate
          ? detectCrossKeyConflict(incoming, candidate)
          : { conflict: false, reasons: [], reviewReason: null };

        const body = {
          ...incoming,
          needs_human_review: Boolean(incoming.needs_human_review) || conflict.conflict,
          review_reason: incoming.review_reason ?? conflict.reviewReason ?? null,
        };

        // ---- insert -------------------------------------------------------
        // The UNIQUE constraint on dedupe_key is the concurrency guarantee: two
        // simultaneous webhooks race here and Postgres picks exactly one winner.
        try {
          const [inserted] = await request('upsertLead', '/leads', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify(body),
          });

          const lead = coerceLeadRow(inserted);

          await insertEvent({
            lead_id: lead.lead_id,
            event_type: EVENT_TYPE.CRM_CREATED,
            status: EVENT_STATUS.SUCCESS,
            details: { adapter: 'supabase', dedupe_key: lead.dedupe_key, source: lead.source },
          });

          if (conflict.conflict) {
            await insertEvent({
              lead_id: lead.lead_id,
              event_type: EVENT_TYPE.HUMAN_REVIEW_FLAGGED,
              status: EVENT_STATUS.SUCCESS,
              details: {
                adapter: 'supabase',
                reason: conflict.reviewReason,
                reasons: conflict.reasons,
                conflicting_lead_id: candidate.lead_id,
              },
            });
          }

          return {
            leadId: lead.lead_id,
            created: true,
            duplicate: false,
            lead,
            review: {
              needsHumanReview: lead.needs_human_review,
              reason: lead.review_reason,
              conflictReasons: conflict.reasons,
            },
          };
        } catch (error) {
          if (error.code !== UNIQUE_VIOLATION) throw error;
        }

        // ---- duplicate: merge, never overwrite, never re-trigger -----------
        const existing = await selectLead('upsertLead', `dedupe_key=${filter('eq', incoming.dedupe_key)}`);
        if (!existing) {
          throw new SupabaseCrmError(
            `supabaseCrm: upsertLead hit a unique violation on ${incoming.dedupe_key} but the row is not readable`,
            { operation: 'upsertLead', code: UNIQUE_VIOLATION },
          );
        }

        const keyConflict = detectCrossKeyConflict(incoming, existing);
        const { patch } = mergeDuplicate(existing, incoming);

        const needsReview =
          Boolean(existing.needs_human_review) || Boolean(incoming.needs_human_review) || keyConflict.conflict;
        if (needsReview !== existing.needs_human_review) patch.needs_human_review = needsReview;

        const reason = existing.review_reason ?? incoming.review_reason ?? keyConflict.reviewReason ?? null;
        if (reason !== existing.review_reason) patch.review_reason = reason;

        const { patch: writable } = buildUpdatePatch(existing, patch);

        // An empty PATCH body is a no-op request PostgREST rejects, and a
        // resubmitted identical form legitimately produces one.
        const merged = Object.keys(writable).length === 0
          ? existing
          : coerceLeadRow(
            (await request('upsertLead', `/leads?lead_id=${filter('eq', existing.lead_id)}`, {
              method: 'PATCH',
              headers: { Prefer: 'return=representation' },
              body: JSON.stringify(writable),
            }))[0],
          );

        await insertEvent({
          lead_id: merged.lead_id,
          event_type: EVENT_TYPE.DUPLICATE_FOUND,
          status: EVENT_STATUS.SUCCESS,
          details: {
            adapter: 'supabase',
            dedupe_key: merged.dedupe_key,
            merged_fields: Object.keys(writable).sort(),
          },
        });

        if (keyConflict.conflict) {
          await insertEvent({
            lead_id: merged.lead_id,
            event_type: EVENT_TYPE.HUMAN_REVIEW_FLAGGED,
            status: EVENT_STATUS.SUCCESS,
            details: { adapter: 'supabase', reason: keyConflict.reviewReason, reasons: keyConflict.reasons },
          });
        }

        return {
          leadId: merged.lead_id,
          created: false,
          duplicate: true,
          lead: merged,
          review: {
            needsHumanReview: merged.needs_human_review,
            reason: merged.review_reason,
            conflictReasons: keyConflict.reasons,
          },
        };
      } catch (error) {
        await auditFailure('upsertLead', error);
        throw error;
      }
    },

    async getLeadByDedupeKey(key) {
      if (!present(key)) return null;
      return selectLead('getLeadByDedupeKey', `dedupe_key=${filter('eq', key)}`);
    },

    async updateLead(leadId, patch) {
      const existing = await selectLead('updateLead', `lead_id=${filter('eq', leadId)}`);

      if (!existing) {
        const error = new SupabaseCrmError(`updateLead: lead ${leadId} not found`, { operation: 'updateLead' });
        await auditFailure('updateLead', error);
        throw error;
      }

      let writable;
      let fields;
      try {
        ({ patch: writable, fields } = buildUpdatePatch(existing, patch));
      } catch (error) {
        await auditFailure('updateLead', error, leadId);
        throw error;
      }

      try {
        // updated_at is never sent: trg_leads_updated_at owns it.
        const rows = Object.keys(writable).length === 0
          ? [existing]
          : await request('updateLead', `/leads?lead_id=${filter('eq', leadId)}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify(writable),
          });

        const lead = coerceLeadRow(rows[0]);

        await insertEvent({
          lead_id: leadId,
          event_type: EVENT_TYPE.CRM_UPDATED,
          status: EVENT_STATUS.SUCCESS,
          details: { adapter: 'supabase', fields },
        });

        return lead;
      } catch (error) {
        await auditFailure('updateLead', error, leadId);
        throw error;
      }
    },

    async recordEvent(event) {
      return insertEvent(event);
    },

    async listEvents(filters = {}) {
      const query = ['order=created_at.desc'];

      if (filters.leadId !== undefined) {
        query.push(`lead_id=${filters.leadId === null ? 'is.null' : filter('eq', filters.leadId)}`);
      }
      if (filters.eventType !== undefined) query.push(`event_type=${filter('eq', filters.eventType)}`);
      if (filters.limit !== undefined) query.push(`limit=${Number(filters.limit)}`);

      const rows = await selectRows('listEvents', 'lead_events', query.join('&'));
      return rows.map((row) => coerceEventRow(row));
    },

    /** The scheduler query from spec section 6.1, expressed as PostgREST filters. */
    async listDueFollowups(asOf) {
      const cutoff = toIsoUtc(asOf, 'now');
      if (cutoff === null) {
        throw new TypeError(`listDueFollowups: expected a timestamp — received ${JSON.stringify(asOf)}`);
      }

      // A NULL next_followup_at never satisfies lte, so "no scheduled
      // follow-up" is excluded without a separate clause.
      const query = [
        `next_followup_at=${filter('lte', cutoff)}`,
        'followup_status=eq.IN_PROGRESS',
        'booking_status=neq.BOOKED',
        'crm_status=not.in.(LOST,BOOKED)',
        'order=next_followup_at.asc',
      ].join('&');

      const rows = await selectRows('listDueFollowups', 'leads', query);
      return rows.map((row) => coerceLeadRow(row));
    },
  };
}
