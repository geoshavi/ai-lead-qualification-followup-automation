import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS, scoreToTemperature, thresholdsFromEnv } from '../src/core/temperature.js';

describe('score to temperature (spec 5.1)', () => {
  test('defaults are 75 and 40', () => {
    assert.deepEqual(DEFAULT_THRESHOLDS, { hot: 75, warm: 40 });
  });

  const cases = [
    [100, 'HOT'], [76, 'HOT'], [75, 'HOT'],
    [74, 'WARM'], [57, 'WARM'], [41, 'WARM'], [40, 'WARM'],
    [39, 'COLD'], [1, 'COLD'], [0, 'COLD'],
  ];

  for (const [score, expected] of cases) {
    test(`${score} is ${expected}`, () => {
      assert.equal(scoreToTemperature(score), expected);
    });
  }

  test('the boundaries are inclusive at the bottom of each band', () => {
    assert.equal(scoreToTemperature(75), 'HOT');
    assert.equal(scoreToTemperature(74.9), 'HOT', '74.9 rounds to 75');
    assert.equal(scoreToTemperature(74.4), 'WARM');
    assert.equal(scoreToTemperature(40), 'WARM');
    assert.equal(scoreToTemperature(39.5), 'WARM', '39.5 rounds to 40');
    assert.equal(scoreToTemperature(39.4), 'COLD');
  });
});

describe('defensive handling', () => {
  test('out-of-range scores are clamped, not trusted', () => {
    assert.equal(scoreToTemperature(9000), 'HOT');
    assert.equal(scoreToTemperature(-50), 'COLD');
  });

  test('numeric strings are accepted', () => {
    assert.equal(scoreToTemperature('80'), 'HOT');
  });

  test('non-numeric input throws rather than silently becoming COLD', () => {
    for (const bad of ['abc', null, undefined, NaN, {}, Infinity]) {
      assert.throws(() => scoreToTemperature(bad), TypeError, `expected a throw for ${String(bad)}`);
    }
  });

  test('inverted thresholds are rejected', () => {
    assert.throws(() => scoreToTemperature(50, { hot: 30, warm: 60 }), RangeError);
  });

  test('non-finite thresholds are rejected', () => {
    assert.throws(() => scoreToTemperature(50, { hot: 'high' }), TypeError);
  });
});

describe('custom thresholds', () => {
  test('HOT_SCORE_THRESHOLD moves the HOT cutoff', () => {
    assert.equal(scoreToTemperature(70, { hot: 65 }), 'HOT');
    assert.equal(scoreToTemperature(70), 'WARM');
  });

  test('thresholdsFromEnv reads the environment', () => {
    assert.deepEqual(thresholdsFromEnv({ HOT_SCORE_THRESHOLD: '65' }), { hot: 65, warm: 40 });
  });

  test('thresholdsFromEnv falls back to the spec default on junk', () => {
    for (const value of ['', 'abc', null, undefined]) {
      assert.deepEqual(
        thresholdsFromEnv({ HOT_SCORE_THRESHOLD: value }),
        { hot: 75, warm: 40 },
        `a typo of ${JSON.stringify(value)} must not reclassify every lead`,
      );
    }
    assert.deepEqual(thresholdsFromEnv({}), { hot: 75, warm: 40 });
    assert.deepEqual(thresholdsFromEnv(undefined), { hot: 75, warm: 40 });
  });
});
