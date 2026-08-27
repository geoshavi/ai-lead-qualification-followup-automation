/**
 * anthropicLlm.js — OPTIONAL hosted provider (spec 5.0).
 *
 * Not used by the default $0 path. Selecting it requires only
 * LLM_PROVIDER=anthropic plus ANTHROPIC_API_KEY and ANTHROPIC_MODEL — no change
 * to src/core/, prompts, generated snippets, workflow topology, or the schema.
 *
 * Raw HTTP rather than the official SDK, because the project ships zero npm
 * dependencies (enforced by tests/core-contract.test.js) and spec 5.0 says to
 * prefer built-in platform HTTP capabilities.
 */

import { LlmError, postJson, requireText } from './llmError.js';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_TOKENS = 1024;

/**
 * @param {{apiKey: string, model: string, baseUrl?: string, maxTokens?: number,
 *          fetchImpl?: typeof fetch, timeoutMs?: number}} options
 */
export function createAnthropicLlm(options = {}) {
  const apiKey = options.apiKey;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new TypeError('createAnthropicLlm: apiKey is required (ANTHROPIC_API_KEY)');
  }

  const model = options.model;
  if (typeof model !== 'string' || model.trim() === '') {
    throw new TypeError('createAnthropicLlm: model is required (ANTHROPIC_MODEL)');
  }

  const baseUrl = (options.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  return {
    provider: 'anthropic',
    model,

    async scoreLead(request) {
      const payload = await postJson({
        provider: 'anthropic',
        url: `${baseUrl}/v1/messages`,
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        fetchImpl,
        timeoutMs: request?.timeoutMs ?? defaultTimeoutMs,
        body: {
          model,
          max_tokens: maxTokens,
          // The system prompt is a top-level field here, not a message.
          system: request.systemPrompt,
          messages: [{ role: 'user', content: request.userPrompt }],
          // No temperature/top_p on purpose: sampling parameters are rejected
          // with a 400 on current Claude models. Determinism is asked for in
          // the prompt instead.
        },
      });

      // A safety decline arrives as HTTP 200 with stop_reason 'refusal' and no
      // text block, so the status code alone would report success.
      if (payload?.stop_reason === 'refusal') {
        throw new LlmError('anthropic: the model refused the request', {
          provider: 'anthropic',
          kind: 'empty_response',
          code: 'refusal',
        });
      }

      const block = Array.isArray(payload?.content)
        ? payload.content.find((b) => b?.type === 'text')
        : null;

      const text = requireText(block?.text, 'anthropic', 'the response carried no text block');

      return {
        text,
        provider: 'anthropic',
        model: typeof payload?.model === 'string' ? payload.model : model,
        requestId: typeof payload?.id === 'string' ? payload.id : null,
      };
    },
  };
}

export { LlmError };
