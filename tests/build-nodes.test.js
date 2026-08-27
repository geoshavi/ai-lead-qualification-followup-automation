/**
 * build-nodes.test.js — the build step spec section 1 requires.
 *
 * Two things this file proves, and they are different claims:
 *
 * 1. The TRANSFORM is correct: `stripEsModuleSyntax` turns a real
 *    src/core/*.js file into something a Code node can execute — no import,
 *    no export, same behaviour — without corrupting anything that merely
 *    contains the word "export" in a comment or string.
 *
 * 2. dist/nodes/ is NOT STALE: per the approved decision, the generated
 *    snippets are committed as an explicit M4 deliverable, so nothing enforces
 *    them staying in sync except a test that recomputes the transform from the
 *    current src/core/ and diffs it against what is checked in. Editing
 *    src/core/ without re-running `npm run build:nodes` fails this file.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

import { buildSnippetHeader, listCoreModules, stripEsModuleSyntax } from '../scripts/build-nodes.js';

const ROOT = join(import.meta.dirname, '..');
const CORE_DIR = join(ROOT, 'src', 'core');
const DIST_DIR = join(ROOT, 'dist', 'nodes');

// ---------------------------------------------------------------------------
// stripEsModuleSyntax — the pure transform
// ---------------------------------------------------------------------------
describe('stripEsModuleSyntax', () => {
  test('removes "export " from an export const declaration', () => {
    assert.equal(stripEsModuleSyntax('export const X = 1;\n'), 'const X = 1;\n');
  });

  test('removes "export " from an export function declaration', () => {
    assert.equal(stripEsModuleSyntax('export function foo() {}\n'), 'function foo() {}\n');
  });

  test('removes "export " from an export class declaration', () => {
    assert.equal(stripEsModuleSyntax('export class Foo {}\n'), 'class Foo {}\n');
  });

  test('leaves a line untouched when export is not at line start', () => {
    const line = '  // you can export this result downstream\n';
    assert.equal(stripEsModuleSyntax(line), line);
  });

  test('does not touch the word "export" inside a string literal', () => {
    const line = "const msg = 'export this carefully';\n";
    assert.equal(stripEsModuleSyntax(line), line);
  });

  test('does not touch "export" inside a block comment', () => {
    const block = '/**\n * export means something specific here.\n */\n';
    assert.equal(stripEsModuleSyntax(block), block);
  });

  test('rejects a bare "export default" — no core module may use it', () => {
    assert.throws(() => stripEsModuleSyntax('export default foo;\n'), /export default/);
  });

  test('rejects a bare "export { a, b }" — no core module may use it', () => {
    assert.throws(() => stripEsModuleSyntax('export { a, b };\n'), /export \{/);
  });

  test('rejects any remaining "import" statement', () => {
    assert.throws(() => stripEsModuleSyntax("import { x } from './y.js';\n"), /import/);
  });

  test('every real core module transforms with no import/export left', () => {
    for (const file of listCoreModules(CORE_DIR)) {
      const source = readFileSync(join(CORE_DIR, file), 'utf8');
      const transformed = stripEsModuleSyntax(source);

      assert.doesNotMatch(transformed, /^\s*export\s/m, `${file}: export survived the transform`);
      assert.doesNotMatch(transformed, /^\s*import\s/m, `${file}: import survived the transform`);
    }
  });
});

// ---------------------------------------------------------------------------
// buildSnippetHeader — the "never hand-edit dist/" banner
// ---------------------------------------------------------------------------
describe('buildSnippetHeader', () => {
  test('names the source file and warns against hand-editing', () => {
    const header = buildSnippetHeader('sanitize.js');

    assert.match(header, /src\/core\/sanitize\.js/);
    assert.match(header, /GENERATED/i);
    assert.match(header, /do not edit/i);
    assert.match(header, /npm run build:nodes/);
  });
});

