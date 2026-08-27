/**
 * normalize.js — source payload to canonical lead fields.
 *
 * ZERO IMPORTS (see schema.js for why).
 *
 * Returns only the fields it can derive. It deliberately does NOT apply
 * defaults; the caller composes with createLead() from schema.js. Keeping
 * defaults in exactly one place is what stops the mock adapter and Postgres
 * from drifting apart.
 *
 * Section 5 of the spec requires three payload shapes to produce byte-identical
 * canonical output for the same person. The per-source mappers below are the
 * only place shape differences are allowed to exist; everything after
 * toCanonicalFields is shape-agnostic.
 */

/** Currency symbols this project recognises, longest match first. */
const CURRENCY_SYMBOLS = Object.freeze([
  ['$', 'USD'],
  ['£', 'GBP'],
  ['€', 'EUR'],
  ['¥', 'JPY'],
]);

const CURRENCY_CODES = /\b(USD|EUR|GBP|CAD|AUD|JPY|CHF|NZD|SEK|INR)\b/i;

/** Trim, collapse internal whitespace, and return null for empty. */
export function normalizeWhitespace(raw) {
  if (typeof raw !== 'string') return null;
  const out = raw.replace(/\s+/g, ' ').trim();
  return out === '' ? null : out;
}

/**
 * Lowercase and trim an email.
 *
 * Normalisation only — validity is validate.js's job. A malformed address must
 * still normalise consistently so the same bad input always produces the same
 * dedupe key rather than a new row per submission.
 */
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const out = raw.trim().toLowerCase().replace(/\s+/g, '');
  return out === '' ? null : out;
}

/** Normalise a person or company name. */
export function normalizeName(raw) {
  return normalizeWhitespace(raw);
}

/**
 * Split a single full-name field into first and last.
 *
 * Everything after the first token becomes the surname, which is right for
 * "Ada Lovelace" and for "Ana Maria de la Cruz", and wrong for names that lead
 * with a family name. Sources that provide the parts separately are always
 * preferred over this fallback.
 */
export function splitFullName(raw) {
  const full = normalizeWhitespace(raw);
  if (full === null) return { first_name: null, last_name: null };

  const parts = full.split(' ');
  if (parts.length === 1) return { first_name: parts[0], last_name: null };

  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

/**
 * Convert a phone number to E.164 where that is derivable, else null.
 *
 * "Where derivable" is the operative constraint: a 7-digit local number cannot
 * be made into E.164 without inventing an area code, so it returns null rather
 * than guessing. Guessing would silently create a wrong dedupe key.
 *
 * @param {unknown} raw
 * @param {{defaultCountryCode?: string}} [options]
 */
export function normalizePhone(raw, options) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;

  const text = String(raw).trim();
  if (text === '') return null;

  const hasPlus = text.startsWith('+') || text.startsWith('00');
  const digits = text.replace(/\D/g, '');
  if (digits === '') return null;

  const defaultCc = String(options?.defaultCountryCode ?? '1');

  // Explicit international form: trust it, within E.164's 8-15 digit range.
  if (hasPlus) {
    const trimmed = text.startsWith('00') ? digits.replace(/^00/, '') : digits;
    if (trimmed.length < 8 || trimmed.length > 15) return null;
    return `+${trimmed}`;
  }

  // North American shapes, which is what the default business timezone implies.
  if (defaultCc === '1') {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return null;
  }

  // Other default countries: accept a national number of plausible length.
  if (digits.length >= 8 && digits.length <= 15) {
    const stripped = digits.replace(/^0+/, '');
    const candidate = `${defaultCc}${stripped}`;
    if (candidate.length >= 8 && candidate.length <= 15) return `+${candidate}`;
  }

  return null;
}

/**
 * Parse a free-text budget into an amount and currency.
 *
 * Ranges resolve to their LOWER bound. "10-15k" becomes 10000, not 12500 and
 * not 15000 — scoring on the optimistic end of a range would inflate lead
 * quality on the customer's vaguest input, which is exactly backwards.
 *
 * The original string is always preserved in budget_raw regardless of whether
 * parsing succeeded.
 *
 * @returns {{budget_raw: string|null, budget_amount: number|null, budget_currency: string}}
 */
