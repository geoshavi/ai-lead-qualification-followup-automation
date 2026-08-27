-- ===========================================================================
-- 001_schema.sql — lead-engine core schema
--
-- Target: PostgreSQL 13+ (gen_random_uuid() is core from 13 on, so no
--         extension is required). Verified against postgres:16 and intended
--         to apply unchanged to a Supabase Free project.
--
-- Design notes:
--   * Enumerated values use CHECK constraints rather than Postgres ENUM types.
--     A CHECK is altered with a single statement; adding a value to an ENUM
--     that is already in use is a migration hazard. Behaviour is identical.
--   * Idempotency lives in the database, not in workflow logic:
--       - leads.dedupe_key         UNIQUE  -> a webhook fired twice cannot
--                                             create two rows, even racing.
--       - notifications(lead_id,kind,step) UNIQUE -> a message cannot be sent
--                                             twice, even racing.
--   * This file is re-runnable: every object is created IF NOT EXISTS.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- leads
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  lead_id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- provenance
  source             text        NOT NULL,
  source_id          text,

  -- identity
  first_name         text,
  last_name          text,
  email              text,                       -- lowercased + trimmed on write
  phone              text,                       -- E.164 where derivable
  company            text,

  -- the ask
  service_interest   text,
  message            text,                       -- raw user text (untrusted)
  budget_raw         text,                       -- exactly as submitted
  budget_amount      numeric,                    -- parsed, nullable
  budget_currency    text        NOT NULL DEFAULT 'USD',
  timeline           text,

  -- AI scoring output (nullable until scored; never written by the model
  -- directly — deterministic code parses, validates, clamps, then applies)
  lead_score         int,
  lead_temperature   text,                       -- derived from score, not returned by the model
  ai_reasoning       text,
  recommended_action text,

  -- pipeline state
  crm_status         text        NOT NULL DEFAULT 'NEW',
  followup_status    text        NOT NULL DEFAULT 'PENDING',
  followup_step      int         NOT NULL DEFAULT 0,
  next_followup_at   timestamptz,                -- NULL means no scheduled follow-up
  last_contacted_at  timestamptz,
  replied_at         timestamptz,                -- non-null stops the sequence (spec 6.3)
  assigned_to        text,
  booking_status     text        NOT NULL DEFAULT 'NONE',

  -- human review
  needs_human_review boolean     NOT NULL DEFAULT false,
  review_reason      text,

  -- idempotency + provenance
  dedupe_key         text        NOT NULL,
  raw_payload        jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- original inbound payload, unmodified
  message_history    jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- appended on dedupe conflict (spec 7)

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT leads_dedupe_key_unique   UNIQUE (dedupe_key),
  CONSTRAINT leads_source_check        CHECK (source IN ('website','meta','email')),
  CONSTRAINT leads_score_range_check   CHECK (lead_score IS NULL OR (lead_score >= 0 AND lead_score <= 100)),
  CONSTRAINT leads_temperature_check   CHECK (lead_temperature IS NULL OR lead_temperature IN ('HOT','WARM','COLD')),
  CONSTRAINT leads_crm_status_check    CHECK (crm_status IN ('NEW','QUALIFIED','CONTACTED','NURTURING','BOOKED','LOST','HUMAN_REVIEW')),
  CONSTRAINT leads_followup_status_chk CHECK (followup_status IN ('PENDING','IN_PROGRESS','STOPPED','COMPLETED')),
  CONSTRAINT leads_followup_step_check CHECK (followup_step >= 0),
  CONSTRAINT leads_booking_status_chk  CHECK (booking_status IN ('NONE','BOOKED','CANCELLED')),
  CONSTRAINT leads_message_history_arr CHECK (jsonb_typeof(message_history) = 'array')
);

DROP TRIGGER IF EXISTS trg_leads_updated_at ON leads;
CREATE TRIGGER trg_leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- lead_events — append-only audit log
--
-- lead_id is nullable on purpose: a payload can fail validation before any
-- lead row exists, and that failure still has to be auditable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_events (
  event_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       uuid        REFERENCES leads(lead_id) ON DELETE SET NULL,
  event_type    text        NOT NULL,
  status        text        NOT NULL,
  details       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT lead_events_status_check CHECK (status IN ('SUCCESS','FAILURE','SKIPPED')),
  CONSTRAINT lead_events_type_check   CHECK (event_type IN (
    'LEAD_RECEIVED',
    'LEAD_NORMALIZED',
    'VALIDATION_FAILED',
    'DUPLICATE_FOUND',
    'AI_SCORE_CREATED',
    'AI_SCORE_INVALID',
    'CRM_CREATED',
    'CRM_UPDATED',
    'SLACK_ALERT_SENT',
    'FOLLOWUP_SENT',
    'FOLLOWUP_STOPPED',
    'BOOKING_RECEIVED',
    'SHEET_SYNCED',
    'HUMAN_REVIEW_FLAGGED',
    'WORKFLOW_ERROR'
  ))
);

-- ---------------------------------------------------------------------------
-- notifications — the entire duplicate-send prevention mechanism
--
-- Before sending anything, attempt the insert. A unique violation means the
-- message already went out, so skip. A boolean flag on the lead row races;
-- this does not.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid        NOT NULL REFERENCES leads(lead_id) ON DELETE CASCADE,
  kind    text        NOT NULL,
  step    int         NOT NULL DEFAULT 0,
  sent_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notifications_kind_check   CHECK (kind IN ('SLACK_HOT','FOLLOWUP','BOOKING_CONFIRM')),
  CONSTRAINT notifications_step_check   CHECK (step >= 0),
  CONSTRAINT notifications_unique_send  UNIQUE (lead_id, kind, step)
);
