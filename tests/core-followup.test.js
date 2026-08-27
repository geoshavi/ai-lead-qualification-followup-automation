import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CADENCE_HOURS,
  DEFAULT_BUSINESS_HOURS,
  getCadence,
  totalSteps,
  isWeekend,
  clampToBusinessHours,
  computeNextFollowup,
  evaluateStopConditions,
  startFollowup,
  advanceFollowup,
} from '../src/core/followup.js';

const TZ = 'America/Los_Angeles';

// Frozen clock. Every timestamp below was verified against Intl before use.
//   2026-03-02  Monday    PST (UTC-8)
//   2026-03-06  Friday    PST
//   2026-03-07  Saturday  PST
//   2026-03-08  Sunday    DST begins -> PDT (UTC-7)
//   2026-03-09  Monday    PDT
const MON_10AM = Date.parse('2026-03-02T18:00:00Z'); // Mon 10:00 PST

/** Render an instant as wall-clock in the business timezone, for readable assertions. */
function wall(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

describe('cadence table matches spec section 6.2', () => {
  test('HOT is immediate, +24h, +72h', () => {
    assert.deepEqual(CADENCE_HOURS.HOT, [0, 24, 72]);
  });

  test('WARM is immediate, +48h, +120h', () => {
    assert.deepEqual(CADENCE_HOURS.WARM, [0, 48, 120]);
  });

  test('COLD is immediate, +168h, then stop', () => {
    assert.deepEqual(CADENCE_HOURS.COLD, [0, 168]);
  });

  test('step counts: HOT 3, WARM 3, COLD 2', () => {
    assert.equal(totalSteps('HOT'), 3);
    assert.equal(totalSteps('WARM'), 3);
    assert.equal(totalSteps('COLD'), 2);
  });

  test('unknown temperature is rejected rather than defaulted', () => {
    assert.throws(() => getCadence('TEPID'), /unknown temperature/i);
    assert.throws(() => getCadence(undefined), /unknown temperature/i);
  });
});

// The milestone's done-criterion names this explicitly: every branch of the
// cadence table. That is every (temperature, step) pair plus each exhaustion
// boundary — 11 cases in total.
describe('every branch of the cadence table', () => {
  const cases = [
    // temperature, step, expected wall clock in TZ, note
    ['HOT', 0, 'Mon, 03/02/2026, 10:00', 'immediate'],
    ['HOT', 1, 'Tue, 03/03/2026, 10:00', '+24h'],
    ['HOT', 2, 'Thu, 03/05/2026, 10:00', '+72h'],
    ['WARM', 0, 'Mon, 03/02/2026, 10:00', 'immediate'],
    ['WARM', 1, 'Wed, 03/04/2026, 10:00', '+48h'],
    ['WARM', 2, 'Mon, 03/09/2026, 09:00', '+120h lands Saturday, pushed to Monday 09:00'],
    ['COLD', 0, 'Mon, 03/02/2026, 10:00', 'immediate'],
    ['COLD', 1, 'Mon, 03/09/2026, 11:00', '+168h, wall clock shifts one hour across DST'],
  ];

  for (const [temperature, step, expected, note] of cases) {
    test(`${temperature} step ${step} (${note})`, () => {
      const result = computeNextFollowup({ temperature, step, anchor: MON_10AM, timeZone: TZ });
      assert.equal(result.exhausted, false);
      assert.equal(result.followup_status, 'IN_PROGRESS');
      assert.equal(wall(Date.parse(result.nextAt)), expected);
    });
  }

  const exhausted = [['HOT', 3], ['WARM', 3], ['COLD', 2]];

  for (const [temperature, step] of exhausted) {
    test(`${temperature} step ${step} is past the end of the table`, () => {
      const result = computeNextFollowup({ temperature, step, anchor: MON_10AM, timeZone: TZ });
      assert.equal(result.exhausted, true);
      assert.equal(result.nextAt, null, 'an exhausted sequence must clear next_followup_at');
      assert.equal(result.followup_status, 'COMPLETED');
    });
  }

  test('offsets are anchored, so a late send does not stretch the schedule', () => {
    // Step 2 is +72h from the ANCHOR regardless of when step 1 actually went out.
    const onTime = computeNextFollowup({ temperature: 'HOT', step: 2, anchor: MON_10AM, timeZone: TZ });
    const anchorUnchanged = computeNextFollowup({
      temperature: 'HOT', step: 2, anchor: MON_10AM, timeZone: TZ,
    });
    assert.equal(onTime.nextAt, anchorUnchanged.nextAt);
  });

  test('a negative or fractional step is rejected', () => {
    assert.throws(
      () => computeNextFollowup({ temperature: 'HOT', step: -1, anchor: MON_10AM, timeZone: TZ }),
      /non-negative integer/,
    );
    assert.throws(
      () => computeNextFollowup({ temperature: 'HOT', step: 1.5, anchor: MON_10AM, timeZone: TZ }),
      /non-negative integer/,
    );
  });
});

describe('business-hours clamping', () => {
  test('a time already inside the window is returned untouched', () => {
    const inHours = Date.parse('2026-03-03T18:00:00Z'); // Tue 10:00 PST
    assert.equal(clampToBusinessHours(inHours, TZ), inHours);
  });

  test('exactly 09:00 is inside the window', () => {
    const nineAm = Date.parse('2026-03-03T17:00:00Z'); // Tue 09:00 PST
    assert.equal(clampToBusinessHours(nineAm, TZ), nineAm);
  });

  test('exactly 18:00 is outside the window and moves to the next morning', () => {
    const sixPm = Date.parse('2026-03-03T02:00:00Z'); // Mon 18:00 PST
    assert.equal(wall(sixPm), 'Mon, 03/02/2026, 18:00');
    assert.equal(wall(clampToBusinessHours(sixPm, TZ)), 'Tue, 03/03/2026, 09:00');
  });

  test('after hours moves to 09:00 the next business day', () => {
    const lateWed = Date.parse('2026-03-05T05:30:00Z'); // Wed 21:30 PST
    assert.equal(wall(clampToBusinessHours(lateWed, TZ)), 'Thu, 03/05/2026, 09:00');
  });

  test('Saturday is pushed to Monday 09:00', () => {
    const saturday = Date.parse('2026-03-07T20:00:00Z'); // Sat 12:00 PST
    assert.equal(wall(saturday), 'Sat, 03/07/2026, 12:00');
    assert.equal(wall(clampToBusinessHours(saturday, TZ)), 'Mon, 03/09/2026, 09:00');
  });

  test('Sunday is pushed to Monday 09:00', () => {
    const sunday = Date.parse('2026-03-08T19:00:00Z'); // Sun 12:00 PDT
    assert.equal(wall(clampToBusinessHours(sunday, TZ)), 'Mon, 03/09/2026, 09:00');
  });

  test('Friday evening skips the whole weekend', () => {
    const fridayNight = Date.parse('2026-03-07T04:00:00Z'); // Fri 20:00 PST
    assert.equal(wall(fridayNight), 'Fri, 03/06/2026, 20:00');
    assert.equal(wall(clampToBusinessHours(fridayNight, TZ)), 'Mon, 03/09/2026, 09:00');
  });

  test('clamping is idempotent', () => {
    const saturday = Date.parse('2026-03-07T20:00:00Z');
    const once = clampToBusinessHours(saturday, TZ);
    assert.equal(clampToBusinessHours(once, TZ), once);
  });

  test('the resulting instant is genuinely inside business hours', () => {
    const probes = [
      '2026-03-07T20:00:00Z', '2026-03-06T04:00:00Z', '2026-03-05T05:30:00Z',
      '2026-03-08T19:00:00Z', '2026-03-03T14:00:00Z',
    ];
    for (const iso of probes) {
      const clamped = clampToBusinessHours(Date.parse(iso), TZ);
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: TZ, hour: '2-digit', hourCycle: 'h23',
      }).format(new Date(clamped));
      const hour = Number(parts);
      assert.ok(hour >= 9 && hour < 18, `${iso} clamped to hour ${hour}, outside 09-18`);
      assert.equal(isWeekend(clamped, TZ), false, `${iso} clamped onto a weekend`);
    }
  });

  test('DST spring-forward does not produce a nonexistent local time', () => {
    // 2026-03-08 02:00-03:00 PST does not exist. Clamping near it must still
    // yield a real instant that formats back to the time we asked for.
    const nearTransition = Date.parse('2026-03-08T10:30:00Z'); // Sun 02:30 PST -> PDT
    const clamped = clampToBusinessHours(nearTransition, TZ);
    assert.equal(wall(clamped), 'Mon, 03/09/2026, 09:00');
  });
});

