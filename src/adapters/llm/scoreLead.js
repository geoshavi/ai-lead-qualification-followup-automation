/**
 * scoreLead.js — provider selection and the scoring round trip (spec 5.0, 5.3).
 *
 * This is I/O orchestration, so it lives in the adapter layer and never reaches
 * a Code node. Every decision it makes is a pure function in src/core/:
 * prompt.js builds the prompt, sanitize.js decides what is untrusted,
 * scoreParse.js decides whether the answer is usable, temperature.js derives
 * the band. This file only sequences them and talks to the provider.
 *
 * The n8n canvas draws the same sequence with nodes at M4. That is why the
 * decisions are pure and only the plumbing is here.
 *
 * ONE INVARIANT: a lead is never lost. Whatever the model does — fences its
 * JSON, truncates it, refuses, or never answers — this returns a patch that can
 * be persisted and says whether a person needs to look at it.
 */

import { EVENT_STATUS, EVENT_TYPE } from '../../core/schema.js';
import { buildScoringPrompt } from '../../core/prompt.js';
import { prepareUntrustedText } from '../../core/sanitize.js';
import { buildScoreFailurePatch, buildScorePatch, parseScoreResponse } from '../../core/scoreParse.js';
import { scoreToTemperature, thresholdsFromEnv } from '../../core/temperature.js';

import { LlmError } from './llmError.js';
import { createAnthropicLlm } from './anthropicLlm.js';
import { createOllamaLlm } from './ollamaLlm.js';
import { createOpenAiLlm } from './openaiLlm.js';

import { DEFAULT_RETRY_POLICY, backoffDelayMs, isRetryableFailure, shouldRetry } from '../../core/retry.js';

/** Spec section 12 defaults, used when the environment omits them. */
const DEFAULT_OLLAMA_MODEL = 'qwen2.5:7b-instruct';

/**
 * Build the provider named by LLM_PROVIDER.
 *
 * Switching providers is configuration only: nothing below this function's
 * return value differs between them (spec 5.0). An unknown name throws rather
 * than falling back, because silently scoring with the wrong model is worse
 * than not scoring.
 *
 * @param {object} env process.env-shaped object
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 */
export function createLlmProvider(env = {}, options = {}) {
  const name = String(env.LLM_PROVIDER ?? 'ollama').trim().toLowerCase();
  const shared = {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? numberOrUndefined(env.LLM_TIMEOUT_MS),
  };

  switch (name) {
    case 'ollama':
      return createOllamaLlm({
        ...shared,
        baseUrl: env.OLLAMA_BASE_URL,
        model: emptyToUndefined(env.OLLAMA_MODEL) ?? DEFAULT_OLLAMA_MODEL,
      });

    case 'anthropic':
      return createAnthropicLlm({
        ...shared,
        apiKey: emptyToUndefined(env.ANTHROPIC_API_KEY),
        model: emptyToUndefined(env.ANTHROPIC_MODEL),
      });

    case 'openai':
      return createOpenAiLlm({
        ...shared,
        apiKey: emptyToUndefined(env.OPENAI_API_KEY),
        model: emptyToUndefined(env.OPENAI_MODEL),
      });

    default:
      throw new TypeError(
        `createLlmProvider: unknown LLM_PROVIDER "${name}". Expected ollama, anthropic or openai.`,
      );
  }
}

function emptyToUndefined(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function numberOrUndefined(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Call the provider, retrying a transient transport failure with backoff
 * (spec 9, M8) before giving up. A malformed *answer* is a different thing
 * and is not retried here — that is the caller's own section 5.3 retry, one
 * layer up, which tries again with a stricter prompt rather than the exact
 * same request.
 *
 * @returns {Promise<{response: object, transportAttempts: number}>}
 */
async function callProviderWithRetry(provider, request, options = {}) {
  const policy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const sleep = options.sleepImpl ?? defaultSleep;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const response = await provider.scoreLead(request);
      return { response, transportAttempts: attempt };
    } catch (error) {
      if (!isRetryableFailure(error) || !shouldRetry(attempt, policy)) {
        error.transportAttempts = attempt;
        throw error;
      }
      await sleep(backoffDelayMs(attempt, policy));
    }
  }
}

/**
 * Score one lead, with the single retry section 5.3 allows for a malformed
 * answer, and bounded retry-with-backoff (spec 9, M8) for a transient
 * transport failure.
 *
 * @param {{lead: object, provider: object, env?: object, timeoutMs?: number,
 *          retryPolicy?: object, sleepImpl?: (ms: number) => Promise<void>}} input
 */
