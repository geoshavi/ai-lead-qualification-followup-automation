/**
 * openaiLlm.js — OPTIONAL hosted provider (spec 5.0).
 *
 * Not used by the default $0 path. Selecting it requires only
 * LLM_PROVIDER=openai plus OPENAI_API_KEY and OPENAI_MODEL.
 *
 * Raw HTTP rather than the official SDK, for the same reason as the Anthropic
 * adapter: the project ships zero npm dependencies.
 */

import { LlmError, postJson, requireText } from './llmError.js';

export const OPENAI_BASE_URL = 'https://api.openai.com';
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * @param {{apiKey: string, model: string, baseUrl?: string,
 *          fetchImpl?: typeof fetch, timeoutMs?: number}} options
 */
export function createOpenAiLlm(options = {}) {
  const apiKey = options.apiKey;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new TypeError('createOpenAiLlm: apiKey is required (OPENAI_API_KEY)');
  }

  const model = options.model;
  if (typeof model !== 'string' || model.trim() === '') {
    throw new TypeError('createOpenAiLlm: model is required (OPENAI_MODEL)');
  }

  const baseUrl = (options.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    provider: 'openai',
    model,

    async scoreLead(request) {
      const payload = await postJson({
        provider: 'openai',
        url: `${baseUrl}/v1/chat/completions`,
        headers: { Authorization: `Bearer ${apiKey}` },
        fetchImpl,
        timeoutMs: request?.timeoutMs ?? defaultTimeoutMs,
        body: {
          model,
          messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userPrompt },
          ],
          // JSON mode requires the prompt to ask for JSON as well, which it
          // does. Defence in depth only — the parser never relies on it.
          response_format: { type: 'json_object' },
          temperature: 0,
        },
      });

      const text = requireText(
        payload?.choices?.[0]?.message?.content,
        'openai',
        'the response carried no completion',
      );

      return {
        text,
        provider: 'openai',
        model: typeof payload?.model === 'string' ? payload.model : model,
        requestId: typeof payload?.id === 'string' ? payload.id : null,
      };
    },
  };
}

export { LlmError };