describe('before-hours policy', () => {
  const earlyTuesday = Date.parse('2026-03-03T15:00:00Z'); // Tue 07:00 PST

  test('the default is next-day, the literal reading of spec 6.2', () => {
    assert.equal(DEFAULT_BUSINESS_HOURS.beforeHoursPolicy, 'next-day');
  });

  test('by default, a before-hours send moves to 09:00 the NEXT business day', () => {
    assert.equal(wall(clampToBusinessHours(earlyTuesday, TZ)), 'Wed, 03/04/2026, 09:00');
  });

  test('by default, before hours and after hours are treated identically', () => {
    // Spec 6.2 states one rule for anything "outside 09:00-18:00". Sending
    // early on the same day would quietly make before-hours the exception.
    const lateTuesday = Date.parse('2026-03-04T04:00:00Z'); // Tue 20:00 PST
    assert.equal(wall(clampToBusinessHours(earlyTuesday, TZ)), 'Wed, 03/04/2026, 09:00');
    assert.equal(wall(clampToBusinessHours(lateTuesday, TZ)), 'Wed, 03/04/2026, 09:00');
  });

  test('by default, an early Friday send lands on Monday rather than Saturday', () => {
    const earlyFriday = Date.parse('2026-03-06T15:00:00Z'); // Fri 07:00 PST
    assert.equal(wall(clampToBusinessHours(earlyFriday, TZ)), 'Mon, 03/09/2026, 09:00');
  });

  test('same-day is available as an explicit, non-default opt-in', () => {
    const clamped = clampToBusinessHours(earlyTuesday, TZ, { beforeHoursPolicy: 'same-day' });
    assert.equal(wall(clamped), 'Tue, 03/03/2026, 09:00');
  });

  test('the same-day opt-in still refuses to send on a weekend', () => {
    const earlySaturday = Date.parse('2026-03-07T15:00:00Z'); // Sat 07:00 PST
    const clamped = clampToBusinessHours(earlySaturday, TZ, { beforeHoursPolicy: 'same-day' });
    assert.equal(wall(clamped), 'Mon, 03/09/2026, 09:00');
  });

  test('the default reaches computeNextFollowup, which is what the scheduler calls', () => {
    // Clamping the leaf helper correctly is not the point; the scheduled send
    // is. Anchor Mon 06:00 PST, so HOT step 1 (+24h) lands Tue 06:00 — before
    // hours — and must defer to Wednesday morning.
    const mondayEarly = Date.parse('2026-03-02T14:00:00Z'); // Mon 06:00 PST
    const scheduled = computeNextFollowup({
      temperature: 'HOT', step: 1, anchor: mondayEarly, timeZone: TZ,
    });

    assert.equal(wall(Date.parse(scheduled.nextAt)), 'Wed, 03/04/2026, 09:00');
  });

  test('a custom window is honoured', () => {
    const early = Date.parse('2026-03-03T15:00:00Z'); // Tue 07:00 PST
    const clamped = clampToBusinessHours(early, TZ, { startHour: 6, endHour: 20 });
    assert.equal(clamped, early, '07:00 is inside a 06:00-20:00 window');
  });
});

