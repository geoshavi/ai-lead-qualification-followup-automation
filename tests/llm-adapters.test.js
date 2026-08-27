/**
 * llm-adapters.test.js — the provider adapters (spec 5.0).
 *
 * NO NETWORK. Every adapter takes an injected `fetchImpl`, and this file
 * replaces `globalThis.fetch` with a throwing stub for its whole run — so an
 * adapter that quietly fell back to the real fetch fails loudly here rather
 * than silently dialling out from CI. That is M3's "done when".
 *
 * Responses are recorded envelopes in fixtures/llm/. The three "valid"
 * fixtures carry byte-identical inner text on purpose: scenario 17 says the
 * same recorded result through all three adapters must produce one identical
 * validated core result, and that only means something if the only difference
 * is the envelope.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LlmError } from '../src/adapters/llm/llmError.js';
import { createOllamaLlm } from '../src/adapters/llm/ollamaLlm.js';
import { createAnthropicLlm } from '../src/adapters/llm/anthropicLlm.js';
import { createOpenAiLlm } from '../src/adapters/llm/openaiLlm.js';
import { parseScoreResponse } from '../src/core/scoreParse.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'llm');
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

const PROMPT = {
  systemPrompt: 'You qualify inbound sales leads.',
  userPrompt: 'Score this lead.',
  responseSchema: { type: 'object' },
  timeoutMs: 5000,
};

/** Records every call, answers with a recorded envelope. */
function recordingFetch(payload, init = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
    return new Response(
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      { status: init.status ?? 200, headers: { 'content-type': 'application/json' } },
    );
  };
  impl.calls = calls;
  return impl;
}

// ---------------------------------------------------------------------------
// The no-network guard
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = () => {
    throw new Error('a test in this file attempted a real network call');
  };
});

after(() => {
  globalThis.fetch = realFetch;
});

describe('the guard itself works', () => {
  test('an unstubbed fetch throws', () => {
    assert.throws(() => globalThis.fetch('http://example.com'), /real network call/);
  });
});