export function parseBudget(raw, options) {
  const fallbackCurrency = options?.defaultCurrency ?? 'USD';
  const text = normalizeWhitespace(typeof raw === 'number' ? String(raw) : raw);

  if (text === null) {
    return { budget_raw: null, budget_amount: null, budget_currency: fallbackCurrency };
  }

  // Currency: an explicit code wins over a symbol.
  let currency = null;
  const codeMatch = text.match(CURRENCY_CODES);
  if (codeMatch) {
    currency = codeMatch[1].toUpperCase();
  } else {
    for (const [symbol, code] of CURRENCY_SYMBOLS) {
      if (text.includes(symbol)) { currency = code; break; }
    }
  }

  // Amount: first number, optionally with thousands separators and a k/m suffix.
  // Collect every number in the string, each with its own magnitude suffix.
  const tokens = [];
  for (const match of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([km])?/gi)) {
    const parsed = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(parsed)) {
      tokens.push({ value: parsed, suffix: (match[2] || '').toLowerCase() });
    }
  }

  let amount = null;

  if (tokens.length > 0) {
    const first = tokens[0];

    // A magnitude suffix on a later token governs the whole range: "10-15k"
    // means ten to fifteen thousand, not ten. Without this the lower bound
    // lands three orders of magnitude too small, quietly reclassifying a
    // serious lead as a trivial one.
    let suffix = first.suffix;
    if (suffix === '') {
      const later = tokens.slice(1).find((t) => t.suffix !== '');
      if (later) suffix = later.suffix;
    }

    const multiplier = suffix === 'k' ? 1000 : suffix === 'm' ? 1000000 : 1;
    amount = first.value * multiplier;
  }

  return {
    budget_raw: text,
    budget_amount: amount,
    budget_currency: currency ?? fallbackCurrency,
  };
}

/**
 * Shape-agnostic tail of normalisation.
 *
 * Every source mapper funnels through here, which is what guarantees three
 * payload shapes describing the same person produce identical canonical output.
 */
export function toCanonicalFields(fields, options) {
  const names = fields.full_name !== undefined && fields.full_name !== null
    ? splitFullName(fields.full_name)
    : { first_name: normalizeName(fields.first_name), last_name: normalizeName(fields.last_name) };

  const budget = parseBudget(fields.budget_raw, options);

  return {
    source: fields.source ?? null,
    source_id: normalizeWhitespace(fields.source_id),
    first_name: names.first_name,
    last_name: names.last_name,
    email: normalizeEmail(fields.email),
    phone: normalizePhone(fields.phone, options),
    company: normalizeName(fields.company),
    service_interest: normalizeWhitespace(fields.service_interest),
    timeline: normalizeWhitespace(fields.timeline),
    budget_raw: budget.budget_raw,
    budget_amount: budget.budget_amount,
    budget_currency: budget.budget_currency,
  };
}

/**
 * Website contact form.
 *
 * Field aliases are generous because form builders rename things freely, and a
 * renamed field silently becoming null is a data-loss bug that is invisible
 * until a lead goes missing.
 */
export function mapWebsitePayload(payload) {
  const p = payload ?? {};
  return {
    source: 'website',
    source_id: p.source_id ?? p.submission_id ?? p.id ?? null,
    full_name: p.full_name ?? p.name ?? null,
    first_name: p.first_name ?? p.firstName ?? null,
    last_name: p.last_name ?? p.lastName ?? null,
    email: p.email ?? p.email_address ?? null,
    phone: p.phone ?? p.phone_number ?? p.tel ?? null,
    company: p.company ?? p.company_name ?? p.organisation ?? p.organization ?? null,
    service_interest: p.service_interest ?? p.service ?? p.interest ?? null,
    message: p.message ?? p.comments ?? p.details ?? null,
    budget_raw: p.budget ?? p.budget_raw ?? p.budget_range ?? null,
    timeline: p.timeline ?? p.timeframe ?? p.when ?? null,
  };
}

/**
 * Source mappers.
 *
 * M4 ships the website slice. Meta lead ads and inbound email parsing are M5
 * and are deliberately absent rather than stubbed with guesswork — an
 * unimplemented source must fail loudly, not quietly produce a half-populated
 * lead that looks successful in the audit log.
 */
const SOURCE_MAPPERS = Object.freeze({
  website: mapWebsitePayload,
});

/** Sources this module can currently normalise. */
export function supportedSources() {
  return Object.keys(SOURCE_MAPPERS);
}

/**
 * Normalise a raw inbound payload into canonical lead fields.
 *
 * The untrusted free-text message is NOT handled here — sanitize.js owns it, and
 * the caller composes the two. Splitting them keeps the security-relevant code
 * in one reviewable file.
 *
 * @param {string} source
 * @param {object} payload
 * @param {{defaultCountryCode?: string, defaultCurrency?: string}} [options]
 */
export function normalizeLead(source, payload, options) {
  const mapper = SOURCE_MAPPERS[source];
  if (!mapper) {
    throw new Error(
      `normalizeLead: no mapper for source "${source}". Supported: ${supportedSources().join(', ')}`,
    );
  }

  const mapped = mapper(payload);
  const canonical = toCanonicalFields(mapped, options);

  // message travels alongside, unsanitised, for the caller to hand to sanitize.js.
  return { fields: canonical, rawMessage: mapped.message ?? null };
}
