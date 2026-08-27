/**
 * followup.js — deterministic follow-up scheduling.
 *
 * ZERO IMPORTS (see schema.js for why). Timezone handling uses Intl, which is a
 * language builtin rather than a module, so it survives concatenation into a
 * Code node.
 *
 * Nothing here reads the clock. Every entry point takes `now` or `baseTime`
 * explicitly, which is what makes business-hours behaviour testable against a
 * frozen clock instead of only at 3pm on a Tuesday.
 *
 * The LLM writes message wording. This file decides whether to send, when to
 * send, and which step it is. That separation is the point.
 */

/**
 * Cadence table from spec section 6.2, in hours from the sequence ANCHOR.
 *
 *   HOT   step 0 immediate, step 1 +24h,  step 2 +72h
 *   WARM  step 0 immediate, step 1 +48h,  step 2 +120h
 *   COLD  step 0 immediate, step 1 +168h, then stop
 *
 * Offsets are measured from a single anchor (when the lead was scored), NOT
 * from whenever the previous message happened to go out. If the scheduler is
 * down for six hours, an anchored schedule catches up; a relative one silently
 * stretches every subsequent step by the delay.
 */
export const CADENCE_HOURS = Object.freeze({
  HOT: Object.freeze([0, 24, 72]),
  WARM: Object.freeze([0, 48, 120]),
  COLD: Object.freeze([0, 168]),
});

/** Business-hours window and weekend policy. */
export const DEFAULT_BUSINESS_HOURS = Object.freeze({
  startHour: 9,
  endHour: 18,
  // What to do with a send computed BEFORE the window opens.
  //
  // 'next-day' is the default because spec section 6.2 says it plainly: a time
  // outside 09:00-18:00 moves to "09:00 on the next business day". 07:00
  // Tuesday becomes 09:00 Wednesday. Before-hours and after-hours are the same
  // rule, so they get the same treatment.
  //
  // 'same-day' (07:00 Tuesday -> 09:00 Tuesday) is available as an explicit
  // opt-in for a client who wants the earliest slot rather than the next day.
  // It is deliberately not the default: that would be a nicer-sounding rule
  // than the one the spec actually states.
  beforeHoursPolicy: 'next-day',
});

const MS_PER_HOUR = 3600000;

