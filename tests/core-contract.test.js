import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const CORE_DIR = join(ROOT, 'src', 'core');

const coreFiles = readdirSync(CORE_DIR).filter((f) => f.endsWith('.js')).sort();

/** Remove comments and string literals so keywords inside prose are not matched. */
function stripCommentsAndStrings(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')     // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ') // line comments, sparing protocol-relative URLs
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''") // single-quoted strings
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""') // double-quoted strings
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');  // template literals
}

describe('src/core is dependency-free (spec 1 and 0.4)', () => {
  test('the expected seven modules exist', () => {
    assert.deepEqual(coreFiles, [
      'dedupe.js',
      'followup.js',
      'normalize.js',
      'sanitize.js',
      'schema.js',
      'temperature.js',
      'validate.js',
    ]);
  });

  for (const file of coreFiles) {
    test(`${file} has no import statement`, () => {
      const code = stripCommentsAndStrings(readFileSync(join(CORE_DIR, file), 'utf8'));
      assert.doesNotMatch(code, /^\s*import\s/m, 'a Code node cannot resolve an import');
      assert.doesNotMatch(code, /\bimport\s*\(/, 'dynamic import is unavailable in a Code node too');
    });

    test(`${file} does not call require()`, () => {
      const code = stripCommentsAndStrings(readFileSync(join(CORE_DIR, file), 'utf8'));
      assert.doesNotMatch(code, /\brequire\s*\(/, 'a Code node cannot require() local files');
    });

    test(`${file} exports something`, () => {
      const code = readFileSync(join(CORE_DIR, file), 'utf8');
      assert.match(code, /^export /m, 'a module with no exports cannot be composed or tested');
    });
  }
});

describe('the project itself has no npm dependencies', () => {
  test('package.json declares neither dependencies nor devDependencies', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.dependencies, {});
    assert.deepEqual(pkg.devDependencies, {});
  });

  test('there is no lockfile, because there is nothing to lock', () => {
    const entries = readdirSync(ROOT);
    for (const lock of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']) {
      assert.ok(!entries.includes(lock), `${lock} should not exist`);
    }
  });
});

describe('core modules are pure with respect to the clock', () => {
  // Anything that reads the wall clock cannot be tested against a frozen time,
  // and would make dedupe keys and follow-up schedules unreproducible.
  for (const file of coreFiles) {
    test(`${file} never reads the ambient clock`, () => {
      const code = stripCommentsAndStrings(readFileSync(join(CORE_DIR, file), 'utf8'));
      assert.doesNotMatch(code, /\bDate\.now\s*\(/, 'take an injected `now` instead');
      assert.doesNotMatch(code, /\bnew\s+Date\s*\(\s*\)/, 'take an injected `now` instead');
      assert.doesNotMatch(code, /\bMath\.random\s*\(/, 'core logic must be deterministic');
    });
  }
});
