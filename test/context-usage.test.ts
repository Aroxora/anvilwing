/**
 * /context usage view + the accurate "% context left" chrome indicator.
 *
 * Two real bugs are fixed and guarded here:
 *  1. anvilwing fell through to the generic /^anvilwing/ 64K window, so
 *     the context manager AND the "% context left" indicator were sized for
 *     the wrong window. A specific anvilwing-v4 entry fixes it — 1M tokens,
 *     per the product spec (README: "Anvilwing v4 Pro, 1M context"). The
 *     interim 131_072 value made every threshold fire ~8× early.
 *  2. The shell hard-coded tokenLimit:200000 for the indicator; it now uses
 *     the real model window and the provider's input-token count.
 *
 * computeContextUsage is pure → tested directly. Source assertions lock the
 * shell wiring (real window, /context handler) and the App inline-panel block
 * (whose absence made /help · /keys · /context bodies invisible).
 */

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { getModelContextInfo } from '../src/core/contextWindow.js';
import { computeContextUsage, estimateMessageTokens, formatTokenCount } from '../src/core/contextUsage.js';
import type { ConversationMessage } from '../src/core/types.js';

const REPO = resolve(__dirname, '..');
const SHELL = readFileSync(join(REPO, 'src', 'headless', 'interactiveShell.ts'), 'utf8');
const APP = readFileSync(join(REPO, 'src', 'ui', 'ink', 'App.tsx'), 'utf8');

describe('contextWindow — anvilwing-v4 has the correct 1M window', () => {
  test('anvilwing resolves to 1,048,576 (2^20 — the confirmed spec, not 64K/131K)', () => {
    const info = getModelContextInfo('anvilwing');
    expect(info.contextWindow).toBe(1_048_576);
    expect(info.isDefault).toBe(false);
  });

  test('the model table is anvilwing-v4 only — every other string hits the default', () => {
    // Single-model product: the multi-model table was removed. anvilwing-chat,
    // gpt-4, claude, etc. all fall through to the conservative default and are
    // flagged isDefault (the product never reaches this — the model is locked
    // in config.ts — but the table must not advertise other models).
    for (const m of ['anvilwing-chat', 'anvilwing-coder', 'gpt-4o', 'claude-opus-4', 'grok', 'gemini-1.5-pro']) {
      const info = getModelContextInfo(m);
      expect(info.contextWindow).toBe(128_000); // DEFAULT_CONTEXT_WINDOW
      expect(info.isDefault).toBe(true);
    }
    // Only the locked model resolves to a non-default window.
    expect(getModelContextInfo('anvilwing').isDefault).toBe(false);
  });

  test('thresholds scale to the 1M window (pruning no longer fires ~8× early)', async () => {
    const { calculateContextThresholds } = await import('../src/core/contextWindow.js');
    const t = calculateContextThresholds('anvilwing');
    expect(t.maxTokens).toBe(Math.floor(1_048_576 * 0.95));      // 996,147
    expect(t.targetTokens).toBe(Math.floor(1_048_576 * 0.60));   // 629,145 — pruning start
    expect(t.warningTokens).toBe(524_288);
    expect(t.criticalTokens).toBe(786_432);
  });
});

describe('computeContextUsage', () => {
  const sys: ConversationMessage = { role: 'system', content: 'x'.repeat(400) }; // ~100 tokens
  const user: ConversationMessage = { role: 'user', content: 'y'.repeat(40) };   // ~10 tokens
  const asst: ConversationMessage = { role: 'assistant', content: 'z'.repeat(80) }; // ~20 tokens

  test('empty history against a real window → 0 used, 100% left, estimated', () => {
    const u = computeContextUsage([], 131_072);
    expect(u.usedTokens).toBe(0);
    expect(u.freeTokens).toBe(131_072);
    expect(u.percentUsed).toBe(0);
    expect(u.percentLeft).toBe(100);
    expect(u.messageCount).toBe(0);
    expect(u.estimated).toBe(true);
  });

  test('estimate splits system vs conversation and counts non-system messages', () => {
    const u = computeContextUsage([sys, user, asst], 131_072);
    expect(u.systemTokens).toBe(estimateMessageTokens(sys));
    expect(u.conversationTokens).toBe(estimateMessageTokens(user) + estimateMessageTokens(asst));
    expect(u.usedTokens).toBe(u.systemTokens + u.conversationTokens);
    expect(u.messageCount).toBe(2); // system is not counted as a message
    expect(u.estimated).toBe(true);
  });

  test('a real provider input-token count overrides the estimate', () => {
    const u = computeContextUsage([sys, user, asst], 100_000, 25_000);
    expect(u.usedTokens).toBe(25_000);
    expect(u.percentUsed).toBe(25);
    expect(u.percentLeft).toBe(75);
    expect(u.estimated).toBe(false);
  });

  test('used is clamped to the window (never negative free / >100%)', () => {
    const u = computeContextUsage([], 100_000, 250_000);
    expect(u.usedTokens).toBe(100_000);
    expect(u.freeTokens).toBe(0);
    expect(u.percentUsed).toBe(100);
    expect(u.percentLeft).toBe(0);
  });

  test('a zero/invalid window does not divide-by-zero', () => {
    const u = computeContextUsage([user], 0, null);
    expect(Number.isFinite(u.percentUsed)).toBe(true);
    expect(u.windowTokens).toBeGreaterThan(0);
  });
});

describe('estimateMessageTokens + formatTokenCount', () => {
  test('content is char/4; tool calls add name + serialized-args overhead', () => {
    expect(estimateMessageTokens({ role: 'user', content: 'abcd' })).toBe(1);
    const withTool: ConversationMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: '1', name: 'Read', arguments: { path: 'a.ts' } }],
    } as ConversationMessage;
    expect(estimateMessageTokens(withTool)).toBeGreaterThan(0);
  });

  test('formatTokenCount groups thousands', () => {
    expect(formatTokenCount(131_072)).toBe('131,072');
    expect(formatTokenCount(0)).toBe('0');
  });
});

describe('source wiring locked', () => {
  test('shell uses the real model window for the indicator (no hardcoded 200000)', () => {
    expect(SHELL).toMatch(/getModelContextInfo\(this\.profileConfig\.model\)\.contextWindow/);
    expect(SHELL).not.toMatch(/tokenLimit:\s*200000/);
  });

  test('shell registers /context and renders the usage panel', () => {
    expect(SHELL).toMatch(/lower === '\/context'/);
    expect(SHELL).toMatch(/private showContext\(\)/);
    expect(SHELL).toMatch(/computeContextUsage\(/);
  });

  test('App renders the inline panel as a block (the bug: bodies were invisible)', () => {
    expect(APP).toMatch(/inlinePanel\?: string\[\]/);
    expect(APP).toMatch(/inlinePanel && inlinePanel\.length > 0/);
  });
});
