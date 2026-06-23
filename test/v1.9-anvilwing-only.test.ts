/**
 * Repo-wide single-model lock: anvilwing is the ONLY model and anvilwing
 * the ONLY provider. The product previously carried multi-model/multi-provider
 * scaffolding (env-var model override, an xai fallback, a context-window table
 * full of gpt/claude/gemini/grok/llama entries, a /model command). The user
 * requirement: "anvilwing must be the only model repo wide; and anvilwing
 * the only provider repo wide."
 *
 * Behavioral coverage for the config lock is the ts-node test in
 * config.modelSelection.test.ts; the window table is in context-usage.test.ts.
 * This file pins the source-level contract so a future re-introduction of
 * another model/provider fails CI.
 */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';

// config.ts uses import.meta (not jest-importable in-process — see the
// testing-runtime convention), so the lock constants are asserted from source.

const REPO = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(REPO, ...p), 'utf8');

const CONFIG = read('src', 'config.ts');
const CONTEXT_WINDOW = read('src', 'core', 'contextWindow.ts');
const MODEL_DISCOVERY = read('src', 'core', 'modelDiscovery.ts');
const CONTROLLER = read('src', 'runtime', 'agentController.ts');
const PROVIDER = read('src', 'providers', 'openaiChatCompletionsProvider.ts');
const SCHEMAS = JSON.parse(read('src', 'contracts', 'agent-schemas.json'));
const PLUGINS_INDEX = read('src', 'plugins', 'providers', 'index.ts');

describe('the lock constants are exactly anvilwing / anvilwing', () => {
  test('LOCKED_MODEL and LOCKED_PROVIDER', () => {
    expect(CONFIG).toMatch(/export const LOCKED_MODEL = 'anvilwing';/);
    expect(CONFIG).toMatch(/export const LOCKED_PROVIDER: ProviderId = 'anvilwing';/);
  });

  test('resolveProfileConfig pins model + provider to the lock constants', () => {
    expect(CONFIG).toMatch(/const model = LOCKED_MODEL;/);
    expect(CONFIG).toMatch(/const provider = LOCKED_PROVIDER;/);
    // The env override no longer feeds the model/provider (only logs that it's ignored).
    expect(CONFIG).not.toMatch(/const model = modelLocked \? modelEnv/);
  });
});

describe('agent-schemas.json declares anvilwing only', () => {
  test('exactly one model — anvilwing', () => {
    expect(SCHEMAS.models).toHaveLength(1);
    expect(SCHEMAS.models[0].id).toBe('anvilwing');
  });

  test('exactly one provider — anvilwing', () => {
    expect(SCHEMAS.providers).toHaveLength(1);
    expect(SCHEMAS.providers[0].id).toBe('anvilwing');
  });

  test('the /model command (model switching) is gone', () => {
    const cmds = SCHEMAS.slashCommands.map((c: { command: string }) => c.command);
    expect(cmds).not.toContain('/model');
  });

  test('every profile defaults to the locked model + provider', () => {
    for (const p of SCHEMAS.profiles) {
      expect(p.defaultModel).toBe('anvilwing');
      expect(p.defaultProvider).toBe('anvilwing');
    }
  });
});

describe('no non-anvilwing model/provider plumbing remains', () => {
  test('the context-window table has no gpt/claude/gemini/grok/llama entries', () => {
    for (const m of ['gpt-', 'claude-', 'gemini', 'grok', 'llama', 'mistral', 'qwen', 'o1', 'o3']) {
      expect(CONTEXT_WINDOW.toLowerCase()).not.toContain(m);
    }
  });

  test('modelDiscovery carries no alternate model fallback or priority', () => {
    expect(MODEL_DISCOVERY).not.toMatch(/anvilwing-chat/);
    expect(MODEL_DISCOVERY).not.toMatch(/anvilwing-coder/);
    expect(MODEL_DISCOVERY).toMatch(/fallbackModels: \[\]/);
  });

  test('agentController has no xai (or any non-anvilwing) fallback provider', () => {
    expect(CONTROLLER).not.toMatch(/'xai'/);
    expect(CONTROLLER).toMatch(/preferenceOrder: ProviderId\[\] = \['anvilwing'\]/);
  });

  test('switchModel coerces to the lock (defense in depth)', () => {
    // Scope to the switchModel body: whatever ModelConfig a caller passes, the
    // selection pins to the lock. (buildInitialSelection legitimately reads the
    // already-resolved+locked profileConfig, so it's out of scope here.)
    const body = CONTROLLER.slice(
      CONTROLLER.indexOf('async switchModel('),
      CONTROLLER.indexOf('getCapabilities()'),
    );
    expect(body).toMatch(/provider: LOCKED_PROVIDER,\s*\n\s*model: LOCKED_MODEL,/);
    expect(body).not.toMatch(/provider: config\.provider/);
  });

  test('the provider base-URL allowlist is the upstream host + localhost only', () => {
    expect(PROVIDER).not.toMatch(/api\.openai\.com/);
    expect(PROVIDER).not.toMatch(/api\.anthropic\.com/);
    expect(PROVIDER).not.toMatch(/api\.x\.ai/);
    expect(PROVIDER).not.toMatch(/openrouter\.ai/);
    // Upstream host is kept under the hood (Anvilwing is a white-label over it).
    expect(PROVIDER).toMatch(/'api\.deepseek\.com'/);
  });

  test('only the anvilwing provider plugin is registered', () => {
    expect(PLUGINS_INDEX).toMatch(/registerAnvilwingProviderPlugin/);
    expect(PLUGINS_INDEX).not.toMatch(/registerOpenAI|registerAnthropic|registerXai|registerGrok|registerGemini/i);
  });
});
