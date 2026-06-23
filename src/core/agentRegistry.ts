/**
 * Agent registry and type system. Powers the Claude-Code-style `Agent`
 * tool: subagent_type filters tools, run_in_background returns a handle,
 * isolation: "worktree" pins the agent to a fresh git worktree.
 *
 * One `AgentRegistry` per session; LeanAgent injects it into the unified
 * coding capability.
 */
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LLMProvider } from './types.js';

// ============================================================================
// AGENT TYPES — tool subsets per type
// ============================================================================

export type AgentType = 'general' | 'explore' | 'plan';

/**
 * Tool subsets per agent type. The unified capability filters its built
 * tool suite against this set when an agent is spawned.
 *
 *   - general — full toolset (excluding the spawning tools themselves to
 *               avoid runaway recursion)
 *   - explore — read-only investigation: grep, glob, read_file, list,
 *               file_exists, web_fetch, git (status/diff/log only)
 *   - plan    — same as explore (no writes); used for "design this" tasks
 *               where the parent wants a plan back, not edits
 */
export const TOOL_SUBSETS: Record<AgentType, ReadonlySet<string> | null> = {
  general: null, // null = full toolset minus spawn tools (registry strips below)
  explore: new Set([
    'read_file',
    'list_files',
    'file_exists',
    'grep',
    'glob',
    'web_fetch',
    'git', // git is read-only by convention from sub-agents
  ]),
  plan: new Set([
    'read_file',
    'list_files',
    'file_exists',
    'grep',
    'glob',
    'web_fetch',
    'git',
  ]),
};

/** Tools sub-agents NEVER get — would risk infinite recursion. */
export const FORBIDDEN_FOR_SUBAGENTS: ReadonlySet<string> = new Set([
  'parallel_agents',
  'Agent',
  'agent_list',
  'agent_status',
  'agent_output',
  'agent_stop',
  'agent_send_message',
]);

export function filterToolsForType(
  toolNames: readonly string[],
  type: AgentType
): string[] {
  const subset = TOOL_SUBSETS[type];
  if (subset) {
    return toolNames.filter((n) => subset.has(n));
  }
  // general: everything except spawn tools
  return toolNames.filter((n) => !FORBIDDEN_FOR_SUBAGENTS.has(n));
}

// ============================================================================
// AGENT HANDLES
// ============================================================================

export type AgentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped';

export interface AgentSpawnRequest {
  /** Sub-agent type — controls available tools. */
  subagent_type?: AgentType;
  /** 3-5 word label shown in lists. */
  description: string;
  /** Full instructions sent to the sub-agent as its user prompt. */
  prompt: string;
  /** Per-agent model override; undefined inherits parent. */
  model?: string;
  /** "worktree" creates a fresh `git worktree` for the agent. */
  isolation?: 'worktree' | 'none';
  /** When true, returns immediately with an id; caller polls for output. */
  run_in_background?: boolean;
}

export interface AgentHandle {
  id: string;
  type: AgentType;
  description: string;
  status: AgentStatus;
  startedAt: number;
  endedAt?: number;
  /** Working directory the agent was spawned into. */
  workingDir: string;
  /** Worktree path + branch when isolation: "worktree" was used and
   *  changes were left behind for the user. */
  worktreePath?: string;
  worktreeBranch?: string;
  /** Most recent partial output (foreground completes synchronously and
   *  fills `output` directly). */
  output?: string;
  error?: string;
  /** Conversation continuation point — see sendMessage(). */
  continuation?: AgentContinuation;
}

/**
 * Captures whatever's needed to resume an agent with a follow-up message.
 * For now: the underlying LeanAgent reference (kept alive in the registry
 * even after `completed`) plus the original spawn options so we can
 * reconstruct the right tool subset for the follow-up.
 */
export interface AgentContinuation {
  // Held opaquely so this module doesn't import LeanAgent directly.
  agentObject: unknown;
  spawnOptions: AgentSpawnRequest;
}

// ============================================================================
// REGISTRY
// ============================================================================

export interface AgentSpawnerDeps {
  provider: LLMProvider;
  workingDir: string;
  providerId?: string;
  modelId?: string;
}

/**
 * Function that actually creates and runs a sub-agent. Injected by the
 * capability layer so this module doesn't depend on LeanAgent (avoids a
 * circular dep with unifiedCodingCapability).
 *
 * The function should:
 *   - Honor `req.subagent_type` (filter tools)
 *   - Honor `req.model` (override modelId)
 *   - Run the prompt to completion
 *   - Mutate the handle with output / error / status / endedAt
 */
export type AgentSpawnerFn = (
  req: AgentSpawnRequest,
  handle: AgentHandle,
  deps: AgentSpawnerDeps
) => Promise<void>;

export class AgentRegistry {
  private agents = new Map<string, AgentHandle>();
  private runs = new Map<string, Promise<void>>();
  private cancellers = new Map<string, () => void>();

  constructor(
    private readonly deps: AgentSpawnerDeps,
    private readonly spawner: AgentSpawnerFn
  ) {}