/** Break an instant into wall-clock parts for a timezone. */
function getZonedParts(ms, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = {};
  for (const { type, value } of dtf.formatToParts(new Date(ms))) {
    parts[type] = value;
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset in ms between a timezone's wall clock and UTC at a given instant. */
function getOffsetMs(ms, timeZone) {
  const p = getZonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Convert wall-clock parts in a timezone back to a UTC instant.
 *
 * Two passes: guess an offset, then re-read it at the candidate instant. The
 * second pass is what keeps this correct across DST transitions, where the
 * offset at the guess differs from the offset at the answer.
 */
function zonedPartsToUtc(p, timeZone) {
  const guess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute ?? 0, p.second ?? 0);
  const offset = getOffsetMs(guess, timeZone);
  const candidate = guess - offset;
  const settled = getOffsetMs(candidate, timeZone);
  return settled === offset ? candidate : guess - settled;
}

/** Day of week for zoned parts. 0 = Sunday, 6 = Saturday. */
function zonedDayOfWeek(p) {
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** Shift a date by whole days, letting Date normalise month and year rollover. */
function addDays(p, n) {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** True for Saturday or Sunday in the given timezone. */
export function isWeekend(instantMs, timeZone) {
  const dow = zonedDayOfWeek(getZonedParts(instantMs, timeZone));
  return dow === 0 || dow === 6;
}

/**
 * Move an instant into the next valid business-hours slot.
 *
 * The window is treated as [startHour, endHour) — a send computed for exactly
 * 18:00 is out of hours and moves to the next business morning.
 *
 * @param {number} instantMs
 * @param {string} timeZone IANA zone, e.g. 'America/Los_Angeles'
 * @param {{startHour?: number, endHour?: number, beforeHoursPolicy?: 'same-day'|'next-day'}} [options]
 * @returns {number} epoch ms, unchanged when already in hours
 */
export function clampToBusinessHours(instantMs, timeZone, options) {
  const startHour = options?.startHour ?? DEFAULT_BUSINESS_HOURS.startHour;
  const endHour = options?.endHour ?? DEFAULT_BUSINESS_HOURS.endHour;
  const policy = options?.beforeHoursPolicy ?? DEFAULT_BUSINESS_HOURS.beforeHoursPolicy;

  let p = getZonedParts(instantMs, timeZone);
  let moved = false;

  // Bounded: at most a weekend plus a few hops. The guard exists so a bad
  // timezone can never spin forever inside a scheduler run.
  for (let guard = 0; guard < 14; guard += 1) {
    const dow = zonedDayOfWeek(p);

    if (dow === 0 || dow === 6) {
      p = { ...addDays(p, 1), hour: startHour, minute: 0, second: 0 };
      moved = true;
      continue;
    }

    if (p.hour < startHour) {
      if (policy === 'same-day') {
        p = { year: p.year, month: p.month, day: p.day, hour: startHour, minute: 0, second: 0 };
        moved = true;
        break;
      }
      p = { ...addDays(p, 1), hour: startHour, minute: 0, second: 0 };
      moved = true;
      continue;
    }

    if (p.hour >= endHour) {
      p = { ...addDays(p, 1), hour: startHour, minute: 0, second: 0 };
      moved = true;
      continue;
    }

    break;
  }

  return moved ? zonedPartsToUtc(p, timeZone) : instantMs;
}

/** Hour offsets for a temperature band. */
export function getCadence(temperature) {
  const cadence = CADENCE_HOURS[temperature];
  if (!cadence) {
    throw new Error(
      `getCadence: unknown temperature "${temperature}". Expected HOT, WARM or COLD.`,
    );
  }
  return cadence;
}

/** Total sends defined for a temperature band. */
export function totalSteps(temperature) {
  return getCadence(temperature).length;
}

function toMs(value, label) {
  const ms = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(ms)) {
    throw new TypeError(`${label} must be a Date or epoch milliseconds`);
  }
  return ms;
}

/**
 * When should the given step be sent?
 *
 * @param {{temperature: string, step: number, anchor: Date|number,
 *          timeZone: string, businessHours?: object}} input
 * @returns {{nextAt: string|null, followup_status: string, step: number, exhausted: boolean}}
 */
export function computeNextFollowup(input) {
  const { temperature, step, anchor, timeZone } = input;
  const cadence = getCadence(temperature);

  if (!Number.isInteger(step) || step < 0) {
    throw new TypeError('computeNextFollowup: step must be a non-negative integer');
  }

  // Past the end of the table: the sequence is finished, not merely idle.
  if (step >= cadence.length) {
    return { nextAt: null, followup_status: 'COMPLETED', step, exhausted: true };
  }

  const anchorMs = toMs(anchor, 'computeNextFollowup: anchor');
  const target = anchorMs + cadence[step] * MS_PER_HOUR;
  const clamped = clampToBusinessHours(target, timeZone, input.businessHours);

  return {
    nextAt: new Date(clamped).toISOString(),
    followup_status: 'IN_PROGRESS',
    step,
    exhausted: false,
  };
}

/**
 * Should the sequence stop for this lead?
 *
 * Stop conditions from spec section 6.3. Order matters only for which reason is
 * reported; any single match stops the sequence.
 *
 * @returns {{stop: boolean, reason: string|null, followup_status: string|null}}
 */
export function evaluateStopConditions(lead) {
  const l = lead ?? {};

  if (l.booking_status === 'BOOKED') {
    return { stop: true, reason: 'booking_confirmed', followup_status: 'STOPPED' };
  }
  if (l.crm_status === 'BOOKED') {
    return { stop: true, reason: 'crm_status_booked', followup_status: 'STOPPED' };
  }
  if (l.crm_status === 'LOST') {
    return { stop: true, reason: 'crm_status_lost', followup_status: 'STOPPED' };
  }
  if (l.replied_at !== null && l.replied_at !== undefined && l.replied_at !== '') {
    return { stop: true, reason: 'lead_replied', followup_status: 'STOPPED' };
  }

  // Final step already sent: a natural finish, not an interruption.
  if (typeof l.lead_temperature === 'string' && CADENCE_HOURS[l.lead_temperature]) {
    const total = totalSteps(l.lead_temperature);
    const step = Number(l.followup_step ?? 0);
    if (Number.isFinite(step) && step >= total) {
      return { stop: true, reason: 'sequence_complete', followup_status: 'COMPLETED' };
    }
  }

  return { stop: false, reason: null, followup_status: null };
}

/**
 * Start the sequence for a freshly scored lead.
 *
 * @returns {object} patch for the leads row
 */
export function startFollowup(lead, options) {
  const stop = evaluateStopConditions(lead);
  if (stop.stop) {
    return {
      followup_status: stop.followup_status,
      next_followup_at: null,
      stop_reason: stop.reason,
    };
  }

  const scheduled = computeNextFollowup({
    temperature: lead.lead_temperature,
    step: 0,
    anchor: options.anchor ?? options.now,
    timeZone: options.timeZone,
    businessHours: options.businessHours,
  });

  return {
    followup_status: scheduled.followup_status,
    followup_step: 0,
    next_followup_at: scheduled.nextAt,
    stop_reason: null,
  };
}

/**
 * Advance the sequence after a message has gone out.
 *
 * The caller is responsible for having actually sent (and for the notifications
 * idempotency insert). This function only moves the state forward.
 *
 * @param {object} lead current row
 * @param {{now: Date|number, anchor?: Date|number, timeZone: string, businessHours?: object}} options
 * @returns {object} patch for the leads row
 */
export function advanceFollowup(lead, options) {
  const stop = evaluateStopConditions(lead);
  if (stop.stop) {
    return {
      followup_status: stop.followup_status,
      next_followup_at: null,
      stop_reason: stop.reason,
    };
  }

  const nowMs = toMs(options.now, 'advanceFollowup: now');
  const currentStep = Number(lead?.followup_step ?? 0);
  const nextStep = currentStep + 1;

  const scheduled = computeNextFollowup({
    temperature: lead.lead_temperature,
    step: nextStep,
    anchor: options.anchor ?? nowMs,
    timeZone: options.timeZone,
    businessHours: options.businessHours,
  });

  if (scheduled.exhausted) {
    return {
      followup_step: nextStep,
      followup_status: 'COMPLETED',
      next_followup_at: null,
      last_contacted_at: new Date(nowMs).toISOString(),
      stop_reason: 'sequence_complete',
    };
  }

  return {
    followup_step: nextStep,
    followup_status: 'IN_PROGRESS',
    next_followup_at: scheduled.nextAt,
    last_contacted_at: new Date(nowMs).toISOString(),
    stop_reason: null,
  };
}
