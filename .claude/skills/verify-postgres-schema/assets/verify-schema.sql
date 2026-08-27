\pset pager off

-- 1. Baseline insert + defaults ------------------------------------------------
INSERT INTO leads (source, email, message, dedupe_key)
VALUES ('website', 'ada@example.com', 'Need a quote', 'email:ada@example.com');

DO $v$
DECLARE r leads%ROWTYPE;
BEGIN
  SELECT * INTO r FROM leads WHERE dedupe_key = 'email:ada@example.com';
  IF r.lead_id IS NULL              THEN RAISE EXCEPTION 'FAIL: no uuid generated'; END IF;
  IF r.crm_status <> 'NEW'          THEN RAISE EXCEPTION 'FAIL: crm_status default'; END IF;
  IF r.followup_status <> 'PENDING' THEN RAISE EXCEPTION 'FAIL: followup_status default'; END IF;
  IF r.booking_status <> 'NONE'     THEN RAISE EXCEPTION 'FAIL: booking_status default'; END IF;
  IF r.budget_currency <> 'USD'     THEN RAISE EXCEPTION 'FAIL: currency default'; END IF;
  IF r.followup_step <> 0           THEN RAISE EXCEPTION 'FAIL: step default'; END IF;
  IF r.needs_human_review           THEN RAISE EXCEPTION 'FAIL: review default'; END IF;
  IF r.message_history <> '[]'::jsonb THEN RAISE EXCEPTION 'FAIL: message_history default'; END IF;
  IF r.next_followup_at IS NOT NULL THEN RAISE EXCEPTION 'FAIL: next_followup_at should be null'; END IF;
  IF r.replied_at IS NOT NULL       THEN RAISE EXCEPTION 'FAIL: replied_at should be null'; END IF;
  RAISE NOTICE 'PASS  1. insert + every default correct';
END $v$;

-- 2. dedupe_key UNIQUE actually blocks a second row -----------------------------
DO $v$
DECLARE cname text;
BEGIN
  INSERT INTO leads (source, email, message, dedupe_key)
  VALUES ('website', 'ada@example.com', 'Fired twice', 'email:ada@example.com');
  RAISE EXCEPTION 'FAIL: duplicate dedupe_key was accepted';
EXCEPTION WHEN unique_violation THEN
  GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
  IF cname <> 'leads_dedupe_key_unique' THEN
    RAISE EXCEPTION 'FAIL: wrong constraint fired: %', cname;
  END IF;
  RAISE NOTICE 'PASS  2. leads_dedupe_key_unique rejected duplicate (webhook twice -> one row)';
END $v$;

-- 3. ON CONFLICT upsert path from spec 7 ----------------------------------------
DO $v$
DECLARE n_rows int; hist jsonb;
BEGIN
  INSERT INTO leads (source, email, message, dedupe_key, company)
  VALUES ('website', 'ada@example.com', 'Second message', 'email:ada@example.com', 'Analytical Eng')
  ON CONFLICT (dedupe_key) DO UPDATE
    SET company         = COALESCE(EXCLUDED.company, leads.company),
        message_history = leads.message_history || to_jsonb(EXCLUDED.message);
  SELECT count(*) INTO n_rows FROM leads WHERE dedupe_key = 'email:ada@example.com';
  SELECT message_history INTO hist FROM leads WHERE dedupe_key = 'email:ada@example.com';
  IF n_rows <> 1 THEN RAISE EXCEPTION 'FAIL: upsert created a second row'; END IF;
  IF jsonb_array_length(hist) <> 1 THEN RAISE EXCEPTION 'FAIL: message_history not appended'; END IF;
  RAISE NOTICE 'PASS  3. ON CONFLICT merges into one row and appends message_history';
END $v$;

-- 4. updated_at trigger ---------------------------------------------------------
DO $v$
DECLARE before_ts timestamptz; after_ts timestamptz;
BEGIN
  SELECT updated_at INTO before_ts FROM leads WHERE dedupe_key = 'email:ada@example.com';
  PERFORM pg_sleep(0.01);
  UPDATE leads SET assigned_to = 'grace' WHERE dedupe_key = 'email:ada@example.com';
  SELECT updated_at INTO after_ts FROM leads WHERE dedupe_key = 'email:ada@example.com';
  IF after_ts <= before_ts THEN RAISE EXCEPTION 'FAIL: updated_at trigger did not fire'; END IF;
  RAISE NOTICE 'PASS  4. updated_at trigger fires on UPDATE';
END $v$;

-- 5. notifications idempotency guard --------------------------------------------
DO $v$
DECLARE lid uuid; cname text;
BEGIN
  SELECT lead_id INTO lid FROM leads WHERE dedupe_key = 'email:ada@example.com';
  INSERT INTO notifications (lead_id, kind, step) VALUES (lid, 'SLACK_HOT', 0);
  BEGIN
    INSERT INTO notifications (lead_id, kind, step) VALUES (lid, 'SLACK_HOT', 0);
    RAISE EXCEPTION 'FAIL: duplicate notification was accepted';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
    IF cname <> 'notifications_unique_send' THEN
      RAISE EXCEPTION 'FAIL: wrong constraint fired: %', cname;
    END IF;
    RAISE NOTICE 'PASS  5. notifications_unique_send rejected duplicate (no double-send)';
  END;
  INSERT INTO notifications (lead_id, kind, step) VALUES (lid, 'FOLLOWUP', 0);
  INSERT INTO notifications (lead_id, kind, step) VALUES (lid, 'FOLLOWUP', 1);
  RAISE NOTICE 'PASS  5b. different kind/step still allowed';
