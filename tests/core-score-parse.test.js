/**
 * core-score-parse.test.js — validating and repairing model output (spec 5.3).
 *
 * The model is untrusted regardless of provider, so every one of these cases is
 * a thing a real model has done: fenced the JSON, wrapped it in an apology,
 * returned a score of 150, returned a string where a number belongs.
 *
 * The rule this file enforces: a lead is never lost because the model
 * misbehaved. Bad output becomes {ok:false} and a human-review patch — never a
 * throw, and never a silently invented score.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ACTION_LENGTH,
  MAX_REASONING_LENGTH,
  buildScoreFailurePatch,
  buildScorePatch,
  parseScoreResponse,
  stripCodeFences,
} from '../src/core/scoreParse.js';

const VALID = {
  score: 82,
  reasoning: 'Clear budget and a three-week deadline.',
  recommended_action: 'Call within 24 hours.',
  needs_human_review: false,
  confidence: 'HIGH',
};

const json = (value) => JSON.stringify(value);

describe('stripCodeFences', () => {
  test('removes a ```json fence', () => {
    assert.equal(stripCodeFences('```json\n{"a":1}\n```'), '{"a":1}');
  });

  test('removes a bare ``` fence', () => {
    assert.equal(stripCodeFences('```\n{"a":1}\n```'), '{"a":1}');
  });

  test('leaves unfenced text alone', () => {
    assert.equal(stripCodeFences('{"a":1}'), '{"a":1}');
  });

  test('is not fooled by a fence inside a string value', () => {
    const raw = '{"reasoning":"they wrote ``` in the form"}';
    assert.equal(stripCodeFences(raw), raw);
  });
});

describe('accepting good output', () => {
  test('plain JSON parses', () => {
    const result = parseScoreResponse(json(VALID));

    assert.equal(result.ok, true);
    assert.equal(result.value.score, 82);
    assert.equal(result.value.confidence, 'HIGH');
  });

  test('fenced JSON parses (spec 5.3)', () => {
    const result = parseScoreResponse('```json\n' + json(VALID) + '\n```');
    assert.equal(result.ok, true);
  });

  test('JSON wrapped in chatter parses — models add preambles', () => {
    const result = parseScoreResponse(`Sure! Here is the assessment:\n${json(VALID)}\nLet me know.`);

    assert.equal(result.ok, true);
    assert.equal(result.value.score, 82);
  });

  test('lowercase confidence is normalised rather than rejected', () => {
    const result = parseScoreResponse(json({ ...VALID, confidence: 'low' }));

    assert.equal(result.ok, true);
    assert.equal(result.value.confidence, 'LOW');
  });

  test('the parsed value carries only the five contract keys', () => {
    const result = parseScoreResponse(json({ ...VALID, temperature: 'HOT', injected: true }));

    assert.equal(result.ok, true);
    assert.deepEqual(
      Object.keys(result.value).sort(),
      ['confidence', 'needs_human_review', 'reasoning', 'recommended_action', 'score'],
    );
    assert.ok(!('temperature' in result.value), 'temperature is derived, never accepted from the model');
  });
});

describe('rejecting bad output (spec 5.3)', () => {
  const rejected = [
    ['malformed JSON', '{"score": 80, "reasoning":'],
    ['an empty string', ''],
    ['whitespace only', '   \n  '],
    ['null', null],
    ['a non-string input', 42],
    ['prose with no object', 'I am unable to score this lead.'],
    ['a JSON array', '[1,2,3]'],
    ['a bare JSON string', '"eighty"'],
    ['a bare JSON number', '80'],
    ['JSON null', 'null'],
  ];

  for (const [label, input] of rejected) {
    test(`rejects ${label}`, () => {
      const result = parseScoreResponse(input);

      assert.equal(result.ok, false);
      assert.equal(typeof result.error, 'string');
      assert.ok(result.error.length > 0);
    });
  }

  test('never throws, whatever it is handed', () => {
    for (const input of [undefined, {}, [], Symbol.iterator, () => {}]) {
      assert.doesNotThrow(() => parseScoreResponse(input));
    }
  });

  for (const key of ['score', 'reasoning', 'recommended_action', 'needs_human_review', 'confidence']) {
    test(`rejects output missing ${key}`, () => {
      const partial = { ...VALID };
      delete partial[key];
      const result = parseScoreResponse(json(partial));

      assert.equal(result.ok, false);
      assert.match(result.error, new RegExp(key));
    });
  }

  const wrongTypes = [
    ['score as a string', { score: '82' }, /score/],
    ['score as null', { score: null }, /score/],
    ['score as NaN-ish', { score: 'abc' }, /score/],
    ['reasoning as a number', { reasoning: 12 }, /reasoning/],
    ['recommended_action as an object', { recommended_action: {} }, /recommended_action/],
    ['needs_human_review as a string', { needs_human_review: 'false' }, /needs_human_review/],
    ['confidence outside the enum', { confidence: 'VERY_HIGH' }, /confidence/],
  ];

  for (const [label, override, pattern] of wrongTypes) {
    test(`rejects ${label}`, () => {
      const result = parseScoreResponse(json({ ...VALID, ...override }));

      assert.equal(result.ok, false);
      assert.match(result.error, pattern);
    });
  }
});

describe('clamping and repair (spec 5.3)', () => {
  test('a score above 100 is clamped', () => {
    const result = parseScoreResponse(json({ ...VALID, score: 150 }));

    assert.equal(result.ok, true);
    assert.equal(result.value.score, 100);
    assert.ok(result.warnings.some((w) => /clamp/i.test(w)));
  });

  test('a negative score is clamped to zero', () => {
    const result = parseScoreResponse(json({ ...VALID, score: -20 }));

    assert.equal(result.ok, true);
    assert.equal(result.value.score, 0);
  });

  test('a fractional score is rounded to an integer', () => {
    const result = parseScoreResponse(json({ ...VALID, score: 87.6 }));

    assert.equal(result.ok, true);
    assert.equal(result.value.score, 88);
  });

  test('the boundary scores survive untouched', () => {
    for (const score of [0, 40, 74, 75, 100]) {
      const result = parseScoreResponse(json({ ...VALID, score }));
      assert.equal(result.value.score, score);
    }
  });

  test('over-long reasoning is truncated, not rejected', () => {
    const result = parseScoreResponse(json({ ...VALID, reasoning: 'x'.repeat(5000) }));

    assert.equal(result.ok, true);
    assert.equal(result.value.reasoning.length, MAX_REASONING_LENGTH);
    assert.ok(result.warnings.some((w) => /reasoning/i.test(w)));
  });

  test('an over-long recommended action is truncated', () => {
    const result = parseScoreResponse(json({ ...VALID, recommended_action: 'y'.repeat(5000) }));

    assert.equal(result.value.recommended_action.length, MAX_ACTION_LENGTH);
  });

  test('a clean response reports no warnings', () => {
    assert.deepEqual(parseScoreResponse(json(VALID)).warnings, []);
  });
});

describe('buildScorePatch — applying a validated score', () => {
  test('writes the score, the derived temperature and the model text', () => {
    const patch = buildScorePatch(VALID, { temperature: 'HOT' });

    assert.equal(patch.lead_score, 82);
    assert.equal(patch.lead_temperature, 'HOT');
    assert.equal(patch.ai_reasoning, VALID.reasoning);
    assert.equal(patch.recommended_action, VALID.recommended_action);
  });

  test('a HIGH-confidence clean score needs no human', () => {
    const patch = buildScorePatch(VALID, { temperature: 'HOT' });

    assert.equal(patch.needs_human_review, false);
    assert.equal(patch.review_reason, null);
    assert.equal(patch.crm_status, 'QUALIFIED');
  });

  test('LOW confidence flags for review but keeps the score (spec 5.3)', () => {
    const patch = buildScorePatch({ ...VALID, confidence: 'LOW' }, { temperature: 'HOT' });

    assert.equal(patch.lead_score, 82, 'the score is kept');
    assert.equal(patch.needs_human_review, true);
    assert.match(patch.review_reason, /low_confidence/);
  });

  test('the model asking for review is honoured', () => {
    const patch = buildScorePatch({ ...VALID, needs_human_review: true }, { temperature: 'WARM' });

    assert.equal(patch.needs_human_review, true);
    assert.match(patch.review_reason, /model_requested_review/);
  });

  test('an existing review reason from earlier in the pipeline is preserved', () => {
    // Injection was detected during sanitisation; scoring must not clear it.
    const patch = buildScorePatch(VALID, {
      temperature: 'HOT',
      existingReviewReason: 'possible_prompt_injection',
    });

    assert.equal(patch.needs_human_review, true);
    assert.match(patch.review_reason, /possible_prompt_injection/);
  });

  test('a flagged lead is routed to HUMAN_REVIEW rather than QUALIFIED', () => {
    const patch = buildScorePatch({ ...VALID, confidence: 'LOW' }, { temperature: 'HOT' });
    assert.equal(patch.crm_status, 'HUMAN_REVIEW');
  });

  test('the patch never contains a field outside the leads table', () => {
    const patch = buildScorePatch(VALID, { temperature: 'HOT' });
    const columns = [
      'lead_score', 'lead_temperature', 'ai_reasoning', 'recommended_action',
      'crm_status', 'needs_human_review', 'review_reason',
    ];

    for (const key of Object.keys(patch)) {
      assert.ok(columns.includes(key), `${key} is not a leads column`);
    }
  });
});

describe('buildScoreFailurePatch — the model misbehaved twice (spec 5.3)', () => {
  test('routes to human review and says why', () => {
    const patch = buildScoreFailurePatch();

    assert.equal(patch.crm_status, 'HUMAN_REVIEW');
    assert.equal(patch.needs_human_review, true);
    assert.match(patch.review_reason, /ai_score_invalid/);
  });

  test('leaves the score null rather than inventing one', () => {
    const patch = buildScoreFailurePatch();

    assert.equal(patch.lead_score, null);
    assert.equal(patch.lead_temperature, null);
  });

  test('a provider failure reason is recorded when given', () => {
    const patch = buildScoreFailurePatch({ reason: 'provider_unavailable' });
    assert.match(patch.review_reason, /provider_unavailable/);
  });
});
