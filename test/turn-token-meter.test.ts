/**
 * The spinner's `↑ N tokens` was dead-and-wrong: it only updated at request
 * end, and it showed INPUT tokens (the usage handler fed inputTokens into the
 * StatusLine meta). TurnTokenMeter makes it live (chars/4 estimate while
 * streaming) and accurate (snaps to the provider-exact completion count on
 * each usage event), accumulating across a turn's tool-loop requests.
 *
 * Behavioural tests on the real class + source tripwires on the wiring in
 * interactiveShell.ts / InkPromptController.ts so a refactor that drops the
 * meter (or re-conflates output tokens with context %) fails here.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TurnTokenMeter } from '../src/core/turnTokenMeter';

const SHELL_SRC = readFileSync(resolve(__dirname, '..', 'src', 'headless', 'interactiveShell.ts'), 'utf8');
const CONTROLLER_SRC = readFileSync(resolve(__dirname, '..', 'src', 'ui', 'ink', 'InkPromptController.ts'), 'utf8');

describe('TurnTokenMeter', () => {
  test.each([
    [0, 0],
    [1, 1], // ceil(1/4)
    [4, 1],
    [5, 2],
    [400, 100],
    [401, 101],
  ])('%i streamed chars estimate to %i tokens', (chars, expected) => {
    const m = new TurnTokenMeter();
    m.addStreamedChars(chars);
    expect(m.current()).toBe(expected);
  });

  test('accumulates across multiple deltas', () => {
    const m = new TurnTokenMeter();
    m.addStreamedChars(3);
    m.addStreamedChars(3);
    m.addStreamedChars(2); // 8 chars total → 2 tokens
    expect(m.current()).toBe(2);
  });

  test('usage snaps the estimate to the provider-exact count (can correct down)', () => {
    const m = new TurnTokenMeter();
    m.addStreamedChars(1000); // estimate 250
    expect(m.current()).toBe(250);
    m.recordExactOutput(180);
    expect(m.current()).toBe(180); // exact replaces estimate — by design
  });

  test('a turn spanning multiple requests (tool loop) keeps accumulating', () => {
    const m = new TurnTokenMeter();
    m.addStreamedChars(40); // request 1 streaming → 10
    expect(m.current()).toBe(10);
    m.recordExactOutput(12); // request 1 exact
    expect(m.current()).toBe(12);
    m.addStreamedChars(80); // request 2 streaming → 12 + 20
    expect(m.current()).toBe(32);
    m.recordExactOutput(25); // request 2 exact
    expect(m.current()).toBe(37);
  });

  test('reset starts the next user turn from zero', () => {
    const m = new TurnTokenMeter();
    m.recordExactOutput(500);
    m.addStreamedChars(100);
    m.reset();
    expect(m.current()).toBe(0);
  });

  test.each([
    ['NaN chars', NaN],
    ['negative chars', -10],
    ['Infinity chars', Infinity],
  ])('ignores %s', (_label, value) => {
    const m = new TurnTokenMeter();
    m.addStreamedChars(value);
    expect(m.current()).toBe(0);
  });

  // A usage event whose completion_tokens is missing/0/NaN (the shell passes
  // `event.outputTokens ?? 0`; lax OpenAI-compatible proxies omit the field)
  // must NOT discard the live estimate — that silently undercounts with no
  // later correction.
  test.each([
    ['zero', 0],
    ['NaN', NaN],
    ['negative', -5],
    ['Infinity', Infinity],
  ])('recordExactOutput(%s) does not lower the live estimate', (_label, value) => {
    const m = new TurnTokenMeter();
    m.addStreamedChars(400); // estimate 100
    m.recordExactOutput(value as number);
    expect(m.current()).toBe(100);
    // A real exact count afterwards still snaps as designed.
    m.recordExactOutput(80);
    expect(m.current()).toBe(80);
  });
});

describe('interactiveShell wires the meter (source tripwires)', () => {
  test('resets on a fresh user turn and zeroes the spinner meta', () => {
    expect(SHELL_SRC).toMatch(/this\.turnTokenMeter\.reset\(\)/);
    expect(SHELL_SRC).toMatch(/setMetaStatus\(\{ outputTokens: 0 \}\)/);
  });

  test('synthetic deltas (replayed narration, retry notices) bypass the meter', () => {
    expect(SHELL_SRC).toMatch(/if \(!event\.synthetic\) \{\s*\n\s*this\.turnTokenMeter\.addStreamedChars/);
  });

  test('streaming deltas (content AND reasoning) feed the meter and push a live update', () => {
    const feeds = SHELL_SRC.match(/turnTokenMeter\.addStreamedChars\(\(event\.content \?\? ''\)\.length\)/g) ?? [];
    expect(feeds.length).toBeGreaterThanOrEqual(2);
    expect(SHELL_SRC).toMatch(/setMetaStatus\(\{ outputTokens: this\.turnTokenMeter\.current\(\) \}\)/);
  });

  test('usage events snap exact output and keep cumulative metering + context %', () => {
    expect(SHELL_SRC).toMatch(/turnTokenMeter\.recordExactOutput\(event\.outputTokens \?\? 0\)/);
    expect(SHELL_SRC).toMatch(/recordAnvilwingUsage\(event\.inputTokens, event\.outputTokens\)/);
    expect(SHELL_SRC).toMatch(/outputTokens:\s*this\.turnTokenMeter\.current\(\),\s*contextTokens,\s*tokenLimit:\s*windowTokens/);
  });
});

describe('InkPromptController separates output tokens from context % (source tripwires)', () => {
  test('setMetaStatus stores outputTokens and derives contextPercent from contextTokens/tokenLimit', () => {
    expect(CONTROLLER_SRC).toMatch(/this\.metaInfo\.outputTokens = meta\.outputTokens/);
    expect(CONTROLLER_SRC).toMatch(/meta\.contextTokens \/ meta\.tokenLimit/);
    // The old conflation — context tokens driving the ↑ meta — must stay gone.
    expect(CONTROLLER_SRC).not.toMatch(/metaInfo\.tokensUsed/);
  });

  test('contextPercent inputs are finite-guarded (NaN passes a != null check)', () => {
    expect(CONTROLLER_SRC).toMatch(/Number\.isFinite\(meta\.contextTokens\)/);
    expect(CONTROLLER_SRC).toMatch(/Number\.isFinite\(meta\.tokenLimit\)/);
    expect(CONTROLLER_SRC).toMatch(/meta\.tokenLimit > 0/);
  });

  test('buildTree feeds the StatusLine ↑ meta from outputTokens', () => {
    expect(CONTROLLER_SRC).toMatch(/tokensUsed: this\.metaInfo\.outputTokens \?\? null/);
  });
});

describe('AgentController emits provider usage exactly once per request (source tripwires)', () => {
  const CONTROLLER = readFileSync(resolve(__dirname, '..', 'src', 'runtime', 'agentController.ts'), 'utf8');
  test('handleAssistantMessage skips the usage re-emit for streamed runs', () => {
    expect(CONTROLLER).toMatch(/if \(!metadata\.wasStreamed\) \{\s*\n\s*this\.emitUsage\(metadata\.usage \?\? null\);/);
  });
  test('already-streamed narration is dropped (not re-emitted); retry notices stay synthetic', () => {
    // wasStreamed narration already went out live — re-emitting double-renders
    // it in the shell. It's now dropped at the source.
    expect(CONTROLLER).toMatch(/if \(metadata\.wasStreamed\) \{\s*\n\s*return;/);
    // Retry notices are genuinely new text → still emitted, flagged synthetic
    // so the meter doesn't count them as model output.
    expect(CONTROLLER).toMatch(/emitDelta\(`\[Retrying \$\{attempt\}\/\$\{maxAttempts\}: \$\{error\.message\}\]`, false, true\)/);
  });
});
