// ============================================================================
// GENERATED FILE — do not edit by hand.
// Source: src/core/sanitize.js
// Regenerate with: npm run build:nodes
//
// This is the paste-ready body for an n8n Code node. src/core/ is the
// source of truth; a hand edit here will be silently overwritten and will
// not survive the next build (PROJECT_SPEC.md section 1).
// ============================================================================
/**
 * sanitize.js — handling for untrusted, attacker-controlled text.
 *
 * ZERO IMPORTS (see schema.js for why).
 *
 * lead.message is written by whoever filled in the form. It ends up inside an
 * LLM prompt, so it is treated as hostile input throughout.
 *
 * The injection scan is a FLAG, NOT A FILTER. A lead is never blocked or
 * altered because it tripped a heuristic — a genuine customer might write
 * "ignore my previous message, the budget is actually 20k" and that is a good
 * lead, not an attack. Matching sets needs_human_review so a person looks at
 * it, and nothing else. Blocking would lose real business to a regex.
 */

/** PROJECT_SPEC.md section 4.2: truncate to 2,000 characters. */
const MAX_MESSAGE_LENGTH = 2000;

/**
 * C0 controls except tab (09) and newline (0A), plus DEL and the C1 block.
 * Written as escapes rather than literals so this file stays plain ASCII.
 */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/**
 * Zero-width, soft-hyphen and bidirectional-override characters.
 *
 * These are invisible in a form field but can hide text from a human reviewer
 * while remaining fully visible to the model — exactly the gap an injection
 * wants. Removing them also stops a marker being split mid-word to evade the
 * heuristics below.
 */
const INVISIBLE_CHARS = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * Heuristic markers for prompt-injection attempts.
 *
 * Each entry is [name, pattern]. Names are stored on the lead so a reviewer can
 * see WHICH heuristic tripped without re-running the scan.
 */
const INJECTION_MARKERS = Object.freeze([
  ['override_instructions', /\b(ignore|disregard|forget|override)\b[^.!?]{0,40}\b(all\s+)?(previous|prior|above|earlier|preceding|your)\b[^.!?]{0,20}\b(instruction|prompt|rule|direction|command)/i],
  ['system_prompt_reference', /\b(system|developer)\s*(prompt|message|instruction)/i],
  ['role_reassignment', /\byou\s+are\s+now\b|\bact\s+as\s+(a|an|the)\b|\bpretend\s+to\s+be\b|\bfrom\s+now\s+on\s+you\b/i],
  ['score_manipulation', /\b(set|give|assign|output|return|make)\b[^.!?]{0,30}\b(score|rating|priority)\b[^.!?]{0,20}(100|max|highest|hot)/i],
  ['forced_output', /\b(respond|reply|answer|output)\s+(only\s+)?with\b|\byour\s+response\s+must\b/i],
  ['chat_markup_injection', /<\|?\s*\/?\s*(system|assistant|user|im_start|im_end)\s*\|?>|\[\/?INST\]|###\s*(system|instruction)/i],
  ['instruction_delimiter', /\bnew\s+instructions?\s*:|\bupdated\s+instructions?\s*:/i],
  ['exfiltration_attempt', /\b(repeat|print|reveal|show|display)\b[^.!?]{0,30}\b(prompt|instruction|rule)s?\b/i],
]);

/**
 * Strip control and invisible characters, normalise newlines and whitespace.
 *
 * Returns null for anything that is not a usable string, so callers get a
 * consistent "no value" rather than the string "undefined".
 */
function cleanText(raw) {
  if (typeof raw !== 'string') return null;

  const cleaned = raw
    .replace(/\r\n?/g, '\n')      // normalise line endings first
    .replace(CONTROL_CHARS, '')
    .replace(INVISIBLE_CHARS, '')
    .replace(/\n{3,}/g, '\n\n')   // collapse runs of blank lines
    .replace(/[ \t]{2,}/g, ' ')   // collapse runs of spaces and tabs
    .trim();

  return cleaned === '' ? null : cleaned;
}

/**
 * Full treatment for a free-text field bound for the prompt.
 *
 * @param {unknown} raw
 * @param {{maxLength?: number}} [options]
 * @returns {{value: string|null, truncated: boolean, removedCharacters: number, originalLength: number}}
 */
function sanitizeMessage(raw, options) {
  const maxLength = options?.maxLength ?? MAX_MESSAGE_LENGTH;
  const originalLength = typeof raw === 'string' ? raw.length : 0;

  const cleaned = cleanText(raw);
  if (cleaned === null) {
    return { value: null, truncated: false, removedCharacters: originalLength, originalLength };
  }

  const truncated = cleaned.length > maxLength;
  const value = truncated ? cleaned.slice(0, maxLength) : cleaned;

  return {
    value,
    truncated,
    removedCharacters: Math.max(0, originalLength - value.length),
    originalLength,
  };
}

/**
 * Scan for prompt-injection markers.
 *
 * Runs against the SANITISED text. Running it against the raw string would let
 * a zero-width character split a marker ("ig<ZWSP>nore previous instructions")
 * and slip past every pattern.
 *
 * @param {unknown} text
 * @returns {{matched: boolean, markers: string[]}}
 */
function detectInjection(text) {
  if (typeof text !== 'string' || text === '') {
    return { matched: false, markers: [] };
  }

  const markers = [];
  for (const [name, pattern] of INJECTION_MARKERS) {
    if (pattern.test(text)) markers.push(name);
  }

  return { matched: markers.length > 0, markers };
}

/**
 * Sanitise and scan in one call — the shape the intake workflow wants.
 *
 * Note what this does NOT do: it never rewrites, redacts, or rejects the
 * message on a heuristic hit. It reports. The caller sets needs_human_review
 * and lets the lead through.
 *
 * @returns {{value: string|null, truncated: boolean, removedCharacters: number,
 *            originalLength: number, injection: {matched: boolean, markers: string[]},
 *            reviewReason: string|null}}
 */
function prepareUntrustedText(raw, options) {
  const sanitized = sanitizeMessage(raw, options);
  const injection = detectInjection(sanitized.value ?? '');

  return {
    ...sanitized,
    injection,
    reviewReason: injection.matched ? 'possible_prompt_injection' : null,
  };
}

/** Marker names, exposed so tests and docs cannot drift from the implementation. */
function injectionMarkerNames() {
  return INJECTION_MARKERS.map(([name]) => name);
}
