/**
 * ollamaLlm.js — the DEFAULT provider (spec 1.1, 5.0).
 *
 * Talks to a local Ollama over its HTTP API using built-in fetch. No SDK, no
 * npm dependency, no API key, no cost. This is the provider the $0 demo path
 * runs on.
 *
 * Ollama being local does not make it a security boundary. Its output is
 * treated as untrusted exactly like a hosted provider's, and this adapter does
 * not clean, repair, or pre-parse the text — it hands the raw completion to
 * scoreParse.js and lets the common parser do its job (spec 4.3, 5.3).
 */

import { LlmError, postJson, requireText } from './llmError.js';

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * @param {{baseUrl?: string, model: string, fetchImpl?: typeof fetch, timeoutMs?: number}} options
 */
export function createOllamaLlm(options = {}) {
  const model = options.model;
  if (typeof model !== 'string' || model.trim() === '') {
    throw new TypeError('createOllamaLlm: model is required (OLLAMA_MODEL)');
  }

  const baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    provider: 'ollama',
    model,

    async scoreLead(request) {
      const payload = await postJson({
        provider: 'ollama',
        url: `${baseUrl}/api/chat`,
        headers: {},
        fetchImpl,
        timeoutMs: request?.timeoutMs ?? defaultTimeoutMs,
        body: {
          model,
          messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userPrompt },
          ],
          // A streamed reply arrives as many objects; scoring needs one.
          stream: false,
          // Defence in depth only. The parser still handles fenced, prose-wrapped
          // and malformed replies, because `format` is a request, not a guarantee.
          // Ollama also accepts a JSON schema here if stricter output is wanted.
          format: 'json',
          // Scoring should be as reproducible as the model allows.
          options: { temperature: 0 },
        },
      });

      const text = requireText(
        payload?.message?.content,
        'ollama',
        'the model returned an empty completion',
      );

      return {
        text,
        provider: 'ollama',
        model: typeof payload?.model === 'string' ? payload.model : model,
        // Ollama issues no request id. Null is the honest answer.
        requestId: null,
      };
    },
  };
}

export { LlmError };
