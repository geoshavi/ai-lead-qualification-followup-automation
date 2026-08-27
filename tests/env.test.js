import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** Minimal dotenv parser — the project stays dependency-free. */
function parseEnvFile(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return out;
}

const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8');
const env = parseEnvFile(envExample);

// Exactly the variables listed in PROJECT_SPEC.md section 12.
const SPEC_VARS = [
  'LLM_PROVIDER',
  'OLLAMA_BASE_URL',
  'OLLAMA_MODEL',
  'LLM_TIMEOUT_MS',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'CRM_ADAPTER',
  'WEBHOOK_SECRET',
  'SLACK_WEBHOOK_URL',
  'GOOGLE_SHEET_ID',
  'BUSINESS_TZ',
  'HOT_SCORE_THRESHOLD',
  'DRY_RUN',
];

describe('.env.example matches the spec', () => {
  test('declares every variable in section 12 and no others', () => {
    assert.deepEqual([...env.keys()].sort(), [...SPEC_VARS].sort());
  });
});

describe('$0 development defaults', () => {
  test('LLM provider defaults to local Ollama', () => {
    assert.equal(env.get('LLM_PROVIDER'), 'ollama');
    assert.equal(env.get('OLLAMA_BASE_URL'), 'http://127.0.0.1:11434');
    assert.equal(env.get('OLLAMA_MODEL'), 'qwen2.5:7b-instruct');
  });

  test('persistence defaults to the local mock adapter', () => {
    assert.equal(env.get('CRM_ADAPTER'), 'mock');
  });

  test('dry-run is on by default so nothing is sent during development', () => {
    assert.equal(env.get('DRY_RUN'), 'true');
  });

  test('business rule defaults are set', () => {
    assert.equal(env.get('BUSINESS_TZ'), 'America/Los_Angeles');
    assert.equal(env.get('HOT_SCORE_THRESHOLD'), '75');
    assert.equal(env.get('LLM_TIMEOUT_MS'), '30000');
  });

  test('no paid-provider variable is required by the default path', () => {
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'OPENAI_API_KEY', 'OPENAI_MODEL']) {
      assert.equal(env.get(key), '', `${key} must be an empty placeholder`);
    }
  });
});

describe('no credentials leak through the template', () => {
  test('every secret-bearing variable is an empty placeholder', () => {
    const secretVars = [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_KEY',
      'WEBHOOK_SECRET',
      'SLACK_WEBHOOK_URL',
      'GOOGLE_SHEET_ID',
    ];
    for (const key of secretVars) {
      assert.equal(env.get(key), '', `${key} must never carry a real value in .env.example`);
    }
  });

  test('.gitignore excludes .env but keeps .env.example', () => {
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    const lines = gitignore.split(/\r?\n/).map((l) => l.trim());
    assert.ok(lines.includes('.env'), '.gitignore must ignore .env');
    assert.ok(lines.includes('!.env.example'), '.gitignore must keep .env.example tracked');
  });
});