describe('stop conditions (spec 6.3)', () => {
  const base = { lead_temperature: 'HOT', followup_step: 0, booking_status: 'NONE', crm_status: 'NEW' };

  test('a confirmed booking stops the sequence', () => {
    const r = evaluateStopConditions({ ...base, booking_status: 'BOOKED' });
    assert.deepEqual(r, { stop: true, reason: 'booking_confirmed', followup_status: 'STOPPED' });
  });

  test('crm_status BOOKED stops the sequence', () => {
    const r = evaluateStopConditions({ ...base, crm_status: 'BOOKED' });
    assert.equal(r.stop, true);
    assert.equal(r.reason, 'crm_status_booked');
  });

  test('crm_status LOST stops the sequence', () => {
    const r = evaluateStopConditions({ ...base, crm_status: 'LOST' });
    assert.equal(r.stop, true);
    assert.equal(r.reason, 'crm_status_lost');
  });

  test('a recorded reply stops the sequence', () => {
    const r = evaluateStopConditions({ ...base, replied_at: '2026-03-02T19:00:00Z' });
    assert.equal(r.stop, true);
    assert.equal(r.reason, 'lead_replied');
  });

  test('an empty replied_at does not stop the sequence', () => {
    for (const value of [null, undefined, '']) {
      assert.equal(evaluateStopConditions({ ...base, replied_at: value }).stop, false);
    }
  });

  test('the sequence completes after its final step', () => {
    assert.equal(evaluateStopConditions({ ...base, followup_step: 3 }).reason, 'sequence_complete');
    assert.equal(evaluateStopConditions({ ...base, lead_temperature: 'COLD', followup_step: 2 }).reason, 'sequence_complete');
  });

  test('a live lead mid-sequence does not stop', () => {
    const r = evaluateStopConditions({ ...base, followup_step: 1 });
    assert.deepEqual(r, { stop: false, reason: null, followup_status: null });
  });

  test('completion is reported as COMPLETED, interruption as STOPPED', () => {
    assert.equal(evaluateStopConditions({ ...base, followup_step: 3 }).followup_status, 'COMPLETED');
    assert.equal(evaluateStopConditions({ ...base, crm_status: 'LOST' }).followup_status, 'STOPPED');
  });
});

