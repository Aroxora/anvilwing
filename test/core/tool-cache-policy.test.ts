/**
 * Real coverage for the AgentRuntime tool-result cache policy
 * (src/core/agent.ts). The deny-list had drifted from the tool registry, so
 * stateful tools (BashOutput, MultiEdit, search_replace, HITL_*, memory_*,
 * agent_output, TodoWrite, KillShell, git, web_fetch) were silently cached for
 * the whole session — freezing polling tools on their first snapshot, skipping
 * a mutation's second execution, and reusing stale human decisions. Failures
 * were cached too, and the cache survived a history swap.
 *
 * Drives the REAL private cache methods on a constructed runtime (same harness
 * shape as behavioralLoop.test.ts) — no mock stands in for the policy.
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
  async generate(): Promise<ProviderResponse> {
    return { type: 'message', content: 'unused', stopReason: 'stop' };
  }
  async *generateStream(): AsyncIterable<StreamChunk> {
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

type Internals = {
  isCacheableTool(c: ToolCallRequest): boolean;
  cacheToolResult(c: ToolCallRequest, result: string): void;
  getCachedToolResult(c: ToolCallRequest): string | null;
  checkBehavioralLoop(calls: ToolCallRequest[]): string | null;
};
const internals = (r: AgentRuntime) => r as unknown as Internals & AgentRuntime;

const STATEFUL = [
  'BashOutput', 'MultiEdit', 'search_replace', 'KillShell', 'TodoWrite', 'TodoRead',
  'HITL_Approval', 'HITL_YesNo', 'HITL_Select', 'memory_save', 'memory_delete',
  'agent_output', 'agent_status', 'Agent', 'parallel_agents', 'Skill', 'git',
  'WebFetch', 'web_fetch', 'NotebookEdit', 'file_exists',
];

describe('tool-cache policy — stateful tools are never cached', () => {
  test.each(STATEFUL)('%s is not cacheable', (name) => {
    expect(internals(makeRuntime()).isCacheableTool(call(name))).toBe(false);
  });

  test('a polling tool is never served a stale cached snapshot', () => {
    const r = internals(makeRuntime());
    r.cacheToolResult(call('BashOutput', { shell_id: '1' }), 'snapshot-1');
    // Non-cacheable → cache stores nothing → next poll re-executes (returns null).
    expect(r.getCachedToolResult(call('BashOutput', { shell_id: '1' }))).toBeNull();
  });

  test('a mutating tool is not short-circuited by a cached result', () => {
    const r = internals(makeRuntime());
    r.cacheToolResult(call('search_replace', { path: 'a.ts', find: 'x', replace: 'y' }), 'edited');
    expect(r.getCachedToolResult(call('search_replace', { path: 'a.ts', find: 'x', replace: 'y' }))).toBeNull();
  });

  test('failure outputs are never cached (even for a cacheable tool)', () => {
    const r = internals(makeRuntime());
    r.cacheToolResult(call('probe', { x: 1 }), 'Error: file not found');
    expect(r.getCachedToolResult(call('probe', { x: 1 }))).toBeNull();
  });

  test('a cacheable tool still caches a successful result (cache not disabled)', () => {
    const r = internals(makeRuntime());
    r.cacheToolResult(call('probe', { x: 1 }), 'ok-result');
    expect(r.getCachedToolResult(call('probe', { x: 1 }))).toBe('ok-result');
  });

  test('clearHistory() drops cached results', () => {
    const r = internals(makeRuntime());
    r.cacheToolResult(call('probe', { x: 1 }), 'ok-result');
    expect(r.getCachedToolResult(call('probe', { x: 1 }))).toBe('ok-result');
    (r as AgentRuntime).clearHistory();
    expect(r.getCachedToolResult(call('probe', { x: 1 }))).toBeNull();
  });

  test('loadHistory() drops cached results', () => {
    const r = internals(makeRuntime());
    r.cacheToolResult(call('probe', { x: 1 }), 'ok-result');
    (r as AgentRuntime).loadHistory([]);
    expect(r.getCachedToolResult(call('probe', { x: 1 }))).toBeNull();
  });

  test('repeated polls of a non-cacheable poller do not false-trip the loop guard', () => {
    const r = internals(makeRuntime());
    for (let i = 0; i < 6; i++) {
      expect(r.checkBehavioralLoop([call('BashOutput', { shell_id: '1' })])).toBeNull();
    }
  });

  test('source: deny-list covers the drifted stateful names and guards added', () => {
    for (const n of ['multiedit', 'search_replace', 'bashoutput', 'hitl_approval', 'agent_output', 'memory_save']) {
      expect(agentSrc).toMatch(new RegExp(`'${n}'`));
    }
    expect(agentSrc).toMatch(/if \(this\.isToolOutputFailure\(result\)\)/);
    expect(agentSrc).toMatch(/clearHistory\(\)[\s\S]*?this\.toolResultCache\.clear\(\)/);
  });
});
