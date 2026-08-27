-- ===========================================================================
-- 002_indexes.sql — lead-engine indexes
--
-- The UNIQUE constraints declared in 001_schema.sql already create their own
-- backing indexes (leads.dedupe_key, notifications(lead_id,kind,step)). They
-- are deliberately not repeated here.
--
-- Re-runnable: every index is created IF NOT EXISTS.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Scheduler hot path (spec 6.1)
--
--   SELECT * FROM leads
--    WHERE next_followup_at <= now()
--      AND followup_status = 'IN_PROGRESS'
--      AND booking_status <> 'BOOKED'
--      AND crm_status NOT IN ('LOST','BOOKED')
--
-- now() is not immutable so it cannot appear in an index predicate, but the
-- static half of the WHERE clause can. This partial index stays small — it
-- covers only leads with a live, scheduled follow-up — and the cron workflow
-- reads it every 15 minutes, so it is the one index that must be right.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_leads_due_followups
  ON leads (next_followup_at)
  WHERE followup_status = 'IN_PROGRESS'
    AND next_followup_at IS NOT NULL
    AND booking_status <> 'BOOKED'
    AND crm_status NOT IN ('LOST','BOOKED');

-- ---------------------------------------------------------------------------
-- Dedupe lookups (spec 7 precedence: source_id, then email, then phone)
-- email and phone are normalised on write, so plain b-tree indexes suffice.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_leads_email
  ON leads (email)
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_phone
  ON leads (phone)
  WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_source_source_id
  ON leads (source, source_id)
  WHERE source_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Review queue and reporting
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_leads_needs_human_review
  ON leads (created_at DESC)
  WHERE needs_human_review;

CREATE INDEX IF NOT EXISTS idx_leads_crm_status
  ON leads (crm_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_leads_temperature
  ON leads (lead_temperature, created_at DESC)
  WHERE lead_temperature IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Audit trail — "show me everything that happened to this lead, in order"
-- is the demo query, so it gets a composite index.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_lead_events_lead_id_created_at
  ON lead_events (lead_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_events_type_created_at
  ON lead_events (event_type, created_at DESC);

-- Failure triage: find every failed event without scanning the whole log.
CREATE INDEX IF NOT EXISTS idx_lead_events_failures
  ON lead_events (created_at DESC)
  WHERE status = 'FAILURE';

-- ---------------------------------------------------------------------------
-- Notification lookups by lead (the UNIQUE constraint's index is
-- (lead_id, kind, step), which already serves lead_id-prefixed lookups —
-- so no additional index on lead_id alone is needed.)
-- ---------------------------------------------------------------------------
