/**
 * Real coverage for the intra-episode over-edit guard (F1) in src/core/agent.ts.
 *
 * Why this exists: the behavioral-loop guard EXEMPTS edit/write tools, and the
 * turn governor only fingerprints at turn boundaries — so a re-read->rewrite
 * cycle can rewrite ONE file 5-6 times within a single send() with nothing
 * counting it (reproduced against the real binary; see the run-experience memo).
 * The fix adds a per-episode same-path write counter: a one-line nudge on the
 * EDIT_NUDGE_THRESHOLD-th rewrite, and a hard episode stop at MAX_SAME_FILE_REWRITES.
 *
 * recordEditWrite/checkBehavioralLoop are private, so — exactly like
 * behavioralLoop.test.ts — we drive the REAL methods directly on a constructed
 * runtime. No mock stands in for the detector; the detector IS the SUT.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentRuntime } from '../../src/core/agent.js';
import { ToolRuntime } from '../../src/core/toolRuntime.js';
import { ContextManager } from '../../src/core/contextManager.js';
import type {
  LLMProvider,
  ConversationMessage,
  ProviderResponse,
  ProviderToolDefinition,
  StreamChunk,
  ToolCallRequest,
} from '../../src/core/types.js';

const agentSrc = readFileSync(resolve(__dirname, '..', '..', 'src', 'core', 'agent.ts'), 'utf8');

class IdleProvider implements LLMProvider {
  readonly id = 'scripted' as const;
  readonly model = 'mock-model';
  async generate(_m: ConversationMessage[], _t: ProviderToolDefinition[]): Promise<ProviderResponse> {
    return { type: 'message', content: 'unused', stopReason: 'stop' };
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *generateStream(_m: ConversationMessage[], _t: ProviderToolDefinition[]): AsyncIterable<StreamChunk> {
    yield { type: 'done' };
  }
}

function makeRuntime(): AgentRuntime {
  return new AgentRuntime({
    provider: new IdleProvider(),
    toolRuntime: new ToolRuntime([], { enableCache: false }),
    systemPrompt: 'test',
    contextManager: new ContextManager({ maxTokens: 100_000, targetTokens: 80_000 }),
    providerId: 'scripted',
    modelId: 'mock-model',
    workingDirectory: process.cwd(),
  });
}

// A distinct new_string each time — the over-edit pattern is near-whole-file
// rewrites that DIFFER, which is exactly why a content/identity check misses them.
const editCall = (file: string, content: string): ToolCallRequest =>
  ({ id: 'x', name: 'edit', arguments: { file_path: file, new_string: content } } as ToolCallRequest);

type Internals = {
  recordEditWrite(call: ToolCallRequest): string | null;
  checkBehavioralLoop(calls: ToolCallRequest[]): string | null;
  resetBehavioralLoopTracking(): void;
};
const internals = (r: AgentRuntime) => r as unknown as Internals;

describe('recordEditWrite (soft nudge)', () => {
  it('stays quiet for the first 3 rewrites, nudges ONCE on the 4th, then stays quiet', () => {
    const r = internals(makeRuntime());
    expect(r.recordEditWrite(editCall('a.ts', 'v1'))).toBeNull(); // 1
    expect(r.recordEditWrite(editCall('a.ts', 'v2'))).toBeNull(); // 2
    expect(r.recordEditWrite(editCall('a.ts', 'v3'))).toBeNull(); // 3
    const nudge = r.recordEditWrite(editCall('a.ts', 'v4')); // 4 → nudge
    expect(nudge).toMatch(/rewritten 4 times this turn/i);
    expect(nudge).toMatch(/a\.ts/);
    expect(r.recordEditWrite(editCall('a.ts', 'v5'))).toBeNull(); // 5 → only once per path
  });

  it('does NOT nudge when DIFFERENT files are each edited once (legit multi-file work)', () => {
    const r = internals(makeRuntime());
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) {
      expect(r.recordEditWrite(editCall(f, 'content'))).toBeNull();
    }
  });

  it('counts edit and write to the SAME path together (normalized path key)', () => {
    const r = internals(makeRuntime());
    const writeCall = (file: string, c: string): ToolCallRequest =>
      ({ id: 'y', name: 'write', arguments: { path: file, content: c } } as ToolCallRequest);
    expect(r.recordEditWrite(editCall('./x.ts', 'v1'))).toBeNull();
    expect(r.recordEditWrite(writeCall('x.ts', 'v2'))).toBeNull();
    expect(r.recordEditWrite(editCall('x.ts', 'v3'))).toBeNull();
    expect(r.recordEditWrite(writeCall('./x.ts', 'v4'))).toMatch(/rewritten 4 times/i); // collide → 4th
  });

  it('returns null for an edit call missing a path (no false nudge)', () => {
    const r = internals(makeRuntime());
    const noPath = { id: 'z', name: 'edit', arguments: {} } as ToolCallRequest;
    for (let i = 0; i < 10; i++) expect(r.recordEditWrite(noPath)).toBeNull();
  });
});

describe('checkBehavioralLoop (hard ceiling)', () => {
  it('stops the episode when one file is rewritten past MAX_SAME_FILE_REWRITES', () => {
    const r = internals(makeRuntime());
    // 8 genuine writes recorded; ceiling fires on the 9th incoming edit to that path.
    for (let i = 0; i < 8; i++) r.recordEditWrite(editCall('hot.ts', `v${i}`));
    const msg = r.checkBehavioralLoop([editCall('hot.ts', 'v9')]);
    expect(msg).toMatch(/Repeated whole-file rewrites detected/);
    expect(msg).toMatch(/hot\.ts/);
  });

  it('does NOT trip before the ceiling, and not for a different file', () => {
    const r = internals(makeRuntime());
    for (let i = 0; i < 7; i++) r.recordEditWrite(editCall('hot.ts', `v${i}`));
    expect(r.checkBehavioralLoop([editCall('hot.ts', 'v8')])).toBeNull(); // 7 < 8
    expect(r.checkBehavioralLoop([editCall('other.ts', 'x')])).toBeNull(); // unrelated file
  });

  it('resets the same-path counters per episode', () => {
    const r = internals(makeRuntime());
    for (let i = 0; i < 4; i++) r.recordEditWrite(editCall('a.ts', `v${i}`));
    r.resetBehavioralLoopTracking();
    // After reset the counter is back to zero → first write nudges nothing again.
    expect(r.recordEditWrite(editCall('a.ts', 'fresh'))).toBeNull();
  });
});

describe('source guards', () => {
  it('keeps the per-file write counter wired into the loop guard and the reset', () => {
    expect(agentSrc).toMatch(/private editPathCounts = new Map<string, number>\(\)/);
    expect(agentSrc).toMatch(/EDIT_NUDGE_THRESHOLD = 4/);
    expect(agentSrc).toMatch(/MAX_SAME_FILE_REWRITES = 8/);
    // The ceiling is enforced inside checkBehavioralLoop (covers both loop paths).
    expect(agentSrc).toMatch(/Repeated whole-file rewrites detected/);
    // Counters are cleared per episode.
    expect(agentSrc).toMatch(/resetBehavioralLoopTracking\(\)[\s\S]*editPathCounts\.clear\(\)/);
  });
});