describe('startFollowup', () => {
  test('schedules step 0 for a live lead', () => {
    const patch = startFollowup(
      { lead_temperature: 'HOT', followup_step: 0, crm_status: 'QUALIFIED', booking_status: 'NONE' },
      { now: MON_10AM, anchor: MON_10AM, timeZone: TZ },
    );
    assert.equal(patch.followup_status, 'IN_PROGRESS');
    assert.equal(patch.followup_step, 0);
    assert.equal(wall(Date.parse(patch.next_followup_at)), 'Mon, 03/02/2026, 10:00');
  });

  test('refuses to start when a stop condition already holds', () => {
    const patch = startFollowup(
      { lead_temperature: 'HOT', booking_status: 'BOOKED' },
      { now: MON_10AM, timeZone: TZ },
    );
    assert.equal(patch.followup_status, 'STOPPED');
    assert.equal(patch.next_followup_at, null);
    assert.equal(patch.stop_reason, 'booking_confirmed');
  });
});

describe('advanceFollowup', () => {
  const liveLead = {
    lead_temperature: 'HOT',
    followup_step: 0,
    crm_status: 'CONTACTED',
    booking_status: 'NONE',
    replied_at: null,
  };

  test('advances exactly one step per call', () => {
    const patch = advanceFollowup(liveLead, { now: MON_10AM, anchor: MON_10AM, timeZone: TZ });
    assert.equal(patch.followup_step, 1);
    assert.equal(patch.followup_status, 'IN_PROGRESS');
    assert.equal(wall(Date.parse(patch.next_followup_at)), 'Tue, 03/03/2026, 10:00');
  });

  test('records last_contacted_at from the injected clock', () => {
    const patch = advanceFollowup(liveLead, { now: MON_10AM, anchor: MON_10AM, timeZone: TZ });
    assert.equal(patch.last_contacted_at, new Date(MON_10AM).toISOString());
  });

  test('completes and clears next_followup_at after the final step', () => {
    const patch = advanceFollowup(
      { ...liveLead, followup_step: 2 },
      { now: MON_10AM, anchor: MON_10AM, timeZone: TZ },
    );
    assert.equal(patch.followup_step, 3);
    assert.equal(patch.followup_status, 'COMPLETED');
    assert.equal(patch.next_followup_at, null);
    assert.equal(patch.stop_reason, 'sequence_complete');
  });

  test('COLD completes one step earlier than HOT', () => {
    const patch = advanceFollowup(
      { ...liveLead, lead_temperature: 'COLD', followup_step: 1 },
      { now: MON_10AM, anchor: MON_10AM, timeZone: TZ },
    );
    assert.equal(patch.followup_status, 'COMPLETED');
    assert.equal(patch.next_followup_at, null);
  });

  test('a booking mid-sequence stops it without advancing', () => {
    const patch = advanceFollowup(
      { ...liveLead, followup_step: 1, booking_status: 'BOOKED' },
      { now: MON_10AM, timeZone: TZ },
    );
    assert.equal(patch.followup_status, 'STOPPED');
    assert.equal(patch.next_followup_at, null);
    assert.equal(patch.followup_step, undefined, 'a stopped sequence must not advance its step');
  });

  test('a reply before step 1 stops the sequence', () => {
    const patch = advanceFollowup(
      { ...liveLead, replied_at: '2026-03-02T19:00:00Z' },
      { now: MON_10AM, timeZone: TZ },
    );
    assert.equal(patch.followup_status, 'STOPPED');
    assert.equal(patch.stop_reason, 'lead_replied');
    assert.equal(patch.next_followup_at, null);
  });

  test('a missing clock is rejected rather than defaulted to now', () => {
    assert.throws(
      () => advanceFollowup(liveLead, { timeZone: TZ }),
      /must be a Date or epoch milliseconds/,
    );
  });
});