// ---------------------------------------------------------------------------
// Behavioural fidelity — the snippet is not just syntactically valid, it
// behaves exactly like the module it was generated from.
// ---------------------------------------------------------------------------
describe('a generated snippet behaves identically to its source module', () => {
  test('the transformed schema.js snippet builds the same lead as the real module', async () => {
    const source = readFileSync(join(CORE_DIR, 'schema.js'), 'utf8');
    const snippet = stripEsModuleSyntax(source);

    const sandbox = {};
    vm.createContext(sandbox);
    new vm.Script(snippet, { filename: 'schema.snippet.js' }).runInContext(sandbox);

    const real = await import('../src/core/schema.js');

    // deepEqual across a vm realm boundary fails on prototype identity even
    // when every value matches (Node: "same structure but not reference-equal")
    // — these are plain data objects, so a JSON round-trip is a safe,
    // same-realm way to compare values without caring which realm's
    // Object.prototype produced them.
    assert.deepEqual(
      JSON.stringify(sandbox.createLead({ source: 'website', email: 'ada@example.com' })),
      JSON.stringify(real.createLead({ source: 'website', email: 'ada@example.com' })),
    );
  });

  test('the transformed webhookAuth.js snippet rejects the same inputs the real module does', async () => {
    const source = readFileSync(join(CORE_DIR, 'webhookAuth.js'), 'utf8');
    const snippet = stripEsModuleSyntax(source);

    const sandbox = {};
    vm.createContext(sandbox);
    new vm.Script(snippet, { filename: 'webhookAuth.snippet.js' }).runInContext(sandbox);

    const real = await import('../src/core/webhookAuth.js');
    const input = { receivedToken: 'wrong', expectedSecret: 'right' };

    assert.deepEqual(
      JSON.stringify(sandbox.verifyWebhookToken(input)),
      JSON.stringify(real.verifyWebhookToken(input)),
    );
  });

  test('the transformed temperature.js snippet derives the same band at every boundary', async () => {
    const source = readFileSync(join(CORE_DIR, 'temperature.js'), 'utf8');
    const snippet = stripEsModuleSyntax(source);

    const sandbox = {};
    vm.createContext(sandbox);
    new vm.Script(snippet, { filename: 'temperature.snippet.js' }).runInContext(sandbox);

    const real = await import('../src/core/temperature.js');

    for (const score of [0, 39, 40, 74, 75, 100]) {
      assert.equal(sandbox.scoreToTemperature(score), real.scoreToTemperature(score));
    }
  });
});

// ---------------------------------------------------------------------------
// dist/nodes/ freshness — committed generated output must match src/core/ now
// ---------------------------------------------------------------------------
describe('dist/nodes/ is not stale (spec: generated output is a committed M4 deliverable)', () => {
  const coreModules = listCoreModules(CORE_DIR);

  test('dist/nodes/ exists', () => {
    assert.doesNotThrow(() => readdirSync(DIST_DIR), 'run `npm run build:nodes` — dist/nodes/ has not been generated yet');
  });

  test('dist/nodes/ contains exactly one snippet per core module, no extras, none missing', () => {
    const generated = readdirSync(DIST_DIR).filter((f) => f.endsWith('.js')).sort();
    assert.deepEqual(generated, [...coreModules].sort());
  });

  for (const file of listCoreModules(CORE_DIR)) {
    test(`dist/nodes/${file} matches a fresh build of src/core/${file}`, () => {
      const currentSource = readFileSync(join(CORE_DIR, file), 'utf8');
      const expected = buildSnippetHeader(file) + stripEsModuleSyntax(currentSource);
      const committed = readFileSync(join(DIST_DIR, file), 'utf8');

      assert.equal(
        committed,
        expected,
        `dist/nodes/${file} is stale — src/core/${file} changed since the last \`npm run build:nodes\``,
      );
    });
  }

  test('every committed snippet is still syntactically valid on its own', () => {
    for (const file of listCoreModules(CORE_DIR)) {
      const snippet = readFileSync(join(DIST_DIR, file), 'utf8');
      assert.doesNotThrow(
        () => new vm.Script(snippet, { filename: file }),
        `dist/nodes/${file} does not parse as a plain script`,
      );
    }
  });
});
