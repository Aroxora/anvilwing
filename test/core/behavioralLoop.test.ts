/**
 * Real coverage for the behavioral-loop guard (checkBehavioralLoop +
 * extractCmdHash) in src/core/agent.ts.
 *
 * Why this exists: the "behavioral loop" case in agentRuntime-edge-cases.test.ts
 * is a FALSE POSITIVE. It drives `echo` — a loop-eligible but *cacheable* tool —
 * so every repeat after the first is served from the AgentRuntime result cache
 * and EXCLUDED from behavioral-loop counting (see the `getCachedToolResult(call)
 * === null` filter). That test actually terminates via the unrelated
 * exact-signature path (repeatedToolCallCount → MAX_REPEATED_TOOL_CALLS) and
 * only asserts `typeof result === 'string'`. The similar-args path
 * (extractCmdHash → BEHAVIORAL_LOOP_THRESHOLD) had zero coverage, so a
 * regression in extractCmdHash or the cache-exclusion would ship undetected.
 *
 * checkBehavioralLoop/extractCmdHash are private, and the public send() path
 * masks them behind the cache + exact-signature interplay (the very thing that
 * makes the integration test a false positive). So we drive the REAL methods
 * directly on a constructed runtime: no mock LLM stands in for the path — the
 * actual detector is the system under test.
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

const call = (name: string, args: Record<string, unknown> = {}): ToolCallRequest =>
  ({ id: 'x', name, arguments: args } as ToolCallRequest);

// Private-method access — the detector is the SUT and is called directly.
type Internals = {
  extractCmdHash(name: string, args: Record<string, unknown>): string;
  checkBehavioralLoop(calls: ToolCallRequest[]): string | null;
  cacheToolResult(c: ToolCallRequest, result: string): void;
};
const internals = (r: AgentRuntime) => r as unknown as Internals;

describe('extractCmdHash', () => {
  const h = (name: string, args: Record<string, unknown>) => internals(makeRuntime()).extractCmdHash(name, args);

  it('normalises long digit runs in bash commands so timestamped re-runs hash equal', () => {
    expect(h('Bash', { command: 'cat log-1700000000000.txt' })).toBe(h('Bash', { command: 'cat log-1699999999999.txt' }));
    expect(h('Bash', { command: 'echo 12345678901' })).toBe('echo N');
    // short digit runs (<10) are preserved
    expect(h('Bash', { command: 'echo 123' })).toBe('echo 123');
  });

  it('keys file reads by path and searches by pattern', () => {
    expect(h('Read', { file_path: 'a.ts' })).toBe('path:"a.ts"');
    expect(h('read_file', { path: 'a.ts' })).toBe('path:"a.ts"');
    expect(h('Grep', { pattern: 'foo' })).toBe('search:foo');
    expect(h('grep', { query: 'foo' })).toBe('search:foo');
  });

  it('produces DISTINCT hashes for distinct arguments (the case the audit flagged)', () => {
    expect(h('Grep', { pattern: 'foo' })).not.toBe(h('Grep', { pattern: 'bar' }));
    expect(h('Read', { file_path: 'a.ts' })).not.toBe(h('Read', { file_path: 'b.ts' }));
    expect(h('git_status', { rev: 'main' })).not.toBe(h('git_status', { rev: 'dev' }));
  });

  it('falls back to first-arg / no-args for unknown tools', () => {
    expect(h('git_status', {})).toBe('no-args');
    expect(h('weird', { first: 'v1' })).toBe('v1');
  });
});

describe('checkBehavioralLoop', () => {
  it('fires on the 3rd non-cached call to a loop-eligible tool with similar args', () => {
    const r = internals(makeRuntime());
    expect(r.checkBehavioralLoop([call('git_status')])).toBeNull(); // 1
    expect(r.checkBehavioralLoop([call('git_status')])).toBeNull(); // 2
    const msg = r.checkBehavioralLoop([call('git_status')]); // 3 → trip
    expect(msg).toMatch(/Behavioral loop detected/);
    expect(msg).toMatch(/"git_status" called 3 times with similar arguments/);
  });

  it('resets history after a trip so it does not immediately re-fire', () => {
    const r = internals(makeRuntime());
    r.checkBehavioralLoop([call('git_status')]);
    r.checkBehavioralLoop([call('git_status')]);
    expect(r.checkBehavioralLoop([call('git_status')])).toMatch(/Behavioral loop detected/);
    expect(r.checkBehavioralLoop([call('git_status')])).toBeNull(); // history was reset
  });

  it('does NOT fire when the same tool is called with DIFFERENT args', () => {
    const r = internals(makeRuntime());
    for (const rev of ['a', 'b', 'c', 'd']) {
      expect(r.checkBehavioralLoop([call('git_status', { rev })])).toBeNull();
    }
  });

  it('exempts direct-execution / noisy tools (bash, edit, grep, read) from behavioral looping', () => {
    for (const name of ['bash', 'edit', 'grep', 'read']) {
      const r = internals(makeRuntime());
      for (let i = 0; i < 6; i++) {
        expect(r.checkBehavioralLoop([call(name, { x: 'same' })])).toBeNull();
      }
    }
  });

  it('excludes cache-HIT calls from loop counting (a cached result is not "stuck")', () => {
    const r = internals(makeRuntime());
    const seed = call('probe', { x: 1 }); // cacheable (not NON_CACHEABLE) + loop-eligible
    r.cacheToolResult(seed, 'cached-result');
    // every repeat is a cache hit → never counted → never trips, even past threshold
    for (let i = 0; i < 6; i++) {
      expect(r.checkBehavioralLoop([call('probe', { x: 1 })])).toBeNull();
    }
  });
});

describe('source guards', () => {
  it('keeps the similar-args trip message and the cache-exclusion filter', () => {
    expect(agentSrc).toMatch(/Behavioral loop detected[\s\S]*with similar arguments/);
    expect(agentSrc).toMatch(/getCachedToolResult\(call\)\s*===\s*null/);
  });
});