// ---------------------------------------------------------------------------
// Ollama — the default provider
// ---------------------------------------------------------------------------
describe('ollamaLlm (default provider)', () => {
  test('normalises the envelope to the section 5.0 contract', async () => {
    const impl = recordingFetch(fixture('ollama-valid'));
    const llm = createOllamaLlm({ model: 'qwen2.5:7b-instruct', fetchImpl: impl });
    const result = await llm.scoreLead(PROMPT);

    assert.deepEqual(Object.keys(result).sort(), ['model', 'provider', 'requestId', 'text']);
    assert.equal(result.provider, 'ollama');
    assert.equal(result.model, 'qwen2.5:7b-instruct');
    assert.equal(result.requestId, null, 'Ollama issues no request id — null, not invented');
    assert.match(result.text, /"score"/);
  });

  test('posts to /api/chat on the configured base url', async () => {
    const impl = recordingFetch(fixture('ollama-valid'));
    await createOllamaLlm({ baseUrl: 'http://127.0.0.1:11434', model: 'm', fetchImpl: impl }).scoreLead(PROMPT);

    assert.equal(impl.calls[0].url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(impl.calls[0].options.method, 'POST');
  });

  test('sends system and user as separate messages, unstreamed', async () => {
    const impl = recordingFetch(fixture('ollama-valid'));
    await createOllamaLlm({ model: 'm', fetchImpl: impl }).scoreLead(PROMPT);
    const { body } = impl.calls[0];

    assert.equal(body.stream, false, 'a streamed reply cannot be parsed as one object');
    assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
    assert.equal(body.messages[0].content, PROMPT.systemPrompt);
    assert.equal(body.messages[1].content, PROMPT.userPrompt);
  });

  test('asks for JSON as defence in depth (spec 5.3)', async () => {
    const impl = recordingFetch(fixture('ollama-valid'));
    await createOllamaLlm({ model: 'm', fetchImpl: impl }).scoreLead(PROMPT);

    assert.equal(impl.calls[0].body.format, 'json');
    assert.equal(impl.calls[0].body.options.temperature, 0, 'scoring must be as reproducible as the model allows');
  });

  test('defaults to the spec section 12 base url', async () => {
    const impl = recordingFetch(fixture('ollama-valid'));
    await createOllamaLlm({ model: 'm', fetchImpl: impl }).scoreLead(PROMPT);

    assert.ok(impl.calls[0].url.startsWith('http://127.0.0.1:11434'));
  });

  test('requires a model rather than guessing one', () => {
    assert.throws(() => createOllamaLlm({ fetchImpl: recordingFetch({}) }), /model/i);
  });

  test('a fenced reply is passed through untouched — parsing is core\'s job', async () => {
    const impl = recordingFetch(fixture('ollama-fenced'));
    const result = await createOllamaLlm({ model: 'm', fetchImpl: impl }).scoreLead(PROMPT);

    assert.ok(result.text.includes('```'), 'the adapter must not pre-clean the text');
  });
});

// ---------------------------------------------------------------------------
// Anthropic — optional
// ---------------------------------------------------------------------------
describe('anthropicLlm (optional)', () => {
  test('normalises the envelope and carries the request id', async () => {
    const impl = recordingFetch(fixture('anthropic-valid'));
    const llm = createAnthropicLlm({ apiKey: 'sk-ant-test', model: 'claude-opus-5', fetchImpl: impl });
    const result = await llm.scoreLead(PROMPT);

    assert.equal(result.provider, 'anthropic');
    assert.equal(result.model, 'claude-opus-5');
    assert.equal(result.requestId, 'msg_01LeadEngineFixture0001');
    assert.match(result.text, /"score"/);
  });

  test('sends the documented auth and version headers', async () => {
    const impl = recordingFetch(fixture('anthropic-valid'));
    await createAnthropicLlm({ apiKey: 'sk-ant-test', model: 'm', fetchImpl: impl }).scoreLead(PROMPT);
    const { headers } = impl.calls[0].options;

    assert.equal(headers['x-api-key'], 'sk-ant-test');
    assert.equal(headers['anthropic-version'], '2023-06-01');
  });

  test('the system prompt goes in the system field, not the messages array', async () => {
    const impl = recordingFetch(fixture('anthropic-valid'));
    await createAnthropicLlm({ apiKey: 'k', model: 'm', fetchImpl: impl }).scoreLead(PROMPT);
    const { body } = impl.calls[0];

    assert.equal(body.system, PROMPT.systemPrompt);
    assert.deepEqual(body.messages.map((m) => m.role), ['user']);
  });

  test('does NOT send temperature — current models reject it with a 400', async () => {
    const impl = recordingFetch(fixture('anthropic-valid'));
    await createAnthropicLlm({ apiKey: 'k', model: 'm', fetchImpl: impl }).scoreLead(PROMPT);

    assert.ok(!('temperature' in impl.calls[0].body));
    assert.ok(!('top_p' in impl.calls[0].body));
  });

  test('a safety refusal returns no text and becomes an LlmError', async () => {
    const impl = recordingFetch(fixture('anthropic-refusal'));
    const llm = createAnthropicLlm({ apiKey: 'k', model: 'm', fetchImpl: impl });

    await assert.rejects(() => llm.scoreLead(PROMPT), (error) => {
      assert.ok(error instanceof LlmError);
      assert.match(error.message, /refus|no text/i);
      return true;
    });
  });

  test('requires an api key', () => {
    assert.throws(() => createAnthropicLlm({ model: 'm', fetchImpl: recordingFetch({}) }), /key/i);
  });
});

// ---------------------------------------------------------------------------
// OpenAI — optional
// ---------------------------------------------------------------------------
describe('openaiLlm (optional)', () => {
  test('normalises the envelope and carries the request id', async () => {
    const impl = recordingFetch(fixture('openai-valid'));
    const llm = createOpenAiLlm({ apiKey: 'sk-test', model: 'gpt-4o-mini', fetchImpl: impl });
    const result = await llm.scoreLead(PROMPT);

    assert.equal(result.provider, 'openai');
    assert.equal(result.model, 'gpt-4o-mini');
    assert.equal(result.requestId, 'chatcmpl-leadEngineFixture0001');
  });

  test('sends bearer auth and JSON mode', async () => {
    const impl = recordingFetch(fixture('openai-valid'));
    await createOpenAiLlm({ apiKey: 'sk-test', model: 'm', fetchImpl: impl }).scoreLead(PROMPT);

    assert.equal(impl.calls[0].options.headers.Authorization, 'Bearer sk-test');
    assert.deepEqual(impl.calls[0].body.response_format, { type: 'json_object' });
  });

  test('requires an api key', () => {
    assert.throws(() => createOpenAiLlm({ model: 'm', fetchImpl: recordingFetch({}) }), /key/i);
  });
});

// ---------------------------------------------------------------------------
// Failure mapping — shared behaviour, spec 5.0
// ---------------------------------------------------------------------------
describe('every adapter maps failure the same way', () => {
  const adapters = [
    ['ollama', () => createOllamaLlm({ model: 'm', fetchImpl: failing() })],
    ['anthropic', () => createAnthropicLlm({ apiKey: 'k', model: 'm', fetchImpl: failing() })],
    ['openai', () => createOpenAiLlm({ apiKey: 'k', model: 'm', fetchImpl: failing() })],
  ];

  let mode = 'network';
  function failing() {
    return async () => {
      if (mode === 'network') throw new TypeError('fetch failed');
      return new Response('{"error":{"message":"boom"}}', { status: 500 });
    };
  }

  for (const [name, build] of adapters) {
    test(`${name}: an unreachable provider becomes an LlmError`, async () => {
      mode = 'network';
      await assert.rejects(() => build().scoreLead(PROMPT), (error) => {
        assert.ok(error instanceof LlmError, 'must not leak a raw TypeError');
        assert.equal(error.provider, name);
        return true;
      });
    });

    test(`${name}: a 500 becomes an LlmError carrying the status`, async () => {
      mode = 'http';
      await assert.rejects(() => build().scoreLead(PROMPT), (error) => {
        assert.ok(error instanceof LlmError);
        assert.equal(error.status, 500);
        return true;
      });
    });
  }

  test('a timeout aborts rather than hanging (spec 5.0)', async () => {
    const hangs = (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    });

    const llm = createOllamaLlm({ model: 'm', fetchImpl: hangs, timeoutMs: 20 });

    await assert.rejects(() => llm.scoreLead({ ...PROMPT, timeoutMs: 20 }), (error) => {
      assert.ok(error instanceof LlmError);
      assert.match(error.message, /timed out/i);
      return true;
    });
  });

  test('an empty completion is an error, not an empty score', async () => {
    const impl = recordingFetch({ message: { role: 'assistant', content: '   ' }, model: 'm' });
    const llm = createOllamaLlm({ model: 'm', fetchImpl: impl });

    await assert.rejects(() => llm.scoreLead(PROMPT), LlmError);
  });

  test('an api key never appears in an error message', async () => {
    const secret = 'sk-ant-super-secret-value';
    const impl = async () => new Response('{"error":{"message":"bad"}}', { status: 401 });
    const llm = createAnthropicLlm({ apiKey: secret, model: 'm', fetchImpl: impl });

    await assert.rejects(() => llm.scoreLead(PROMPT), (error) => {
      assert.ok(!error.message.includes(secret), 'never echo a credential into a log line');
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 17 — provider abstraction actually abstracts
// ---------------------------------------------------------------------------
describe('scenario 17: one recorded result, three adapters, one core result', () => {
  test('all three normalise to the same validated value', async () => {
    const results = await Promise.all([
      createOllamaLlm({ model: 'm', fetchImpl: recordingFetch(fixture('ollama-valid')) }).scoreLead(PROMPT),
      createAnthropicLlm({ apiKey: 'k', model: 'm', fetchImpl: recordingFetch(fixture('anthropic-valid')) }).scoreLead(PROMPT),
      createOpenAiLlm({ apiKey: 'k', model: 'm', fetchImpl: recordingFetch(fixture('openai-valid')) }).scoreLead(PROMPT),
    ]);

    const parsed = results.map((r) => parseScoreResponse(r.text));

    for (const p of parsed) assert.equal(p.ok, true);
    assert.deepEqual(parsed[0].value, parsed[1].value);
    assert.deepEqual(parsed[1].value, parsed[2].value);
    assert.equal(parsed[0].value.score, 82);
  });

  test('the providers still identify themselves distinctly', async () => {
    const results = await Promise.all([
      createOllamaLlm({ model: 'm', fetchImpl: recordingFetch(fixture('ollama-valid')) }).scoreLead(PROMPT),
      createAnthropicLlm({ apiKey: 'k', model: 'm', fetchImpl: recordingFetch(fixture('anthropic-valid')) }).scoreLead(PROMPT),
      createOpenAiLlm({ apiKey: 'k', model: 'm', fetchImpl: recordingFetch(fixture('openai-valid')) }).scoreLead(PROMPT),
    ]);

    assert.deepEqual(results.map((r) => r.provider), ['ollama', 'anthropic', 'openai']);
  });
});