export async function scoreLead(input) {
  const { lead, provider } = input;
  const thresholds = thresholdsFromEnv(input.env ?? {});

  // Untrusted text is cleaned and scanned before it goes anywhere near the
  // model. The scan FLAGS, it does not filter — a real customer might simply
  // write something odd (spec 4.2).
  const sanitized = prepareUntrustedText(lead?.message);
  const scrubbedLead = { ...lead, message: sanitized.value };

  const events = [];
  let attempts = 0;
  let lastError = null;

  for (const strict of [false, true]) {
    const prompt = buildScoringPrompt(scrubbedLead, { strict });
    attempts += 1;

    let response;
    try {
      const result = await callProviderWithRetry(
        provider,
        {
          systemPrompt: prompt.systemPrompt,
          userPrompt: prompt.userPrompt,
          responseSchema: prompt.responseSchema,
          timeoutMs: input.timeoutMs,
        },
        { retryPolicy: input.retryPolicy, sleepImpl: input.sleepImpl },
      );
      response = result.response;
    } catch (error) {
      // A broken connection is not a malformed answer, so it does not earn
      // the section 5.3 retry above — it already had its own bounded
      // retry-with-backoff in callProviderWithRetry (spec 9, M8), and only
      // reaches here once that is exhausted or the failure kind is not one
      // retrying can fix (isRetryableFailure).
      const kind = error instanceof LlmError ? error.kind : 'provider_error';
      return failure({
        events,
        attempts,
        transportAttempts: error.transportAttempts,
        provider,
        sanitized,
        reason: `provider_${kind}`,
        message: error.message,
      });
    }

    const parsed = parseScoreResponse(response.text);

    if (parsed.ok) {
      const temperature = scoreToTemperature(parsed.value.score, thresholds);
      const patch = buildScorePatch(parsed.value, {
        temperature,
        existingReviewReason: sanitized.reviewReason,
      });

      events.push({
        event_type: EVENT_TYPE.AI_SCORE_CREATED,
        status: EVENT_STATUS.SUCCESS,
        details: {
          provider: response.provider,
          model: response.model,
          request_id: response.requestId,
          attempts,
          score: patch.lead_score,
          temperature,
          confidence: parsed.value.confidence,
          warnings: parsed.warnings,
        },
        error_message: null,
      });

      if (patch.needs_human_review) {
        events.push({
          event_type: EVENT_TYPE.HUMAN_REVIEW_FLAGGED,
          status: EVENT_STATUS.SUCCESS,
          details: {
            reason: patch.review_reason,
            injection_markers: sanitized.injection.markers,
            confidence: parsed.value.confidence,
          },
          error_message: null,
        });
      }

      return {
        ok: true,
        attempts,
        patch,
        value: parsed.value,
        warnings: parsed.warnings,
        injection: sanitized.injection,
        sanitized,
        provider: response.provider,
        model: response.model,
        requestId: response.requestId,
        events,
      };
    }

    lastError = parsed.error;
  }

  return failure({
    events,
    attempts,
    provider,
    sanitized,
    reason: 'invalid_response',
    message: lastError ?? 'the model response could not be validated',
  });
}

/**
 * The persist-and-flag path.
 *
 * Everything that can go wrong ends here: two malformed answers, a refusal, a
 * timeout, an unreachable provider. The lead is still saved, with no invented
 * score, and a person is asked to look (spec 5.0, 5.3).
 */
function failure(context) {
  const { events, attempts, transportAttempts, provider, sanitized, reason, message } = context;

  const patch = buildScoreFailurePatch({ reason });

  // An injection flag raised during sanitisation must not be lost just because
  // scoring also failed.
  if (sanitized.reviewReason) {
    patch.review_reason = `${patch.review_reason},${sanitized.reviewReason}`;
  }

  events.push({
    event_type: EVENT_TYPE.AI_SCORE_INVALID,
    status: EVENT_STATUS.FAILURE,
    details: {
      provider: provider?.provider ?? null,
      model: provider?.model ?? null,
      attempts,
      ...(transportAttempts ? { transport_attempts: transportAttempts } : {}),
      reason,
    },
    error_message: message,
  });

  events.push({
    event_type: EVENT_TYPE.HUMAN_REVIEW_FLAGGED,
    status: EVENT_STATUS.SUCCESS,
    details: { reason: patch.review_reason, injection_markers: sanitized.injection.markers },
    error_message: null,
  });

  return {
    ok: false,
    attempts,
    patch,
    value: null,
    warnings: [],
    injection: sanitized.injection,
    sanitized,
    provider: provider?.provider ?? null,
    model: provider?.model ?? null,
    requestId: null,
    events,
  };
}
