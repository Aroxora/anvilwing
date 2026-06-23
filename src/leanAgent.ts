/**
 * LEAN CODING AGENT
 *
 * A streamlined, unified coding assistant that consolidates all
 * capabilities into a single, efficient agent architecture.
 *
 * Features:
 * - Unified tool suite (filesystem, edit, search, bash, git, web)
 * - Context management with auto-pruning
 * - Loop detection and recovery
 * - Multi-provider support
 * - Streaming responses
 */

import { AgentRuntime, type AgentCallbacks } from './core/agent.js';
import { ContextManager } from './core/contextManager.js';
import { calculateContextThresholds } from './core/contextWindow.js';
import { ToolRuntime } from './core/toolRuntime.js';
import { createUnifiedCodingCapability, type UnifiedCodingOptions } from './capabilities/unifiedCodingCapability.js';
import type { LLMProvider } from './core/types.js';

// ============================================================================
// TYPES
// ============================================================================

export interface LeanAgentConfig {
  /** LLM provider instance */
  provider: LLMProvider;
  /** Working directory for file operations */
  workingDir?: string;
  /** System prompt for the agent */
  systemPrompt?: string;
  /** Capability options */
  capabilities?: UnifiedCodingOptions;
  /** Context window size for pruning */
  contextWindowSize?: number;
  /** Provider ID for tracking */
  providerId?: string;
  /** Model ID for tracking */
  modelId?: string;
  /** Event callbacks */
  callbacks?: AgentCallbacks;
}

export interface LeanAgentResponse {
  content: string;
  toolsUsed: string[];
  tokensUsed?: number;
  elapsedMs?: number;
}

// ============================================================================
// LEAN AGENT
// ============================================================================

export class LeanAgent {
  private runtime: AgentRuntime;
  private toolRuntime: ToolRuntime;
  private config: LeanAgentConfig;
  private toolsUsed: string[] = [];
  private initialized = false;

  constructor(config: LeanAgentConfig) {
    this.config = config;

    // Create tool runtime
    this.toolRuntime = new ToolRuntime();

    // Create context manager — sized from the MODEL (same derivation as the
    // main agent's createDefaultContextManager), not a hardcoded window. The
    // old hardcoded 1M default ignored modelId entirely: a smaller model would
    // never prune before hard API overflow, and the thresholds disagreed with
    // the main agent's (no 5% safety buffer, 85% vs 60% target). An explicit
    // contextWindowSize still wins, with the same 95%/60% safety shape.
    const explicit = config.contextWindowSize;
    const derived = calculateContextThresholds(config.modelId);
    const contextManager = new ContextManager({
      maxTokens: explicit ? Math.floor(explicit * 0.95) : derived.maxTokens,
      targetTokens: explicit ? Math.floor(explicit * 0.60) : derived.targetTokens,
      maxToolOutputLength: 50_000, // match the main session (v1.5.5)
      estimatedCharsPerToken: 3.5,
    });

    // Build system prompt
    const systemPrompt = config.systemPrompt ?? this.getDefaultSystemPrompt();

    // Create agent runtime
    this.runtime = new AgentRuntime({
      provider: config.provider,
      toolRuntime: this.toolRuntime,
      systemPrompt,
      contextManager,
      providerId: config.providerId ?? 'unknown',
      modelId: config.modelId ?? 'unknown',
      workingDirectory: config.workingDir ?? process.cwd(),
      callbacks: {
        ...config.callbacks,
        onToolExecution: (name, isStart) => {
          if (isStart) {
            this.toolsUsed.push(name);
          }
          config.callbacks?.onToolExecution?.(name, isStart);
        },
      },
    });

    // Initialize capability asynchronously
    this.initializeCapability();
  }

  private async initializeCapability(): Promise<void> {
    if (this.initialized) return;

    // Initialize unified coding capability with provider for parallel agents
    const capability = createUnifiedCodingCapability({
      workingDir: this.config.workingDir ?? process.cwd(),
      provider: this.config.provider,
      providerId: this.config.providerId,
      modelId: this.config.modelId,
      ...this.config.capabilities,
    });

    // Build and register tool suite
    const contribution = await capability.create({
      profile: 'default',
      workspaceContext: null,
      workingDir: this.config.workingDir ?? process.cwd(),
      env: process.env,
    });

    if (contribution.toolSuite) {
      this.toolRuntime.registerSuite(contribution.toolSuite);
    }
    if (contribution.toolSuites) {
      for (const suite of contribution.toolSuites) {
        this.toolRuntime.registerSuite(suite);
      }
    }

    this.initialized = true;
  }

  /**
   * Send a message to the agent and get a response
   */
  async chat(message: string, streaming = true): Promise<LeanAgentResponse> {
    // Ensure initialized
    await this.initializeCapability();

    this.toolsUsed = [];
    const startTime = Date.now();

    const content = await this.runtime.send(message, streaming);

    return {
      content,
      toolsUsed: [...this.toolsUsed],
      elapsedMs: Date.now() - startTime,
    };
  }

  /**
   * Request cancellation of current operation
   */
  cancel(): void {
    this.runtime.requestCancellation();
  }

  /**
   * Check if agent is currently processing
   */
  isRunning(): boolean {
    return this.runtime.isRunning();
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.runtime.clearHistory();
    this.toolRuntime.clearToolHistory();
  }

  /**
   * Get conversation history
   */
  getHistory() {
    return this.runtime.getHistory();
  }

  private getDefaultSystemPrompt(): string {
    return `You are a skilled coding assistant with access to file system operations, code editing, search, and command execution tools.

Your capabilities:
- read_file: Read file contents
- write_file: Create or overwrite files
- list_files: List directory contents
- file_exists: Check if files exist
- edit_file: Make precise edits to existing files
- search_replace: Search and replace text in files
- grep: Search for patterns in files
- glob: Find files by pattern
- bash: Execute shell commands
- git: Git operations (status, diff, commit, etc.)
- web_fetch: Fetch content from URLs
- Agent: Spawn a focused sub-agent (subagent_type: explore | plan | general)
- agent_status / agent_output / agent_stop / agent_send_message: Manage background sub-agents
- parallel_agents: Backwards-compatible bulk-spawn (prefer multiple Agent calls in one message)

Guidelines:
1. Always read files before editing to understand context
2. Make minimal, focused changes
3. Test your changes when possible
4. Explain what you're doing and why
5. Handle errors gracefully

Sub-Agent Guidelines:
Use Agent (or multiple Agent calls in one message) when you need to:
- Investigate parts of the codebase you don't need to edit (subagent_type: "explore" — read-only, much cheaper than general)
- Plan an approach before touching code (subagent_type: "plan")
- Run independent tasks in parallel (multiple Agent calls in one tool message)
- Run a long task in the background (run_in_background: "true", then poll via agent_status / agent_output)
- Make speculative edits that shouldn't collide with yours (isolation: "worktree" creates a fresh git worktree)

Do NOT spawn sub-agents when:
- The task is small and you can do it yourself
- Tasks have ordered dependencies (chain them yourself)
- You'd be calling the same agent type in series (just do the work)

Working directory: ${this.config.workingDir ?? process.cwd()}`;
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

export function createLeanAgent(config: LeanAgentConfig): LeanAgent {
  return new LeanAgent(config);
}

export default LeanAgent;