END $v$;

-- 6. Every CHECK constraint, proved by name --------------------------------------
--
-- Each case below feeds one deliberately invalid value and records which named
-- constraint rejected it. Asserting on the constraint NAME (not merely that
-- something failed) is what makes this proof rather than coincidence.
DO $v$
DECLARE
  lid      uuid;
  cname    text;
  fired    text[] := '{}';
  missing  text[];
  expected text[] := ARRAY[
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
    'notifications_step_check'
  ];
BEGIN
  SELECT lead_id INTO lid FROM leads WHERE dedupe_key = 'email:ada@example.com';

  BEGIN UPDATE leads SET lead_score = 150 WHERE lead_id = lid;
        RAISE EXCEPTION 'FAIL: lead_score 150 accepted';
  EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME; fired := fired || cname; END;

  BEGIN UPDATE leads SET lead_score = -1 WHERE lead_id = lid;
        RAISE EXCEPTION 'FAIL: lead_score -1 accepted';
  EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME; fired := fired || cname; END;

  BEGIN UPDATE leads SET crm_status = 'BOGUS' WHERE lead_id = lid;
        RAISE EXCEPTION 'FAIL: bogus crm_status accepted';
  EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME; fired := fired || cname; END;

  BEGIN UPDATE leads SET lead_temperature = 'TEPID' WHERE lead_id = lid;
        RAISE EXCEPTION 'FAIL: bogus temperature accepted';
  EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME; fired := fired || cname; END;

  BEGIN UPDATE leads SET followup_status = 'WAITING' WHERE lead_id = lid;
        RAISE EXCEPTION 'FAIL: bogus followup_status accepted';
  EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME; fired := fired || cname; END;

  BEGIN UPDATE leads SET followup_step = -1 WHERE lead_id = lid;
        RAISE EXCEPTION 'FAIL: negative followup_step accepted';
  EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME; fired := fired || cname; END;

  BEGIN UPDATE leads SET booking_status = 'MAYBE' WHERE lead_id = lid;
        RAISE EXCEPTION 'FAIL: bogus booking_status accepted';
  EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME; fired := fired || cname; END;

  BEGIN INSERT INTO leads (source, dedupe_key) VALUES ('carrier-pigeon', 'x:1');
        RAISE EXCEPTION 'FAIL: bogus source accepted';
  EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME; fired := fired || cname; END;

  BEGIN UPDATE leads SET message_history = to_jsonb('not an array'::text) WHERE lead_id = lid;
        RAISE EXCEPTION 'FAIL: non-array message_history accepted';
  EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME; fired := fired || cname; END;

  BEGIN INSERT INTO lead_events (lead_id, event_type, status) VALUES (lid, 'MADE_UP_EVENT', 'SUCCESS');
        RAISE EXCEPTION 'FAIL: bogus event_type accepted';
  EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME; fired := fired || cname; END;

  BEGIN INSERT INTO lead_events (lead_id, event_type, status) VALUES (lid, 'LEAD_RECEIVED', 'MAYBE');
        RAISE EXCEPTION 'FAIL: bogus event status accepted';
  EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME; fired := fired || cname; END;

  BEGIN INSERT INTO notifications (lead_id, kind, step) VALUES (lid, 'CARRIER_PIGEON', 0);
        RAISE EXCEPTION 'FAIL: bogus notification kind accepted';
  EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME; fired := fired || cname; END;

  BEGIN INSERT INTO notifications (lead_id, kind, step) VALUES (lid, 'FOLLOWUP', -1);
        RAISE EXCEPTION 'FAIL: negative notification step accepted';
  EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME; fired := fired || cname; END;

  SELECT array_agg(e) INTO missing FROM unnest(expected) e WHERE e <> ALL (fired);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: these CHECK constraints never fired: %', missing;
  END IF;

  RAISE NOTICE 'PASS  6. all % CHECK constraints fired by name across % negative cases',
    array_length(expected, 1), array_length(fired, 1);
END $v$;

-- 7. Audit log survives a lead that never existed --------------------------------
DO $v$
BEGIN
  INSERT INTO lead_events (lead_id, event_type, status, error_message)
  VALUES (NULL, 'VALIDATION_FAILED', 'FAILURE', 'malformed email, no lead row created');
  RAISE NOTICE 'PASS  7. lead_events accepts NULL lead_id (pre-lead failures auditable)';
END $v$;

-- 8. Scheduler query uses the partial index --------------------------------------
UPDATE leads SET followup_status = 'IN_PROGRESS', next_followup_at = now() - interval '1 hour'
WHERE dedupe_key = 'email:ada@example.com';

EXPLAIN (COSTS OFF)
SELECT * FROM leads
 WHERE next_followup_at <= now()
   AND followup_status = 'IN_PROGRESS'
   AND booking_status <> 'BOOKED'
   AND crm_status NOT IN ('LOST','BOOKED');

-- 9. Inventory --------------------------------------------------------------------
SELECT t.table_name,
       (SELECT count(*) FROM information_schema.columns c
         WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS columns
FROM information_schema.tables t
WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
ORDER BY t.table_name;

SELECT contype, count(*) AS n
FROM pg_constraint
WHERE conrelid IN ('leads'::regclass, 'lead_events'::regclass, 'notifications'::regclass)
  AND contype IN ('u', 'c', 'f', 'p')
GROUP BY contype
ORDER BY contype;
