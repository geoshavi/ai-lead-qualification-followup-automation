# LLM adapter contract

Every provider adapter implements exactly this surface. `src/core/` never
imports one, never calls a network endpoint, never inspects a provider-specific
response shape, and never branches on a provider name (PROJECT_SPEC.md
section 5.0).

| Adapter | `LLM_PROVIDER` | Needs | Role |
|---|---|---|---|
| `ollamaLlm.js` | `ollama` *(default)* | a local Ollama | the $0 development and demo path |
| `anthropicLlm.js` | `anthropic` | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | optional hosted |
| `openaiLlm.js` | `openai` | `OPENAI_API_KEY`, `OPENAI_MODEL` | optional hosted |

Switching is configuration only. `src/core/`, the prompts, the generated
Code-node snippets, the workflow topology and the database schema are identical
whichever one is selected — and `tests/llm-adapters.test.js` proves it by
replaying one recorded result through all three and asserting a single
identical validated result.

---

## The contract

```js
scoreLead({ systemPrompt, userPrompt, responseSchema, timeoutMs })
  -> { text, provider, model, requestId: string | null }
```

`text` is the completion **exactly as the provider returned it**. An adapter
must not strip fences, repair JSON, or pre-parse anything — that is
`scoreParse.js`'s job, and doing it twice in two places is how the two drift.

`requestId` is `null` when the provider does not issue one. Ollama does not, so
it returns `null` rather than inventing an id.

### Construction

```js
createOllamaLlm({ baseUrl, model, fetchImpl, timeoutMs })
createAnthropicLlm({ apiKey, model, baseUrl, maxTokens, fetchImpl, timeoutMs })
createOpenAiLlm({ apiKey, model, baseUrl, fetchImpl, timeoutMs })
```

No adapter reads `process.env` itself; `createLlmProvider(env)` in
`scoreLead.js` does that once. `fetchImpl` exists so tests inject a transport —
which is what keeps the suite offline.

Missing configuration throws at construction. A hosted provider selected
without its key fails immediately rather than at the first lead.

---

## No SDKs

All three use built-in `fetch`. The project ships zero npm dependencies and no
lockfile (`tests/core-contract.test.js` enforces it), and section 5.0 says to
prefer built-in platform HTTP capabilities. Adding `@anthropic-ai/sdk`,
`openai`, or `ollama` would buy retry helpers and typed responses at the cost
of the constraint the whole project is built on.

---

## Per-provider request shape

| | Ollama | Anthropic | OpenAI |
|---|---|---|---|
| Endpoint | `POST {baseUrl}/api/chat` | `POST /v1/messages` | `POST /v1/chat/completions` |
| Auth | none | `x-api-key` + `anthropic-version` | `Authorization: Bearer` |
| System prompt | a `system` message | top-level `system` field | a `system` message |
| JSON coaxing | `format: "json"` | prompt only | `response_format: json_object` |
| Sampling | `options.temperature: 0` | **none — see below** | `temperature: 0` |
| Text is at | `message.content` | first `content[]` block of type `text` | `choices[0].message.content` |
| `requestId` | `null` | `id` | `id` |

**The Anthropic adapter deliberately sends no `temperature` or `top_p`.**
Sampling parameters are rejected with a 400 on current Claude models. This is
the kind of drift that looks like a working adapter until the first real call,
so `tests/llm-adapters.test.js` asserts the absence rather than trusting it.

**JSON coaxing is defence in depth, never load-bearing.** Section 5.3 requires
the common parser to handle plain text, fenced JSON, malformed JSON, missing
fields and out-of-range values regardless — and the tests prove it against
recorded fixtures for each. Ollama also accepts a JSON schema in `format` if
stricter output is ever wanted; the parser would not care either way.

---

## Failure mapping

Every failure becomes an `LlmError` carrying `provider`, `status`, `code` and a
`kind`:

| `kind` | Cause |
|---|---|
| `timeout` | the call exceeded `timeoutMs` |
| `unreachable` | transport failure — Ollama not running, DNS, refused connection |
| `http_error` | a non-2xx response; `status` is set |
| `empty_response` | 2xx but no usable text, including an Anthropic `stop_reason: "refusal"` |

Two rules hold across all three:

- **Every call is bounded by a timeout.** A hung provider must not hold an n8n
  execution open.
- **A credential never enters an error message.** The provider's own message is
  copied through; the request headers are not.

An Anthropic safety decline arrives as HTTP **200** with `stop_reason:
"refusal"` and no text block, so checking the status code alone would report
success. The adapter checks for it explicitly.

---

## Retry

Two independent retries, for two different failures, both bounded:

- **A malformed answer** (spec 5.3) earns **one** more attempt with
  `STRICT_RETRY_REMINDER` appended. A second failure writes
  `AI_SCORE_INVALID`, sets `crm_status = HUMAN_REVIEW` and
  `needs_human_review = true`, and still persists the lead.
- **A transient transport failure** (spec 9, M8) — `timeout`, `unreachable`,
  or an `http_error` at `429`/`5xx` — is retried with exponential backoff, up
  to `src/core/retry.js`'s `DEFAULT_RETRY_POLICY` (3 total attempts, 200ms
  base delay, doubling, capped at 5s), *before* it ever reaches the section
  5.3 retry above. An `http_error` at any other status (bad auth, bad
  request) is not retried — an identical request would just resend the same
  mistake. `callProviderWithRetry` in `scoreLead.js` is what does this;
  `tests/llm-score-lead.test.js`'s "scenario 16" describe block proves both
  the eventual-success and exhausted-retries paths, with an injected
  `sleepImpl` so the suite stays instant.

Both retries are bounded on purpose — a lead that cannot be scored is
flagged rather than dropped, never retried forever.

---

## What the model is never allowed to do

The model returns a score. It does not write to the database, choose timing, or
set status (section 4.3). In particular it is **never asked for a temperature**
— HOT/WARM/COLD is derived from the score in `temperature.js`, because letting
the model return both produces `score: 30, temperature: HOT`.

`parseScoreResponse` keeps only the five contract keys, so a `temperature` the
model volunteers anyway is dropped rather than trusted.

**Ollama being local is not a security boundary** (section 4.3). Its output is
untrusted exactly like a hosted provider's: same parsing, same validation, same
clamping, same retry, same human-review path. Do not expose Ollama beyond the
local or trusted network.

---

## Testing

`tests/llm-adapters.test.js` and `tests/llm-score-lead.test.js` both replace
`globalThis.fetch` with a throwing stub for their entire run, so an adapter
that fell back to the real transport fails loudly instead of dialling out. No
test needs Ollama running, and none touches a paid API — that is M3's "done
when".

Recorded envelopes live in `fixtures/llm/`:

| Fixture | Covers |
|---|---|
| `ollama-valid`, `anthropic-valid`, `openai-valid` | scenario 17 — byte-identical inner text, three envelopes |
| `ollama-fenced` | markdown-fenced JSON |
| `ollama-malformed` | truncated JSON |
| `ollama-missing-field` | a missing required key |
| `ollama-out-of-range` | `score: 150`, clamped to 100 |
| `ollama-prose` | a refusal with no JSON object at all |
| `ollama-low-confidence` | scenario 9 — score kept, human flagged |
| `ollama-injection-attempt` | scenario 14 — the model resisted; score not inflated |
| `anthropic-refusal` | HTTP 200 with `stop_reason: "refusal"` |
