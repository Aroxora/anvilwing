/**
 * Degeneration cutoff — a real run streamed the SAME summary block ~30× over
 * 336s when the model fell into a repetition loop. The stream-level guard now
 * detects a contiguous repeated tail, cuts the stream early, and keeps one
 * copy + a marker, so a degenerate turn stops fast instead of churning.
 *
 * Unit + behavioural against the REAL AgentRuntime (real streaming loop, real
 * provider interface) — no mock stands in for the unit under test.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectRepetitionLoop, trimRepetition, wasRepetitionStopped, REPETITION_MARKER } from '../src/core/repetitionGuard';
import { AgentRuntime } from '../src/core/agent';
import { ContextManager } from '../src/core/contextManager';
import { ToolRuntime } from '../src/core/toolRuntime';
import type {
  ConversationMessage, LLMProvider, ProviderResponse, ProviderToolDefinition, StreamChunk,
} from '../src/core/types';

const AGENT_SRC = readFileSync(resolve(__dirname, '../src/core/agent.ts'), 'utf8');

describe('detectRepetitionLoop', () => {
  test('flags a contiguous repeated block (the degeneration signature)', () => {
    const unit = "Here's what was upgraded across 3 files and 11 vectors.\n";
    const text = 'Intro before the loop.\n' + unit.repeat(30);
    const r = detectRepetitionLoop(text);
    expect(r.looping).toBe(true);
    expect(r.repeats!).toBeGreaterThanOrEqual(8);
  });

  test('does NOT flag genuinely different paragraphs', () => {
    const text = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} has distinct content on line ${i}.`).join('\n');
    expect(detectRepetitionLoop(text).looping).toBe(false);
  });

  test('does NOT flag a few short repeats (below the threshold)', () => {
    expect(detectRepetitionLoop('console.log(x);\n'.repeat(5)).looping).toBe(false);
  });

  test('does NOT flag repeated whitespace/punctuation (no real content)', () => {
    expect(detectRepetitionLoop('\n\n\n\n\n\n\n\n\n\n'.repeat(20)).looping).toBe(false);
    expect(detectRepetitionLoop('-----------------------------\n'.repeat(20)).looping).toBe(false);
  });

  test('does NOT flag a single-char runaway run (that is the OOM limit\'s job, not a loop)', () => {
    // A degeneration loop repeats a BLOCK; "xxxx…" is runaway padding with no
    // character diversity and must be left to the runaway char-limit.
    expect(detectRepetitionLoop('x'.repeat(300_000)).looping).toBe(false);
    expect(detectRepetitionLoop('ab'.repeat(150_000)).looping).toBe(false);
  });

  test('trimRepetition keeps one copy + a marker', () => {
    const unit = 'The same sentence repeated over and over again here.\n';
    const text = 'head.\n' + unit.repeat(20);
    const trimmed = trimRepetition(text, unit, 20);
    expect(trimmed).toContain('head.');
    expect(trimmed).toContain('Response stopped');
    // The unit should appear once (the kept copy), not 20×.
    expect((trimmed.match(/The same sentence repeated/g) ?? []).length).toBe(1);
  });
});

function makeRuntime(provider: LLMProvider): AgentRuntime {
  return new AgentRuntime({
    provider,
    toolRuntime: new ToolRuntime([], { enableCache: false }),
    systemPrompt: 'test',
    contextManager: new ContextManager({ maxTokens: 100_000, targetTokens: 80_000 }),
    providerId: provider.id as string,
    modelId: provider.model as string,
    workingDirectory: process.cwd(),
    callbacks: {},
  });
}

/** Streams the same content block back-to-back many times — a repetition loop. */
class DegenerateStreamProvider implements LLMProvider {
  readonly id = 'degenerate' as const;
  readonly model = 'mock-degenerate';
  async generate(): Promise<ProviderResponse> { return { type: 'message', content: '', stopReason: 'stop' }; }
  async *generateStream(_m: ConversationMessage[], _t: ProviderToolDefinition[]): AsyncIterable<StreamChunk> {
    // ~150-char unit × 60 = ~9000 chars — past the 4000-char check interval, so
    // the cutoff fires with many contiguous copies accumulated.
    const unit = 'I have now finished upgrading the site across 3 files and 11 vectors, the build passes cleanly and everything is verified and complete here.\n';
    for (let i = 0; i < 60; i++) yield { type: 'content', content: unit };
    yield { type: 'done' };
  }
}

describe('the agent cuts a degeneration loop instead of streaming it forever', () => {
  test('the committed response is trimmed to one copy + the stopped marker', async () => {
    const out = await makeRuntime(new DegenerateStreamProvider()).send('go', true);
    expect(out).toContain('Response stopped');
    // 60 copies were streamed; the committed text must NOT keep them all.
    const copies = (out.match(/I have now finished upgrading the site/g) ?? []).length;
    expect(copies).toBeLessThanOrEqual(3);
  }, 20_000);

  test('source: the streaming loop calls detectRepetitionLoop and trims on a hit', () => {
    expect(AGENT_SRC).toMatch(/import \{ detectRepetitionLoop, trimRepetition \} from '\.\/repetitionGuard\.js'/);
    expect(AGENT_SRC).toMatch(/const rep = detectRepetitionLoop\(fullContent\);/);
    expect(AGENT_SRC).toMatch(/fullContent = trimRepetition\(fullContent, rep\.unit, rep\.repeats\);/);
    expect(AGENT_SRC).toMatch(/await closeStream\(\);\s*\n\s*break;/);
  });
});

describe('the multi-turn auto-continue loop ENDS on a degenerate turn', () => {
  const SHELL = readFileSync(resolve(__dirname, '../src/headless/interactiveShell.ts'), 'utf8');

  test('wasRepetitionStopped detects the trimmed marker', () => {
    expect(wasRepetitionStopped(`some content\n${REPETITION_MARKER}`)).toBe(true);
    expect(wasRepetitionStopped('a normal finished response.')).toBe(false);
    expect(wasRepetitionStopped(null)).toBe(false);
  });

  test('the shell detects a degenerate turn (marker OR a direct loop scan)', () => {
    expect(SHELL).toMatch(/const degenerateTurn =\s*\n\s*wasRepetitionStopped\(this\.finalResponseText\) \|\|\s*\n\s*detectRepetitionLoop\(this\.finalResponseText\)\.looping;/);
  });

  test('a degenerate turn terminates auto-continue (no re-prompt) like a refusal', () => {
    // The branch that clears originalPromptForAutoContinue must include degenerateTurn.
    expect(SHELL).toMatch(/else if \(refusedTurn \|\| degenerateTurn\) \{/);
    // …and it must NOT fall through to the auto-continue / re-prompt branch.
    const branchIdx = SHELL.indexOf('else if (refusedTurn || degenerateTurn)');
    const contIdx = SHELL.indexOf('else if (!this.shouldExit && !this.userInterruptedRun)');
    expect(branchIdx).toBeGreaterThan(-1);
    expect(branchIdx).toBeLessThan(contIdx); // the terminate branch precedes the continue branch
  });
});
