/**
 * The anvilwing profile's system prompt drives real model behavior, so
 * its shape is pinned here. Two failures this catches:
 *
 *  1. PHANTOM TOOLS: the old template ordered the model to call
 *     `MarkExplorationComplete` / `ProposePlan` and to "wait for plan approval"
 *     — none of which exist (0 source references) or happen in the auto-running
 *     CLI. The model improvised a heavy explore/plan/verify ritual, which on
 *     simple tasks turned into redundant re-verification. The prompt must NOT
 *     reference tools that aren't real.
 *  2. OVER-VERIFICATION: a real run showed the agent re-reading a file it had
 *     just written, byte-by-byte, turn after turn. The prompt must tell it to
 *     finish once and stop.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read the schema JSON directly — agentSchemaLoader uses import.meta and isn't
// jest-importable in-process (same constraint as the rest of the runtime graph).
const template = (() => {
  const raw = readFileSync(resolve(__dirname, '..', '..', 'src', 'contracts', 'agent-schemas.json'), 'utf8');
  const s = JSON.parse(raw);
  const p = s.profiles.find((e: { defaultModel?: string }) => e.defaultModel === 'anvilwing') ?? s.profiles[0];
  const cfg = p.systemPrompt as { type: string; template?: string; content?: string };
  return cfg.template ?? cfg.content ?? '';
})();

describe('anvilwing system prompt', () => {
  test('references no phantom tools / dead approval gate', () => {
    expect(template).not.toMatch(/MarkExplorationComplete/);
    expect(template).not.toMatch(/ProposePlan/);
    expect(template).not.toMatch(/Wait for plan approval/i);
    // The old rigid "for ANY non-trivial task, you MUST" workflow is gone.
    expect(template).not.toMatch(/For ANY non-trivial task, you MUST/i);
  });

  test('tells the agent to match effort to the task (do simple work directly)', () => {
    expect(template).toMatch(/Match effort to the task/i);
    expect(template).toMatch(/just do it, directly and immediately/i);
  });

  test('tells the agent to UNDERSTAND first, then choose the simplest sensible approach', () => {
    expect(template).toMatch(/Understand the request, then choose the best approach/i);
    expect(template).toMatch(/Get the request RIGHT first/i);
    expect(template).toMatch(/SIMPLEST approach that fully solves it/i);
  });

  test('tells the agent to keep the user in the loop (narrate plan + strategy changes)', () => {
    expect(template).toMatch(/Keep the user in the loop/i);
    expect(template).toMatch(/what you understood and the approach you're taking/i);
    expect(template).toMatch(/never narrate every keystroke, never go silent/i);
    expect(template).toMatch(/change strategy mid-task, say why/i);
  });

  test('tells the agent to finish once and stop (no redundant re-verification)', () => {
    expect(template).toMatch(/Finish once, then stop/i);
    // The completion contract evolved to a machine-detectable DONE: sentinel
    // (one passing command IS the proof; nothing may follow the DONE line).
    expect(template).toMatch(/DONE:/);
    expect(template).toMatch(/Do not re-read, re-open, or re-describe a file you just wrote/i);
    expect(template).toMatch(/byte counts, hex dumps, or repeated confirmations/i);
  });

  test('keeps the load-bearing style rules', () => {
    expect(template).toMatch(/complete, working code/i);
    expect(template).toMatch(/Continue through recoverable errors autonomously/i);
  });
});
