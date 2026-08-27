#!/usr/bin/env node
/**
 * build-nodes.js — the build step spec section 1 requires.
 *
 * n8n Code nodes cannot `require()` or `import` a local project file. Every
 * module in src/core/ is already zero-import for exactly that reason; the
 * only thing standing between it and being pasteable is the `export` keyword,
 * which is a syntax error in the plain-script context a Code node executes.
 *
 * This is developer/agent tooling (spec section 13.1) — it runs on the
 * developer's machine, never inside n8n, and its OUTPUT (dist/nodes/) is the
 * only thing a Code node ever sees.
 *
 * src/core/ remains the sole source of truth. dist/nodes/ is generated and
 * committed as an explicit M4 deliverable — never hand-edit it; re-run
 * `npm run build:nodes` instead. tests/build-nodes.test.js fails the moment
 * dist/nodes/ drifts from a fresh build of src/core/, so a forgotten rebuild
 * cannot silently ship a stale snippet.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const CORE_DIR = join(ROOT, 'src', 'core');
export const DIST_DIR = join(ROOT, 'dist', 'nodes');

/** Every core module, in the same sorted order tests/core-contract.test.js pins. */
export function listCoreModules(coreDir) {
  return readdirSync(coreDir).filter((f) => f.endsWith('.js')).sort();
}

/**
 * Turn one line of ES module syntax into plain script syntax, or refuse.
 *
 * Only `export const`, `export function` and `export class` are rewritten —
 * that is the entire vocabulary every core module actually uses (enforced by
 * this function itself: anything else with a leading `export`/`import` is a
 * hard error, not silently passed through). `export default` and
 * `export { a, b }` would need a different rewrite than a keyword strip and
 * no core module is written that way, so both are rejected rather than
 * mishandled.
 */
const EXPORT_DECL = /^(\s*)export (const|function|class)\b/;
const EXPORT_OTHER = /^\s*export\b/;
const IMPORT_STMT = /^\s*import\b/;

export function stripEsModuleSyntax(source) {
  return source
    .split('\n')
    .map((line, index) => {
      if (IMPORT_STMT.test(line)) {
        throw new Error(`build-nodes: unexpected "import" at line ${index + 1} — a Code node cannot resolve one`);
      }
      if (EXPORT_DECL.test(line)) {
        return line.replace(EXPORT_DECL, '$1$2');
      }
      if (EXPORT_OTHER.test(line)) {
        throw new Error(
          `build-nodes: unsupported export form at line ${index + 1} — only "export const/function/class" is handled: ${line.trim()}`,
        );
      }
      return line;
    })
    .join('\n');
}

/** The "never hand-edit dist/" banner every generated snippet carries. */
export function buildSnippetHeader(fileName) {
  return [
    '// ============================================================================',
    `// GENERATED FILE — do not edit by hand.`,
    `// Source: src/core/${fileName}`,
    '// Regenerate with: npm run build:nodes',
    '//',
    '// This is the paste-ready body for an n8n Code node. src/core/ is the',
    '// source of truth; a hand edit here will be silently overwritten and will',
    '// not survive the next build (PROJECT_SPEC.md section 1).',
    '// ============================================================================',
    '',
  ].join('\n');
}

/** Build every snippet and write it to outDir. Returns the list of files written. */
export function buildAll({ coreDir = CORE_DIR, outDir = DIST_DIR } = {}) {
  mkdirSync(outDir, { recursive: true });

  const written = [];
  for (const file of listCoreModules(coreDir)) {
    const source = readFileSync(join(coreDir, file), 'utf8');
    const snippet = buildSnippetHeader(file) + stripEsModuleSyntax(source);
    writeFileSync(join(outDir, file), snippet, 'utf8');
    written.push(file);
  }
  return written;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const written = buildAll();
  for (const file of written) {
    console.log(`wrote dist/nodes/${file}`);
  }
  console.log(`${written.length} snippet(s) built.`);
}