  /**
   * Spawn an agent. Returns the handle immediately — callers can choose
   * to await `runs.get(id)` for completion (foreground) or poll
   * `getStatus(id)` (background).
   */
  spawn(req: AgentSpawnRequest): AgentHandle {
    const id = randomUUID().slice(0, 8);
    const type: AgentType = req.subagent_type ?? 'general';
    const workingDir = this.resolveWorkingDir(req, id);
    const handle: AgentHandle = {
      id,
      type,
      description: req.description.slice(0, 80),
      status: 'queued',
      startedAt: Date.now(),
      workingDir,
    };
    this.agents.set(id, handle);

    const finalReq: AgentSpawnRequest = { ...req };
    const runDeps: AgentSpawnerDeps = { ...this.deps, workingDir };
    const promise = (async () => {
      handle.status = 'running';
      try {
        await this.spawner(finalReq, handle, runDeps);
        if (handle.status === 'running') handle.status = 'completed';
      } catch (err) {
        handle.status = 'failed';
        handle.error = (err as Error).message;
      } finally {
        handle.endedAt = Date.now();
        this.cleanupWorktreeIfUnchanged(handle);
      }
    })();
    this.runs.set(id, promise);
    return handle;
  }

  /** Block until the agent finishes. */
  async wait(id: string): Promise<AgentHandle | undefined> {
    const run = this.runs.get(id);
    if (run) await run;
    return this.agents.get(id);
  }

  get(id: string): AgentHandle | undefined {
    return this.agents.get(id);
  }

  list(): AgentHandle[] {
    return Array.from(this.agents.values()).sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Best-effort stop. We can't actually halt an in-flight LLM call, but
   *  we can mark the handle and signal via canceller if the spawner
   *  registered one. */
  stop(id: string): boolean {
    const handle = this.agents.get(id);
    if (!handle) return false;
    if (handle.status !== 'running' && handle.status !== 'queued') return false;
    handle.status = 'stopped';
    handle.endedAt = Date.now();
    this.cancellers.get(id)?.();
    return true;
  }

  registerCanceller(id: string, fn: () => void): void {
    this.cancellers.set(id, fn);
  }

  /** Continue an existing agent with a follow-up message. */
  async sendMessage(id: string, message: string): Promise<string> {
    const handle = this.agents.get(id);
    if (!handle) throw new Error(`No agent with id ${id}`);
    const cont = handle.continuation;
    if (!cont) throw new Error(`Agent ${id} has no continuation handle`);
    // Type-erased agent object — caller (capability) re-typed at injection.
    const obj = cont.agentObject as { chat: (m: string, s: boolean) => Promise<{ content: string }> };
    const r = await obj.chat(message, false);
    handle.output = (handle.output ?? '') + '\n' + r.content;
    return r.content;
  }

  // ==========================================================================
  // Worktree isolation
  // ==========================================================================

  private resolveWorkingDir(req: AgentSpawnRequest, id: string): string {
    if (req.isolation !== 'worktree') return this.deps.workingDir;
    try {
      const wt = this.createWorktree(id);
      return wt;
    } catch (err) {
      // Fallback gracefully — log and use parent dir. The agent itself
      // will surface the lack of isolation in its output.
      // eslint-disable-next-line no-console
      console.warn(`[AgentRegistry] worktree creation failed, falling back: ${(err as Error).message}`);
      return this.deps.workingDir;
    }
  }

  private createWorktree(id: string): string {
    const parent = this.deps.workingDir;
    // Verify we're in a git repo first.
    git(['rev-parse', '--git-dir'], parent);
    const branch = `anvilwing/agent-${id}`;
    const dir = path.join(os.tmpdir(), `anvilwing-agent-${id}`);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    git(['worktree', 'add', '-b', branch, dir, 'HEAD'], parent);
    const handle = this.agents.get(id);
    if (handle) {
      handle.worktreePath = dir;
      handle.worktreeBranch = branch;
    }
    return dir;
  }

  /** If the agent left no changes behind, prune the worktree to keep
   *  /tmp tidy. Otherwise leave it so the user can inspect / merge. */
  private cleanupWorktreeIfUnchanged(handle: AgentHandle): void {
    if (!handle.worktreePath) return;
    try {
      const status = git(['status', '--porcelain'], handle.worktreePath).trim();
      const log = git(['log', '-1', '--format=%H', 'HEAD'], handle.worktreePath).trim();
      const baseLog = git(['log', '-1', '--format=%H', 'HEAD'], this.deps.workingDir).trim();
      const hasChanges = status.length > 0 || log !== baseLog;
      if (!hasChanges) {
        git(['worktree', 'remove', '--force', handle.worktreePath], this.deps.workingDir);
        if (handle.worktreeBranch) {
          try { git(['branch', '-D', handle.worktreeBranch], this.deps.workingDir); } catch {}
        }
        handle.worktreePath = undefined;
        handle.worktreeBranch = undefined;
      }
    } catch (err) {
      // Non-fatal; worktree cleanup is opportunistic.
      // eslint-disable-next-line no-console
      console.warn(`[AgentRegistry] worktree cleanup skipped: ${(err as Error).message}`);
    }
  }
}

function git(args: string[], cwd: string): string {
  const opts: ExecFileSyncOptions = { cwd, encoding: 'utf-8' };
  try {
    return execFileSync('git', args, opts) as string;
  } catch (err) {
    throw new Error(`git ${args.join(' ')} failed: ${(err as Error).message}`);
  }
}
