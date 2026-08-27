/**
 * llmError.js — the failure type and the one HTTP round trip every LLM adapter makes.
 *
 * Shared on purpose. Spec 5.0 requires every provider call to have a timeout
 * and safe error mapping, and those should not differ by provider — a 500 from
 * Ollama and a 500 from OpenAI must reach the retry logic looking the same.
 * What stays per-adapter is the provider-specific part: URL, headers, request
 * body, and how to find the text in the response envelope.
 *
 * Credentials never enter an error message. The provider's own message is
 * copied through, but the request headers are not, so a key cannot reach a log
 * line via an exception (spec 4.3).
 */

/** A provider failure, carrying enough detail to triage without leaking anything. */
export class LlmError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'LlmError';
    this.provider = options.provider ?? null;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    /** 'timeout' | 'unreachable' | 'http_error' | 'empty_response' */
    this.kind = options.kind ?? 'provider_error';
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** Pull a human-readable message out of whatever error envelope the provider used. */
function providerMessage(body, fallback) {
  if (typeof body?.error === 'string') return body.error;
  if (typeof body?.error?.message === 'string') return body.error.message;
  if (typeof body?.message === 'string') return body.message;
  return fallback;
}

/**
 * POST JSON and return the parsed response.
 *
 * Always bounded by a timeout: a hung provider must not hold an n8n execution
 * open. Retry with backoff is the M8 resilience pass and is deliberately not
 * here — M3 retries a *malformed answer* once (spec 5.3), which is a different
 * thing from retrying a broken connection.
 */
export async function postJson(request) {
  const { provider, url, headers, body, fetchImpl, timeoutMs } = request;

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const timedOut = cause?.name === 'TimeoutError';
    throw new LlmError(
      timedOut
        ? `${provider}: request timed out after ${timeoutMs}ms`
        : `${provider}: could not reach the provider — ${cause?.message ?? 'unknown transport error'}`,
      { provider, kind: timedOut ? 'timeout' : 'unreachable', cause },
    );
  }

  const text = await response.text();
  let parsed = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    throw new LlmError(
      `${provider}: request failed (${response.status}): ${providerMessage(parsed, response.statusText || 'no detail')}`,
      { provider, status: response.status, code: parsed?.error?.type ?? parsed?.error?.code ?? null, kind: 'http_error' },
    );
  }

  if (parsed === null) {
    throw new LlmError(`${provider}: response body was not valid JSON`, {
      provider,
      status: response.status,
      kind: 'empty_response',
    });
  }

  return parsed;
}

/** Guard the text an adapter extracted. An empty completion is a failure, not a zero score. */
export function requireText(value, provider, detail) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LlmError(`${provider}: ${detail ?? 'the provider returned no text'}`, {
      provider,
      kind: 'empty_response',
    });
  }
  return value;
}
