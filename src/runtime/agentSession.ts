import { resolveProfileConfig, type ProfileName, type ResolvedProfileConfig } from '../config.js';
import {
  createDefaultToolRuntime,
  type ToolExecutionContext,
  type ToolRuntime,
  type IToolRuntime,
  type ToolRuntimeObserver,
  type ToolSuite,
} from '../core/toolRuntime.js';
import type { ProviderId, ReasoningEffortLevel, TextVerbosityLevel, ConversationMessage, ThinkingBudgetConfig, ThinkingLevel } from '../core/types.js';
import { createProvider, type ProviderConfig } from '../providers/providerFactory.js';
import { AgentRuntime, type AgentCallbacks } from '../core/agent.js';
import { registerDefaultProviderPlugins } from '../plugins/providers/index.js';
import { createDefaultContextManager, ContextManager, type SummarizationCallback } from '../core/contextManager.js';
/**
 * System prompt for context summarization
 * Instructs the LLM to create concise summaries of conversation history
 */
const CONTEXT_CLEANUP_SYSTEM_PROMPT = `Summarize earlier conversation logs to preserve context while staying within token limits.
- Merge any prior summary with the new chunk.
- Capture decisions, tasks, file changes/paths, tool observations, and open questions.
- Separate completed work from follow-ups; keep it under ~180 words with tight bullets.
- Respond in plain Markdown only (no tool or command calls).`;

// Cowork addendum + helper removed in 2026-05 alongside the cowork
// extraction. The coding CLI no longer references productivity-
// assistant tooling at all. The original COWORK_ADDENDUM lives in
// the placeholder repo at ~/GitHub/anvilwing-cowork next to the tools
// it documents, ready to ride along when that surface ships as its
// own product. See CLAUDE.md "Capability separation".

export interface AgentSessionOptions {
  profile: ProfileName;
  workspaceContext: string | null;
  toolSuites?: ToolSuite[];
  toolObserver?: ToolRuntimeObserver;
  /** Used to locate `.anvilwing/settings.json` for hooks. Defaults to process.cwd(). */
  workingDir?: string;
}

export interface ModelSelection {
  provider: ProviderId;
  model: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  reasoningEffort?: ReasoningEffortLevel;
  textVerbosity?: TextVerbosityLevel;
  /** Extended thinking configuration for supported models (Anthropic Claude 4/3.7, Gemini 2.5+) */
  thinking?: ThinkingBudgetConfig;
  /** Thinking level for models that support discrete intensities (Gemini 3 Pro) */
  thinkingLevel?: ThinkingLevel;
}

interface AgentSessionState {
  readonly profile: ProfileName;
  workspaceContext: string | null;
  profileConfig: ResolvedProfileConfig;
  toolContext: ToolExecutionContext; // Mutable - updated during model switching
  toolRuntime: ToolRuntime;
  readonly toolSuites: ToolSuite[];
  readonly toolObserver?: ToolRuntimeObserver;
  readonly contextManager: ContextManager;
}

export class AgentSession {
  private readonly state: AgentSessionState;

  constructor(options: AgentSessionOptions) {
    registerDefaultProviderPlugins();
    const profileConfig = resolveProfileConfig(options.profile, options.workspaceContext);
    const toolContext: ToolExecutionContext = {
      profileName: profileConfig.profile,
      provider: profileConfig.provider,
      model: profileConfig.model,
      workspaceContext: options.workspaceContext,
    };

    // Create context manager with LLM-based summarization callback
    const contextManager = this.createContextManagerWithSummarization(profileConfig);

    const toolSuites = options.toolSuites ? [...options.toolSuites] : [];
    const toolRuntime = createDefaultToolRuntime(
      toolContext,
      toolSuites,
      {
        observer: options.toolObserver,
        contextManager, // Pass context manager for output truncation
        workingDir: options.workingDir, // Used to load .anvilwing/settings.json hooks
      }
    );

    this.state = {
      profile: options.profile,
      workspaceContext: options.workspaceContext,
      profileConfig,
      toolContext,
      toolRuntime,
      toolSuites,
      toolObserver: options.toolObserver,
      contextManager,
    };
  }

  /**
   * Creates a context manager with LLM-based summarization support
   */
  private createContextManagerWithSummarization(profileConfig: ResolvedProfileConfig): ContextManager {
    // Create summarization callback that doesn't reference this.state
    const summarizationCallback: SummarizationCallback = async (messages: ConversationMessage[]) => {
      try {
        // Create a lightweight agent for summarization
        const provider = createProvider({
          provider: profileConfig.provider,
          model: profileConfig.model,
          temperature: 0, // Use deterministic summarization
          // One compaction at the 1M window can represent ~600k tokens of
          // pruned history. The old 500-token cap was a ~1000:1 squeeze —
          // the decisions/file paths/error-fix pairs the summarization
          // prompt promises to keep could not survive it.
          maxTokens: 2000,
        });

        // Create empty tool context for summarization (no tools needed)
        const emptyToolContext: ToolExecutionContext = {
          profileName: profileConfig.profile,
          provider: profileConfig.provider,
          model: profileConfig.model,
          workspaceContext: null,
        };

        const summarizer = new AgentRuntime({
          provider,
          toolRuntime: createDefaultToolRuntime(emptyToolContext, []), // No tools for summarization
          systemPrompt: CONTEXT_CLEANUP_SYSTEM_PROMPT,
          callbacks: {}, // No callbacks needed for summarization
        });

        // Serialize messages into chunks
        const serialized = messages.map((msg) => serializeMessage(msg)).filter((text) => text.length > 0);

        if (!serialized.length) {
          return '[No content to summarize]';
        }

        // Chunk size sized to the 1M-window reality: a compaction can carry
        // hundreds of thousands of serialized chars. The old 6,000-char chunks
        // meant ~350 SEQUENTIAL summarizer round-trips blocking the next
        // generation for minutes and telephone-gaming the summary; 200k-char
        // chunks (~57k tokens — comfortable in one request) keep it to a few.
        const chunks = chunkMessages(serialized, 200_000);

        // Iteratively summarize chunks
        let runningSummary = '';
        for (const chunk of chunks) {
          const prompt = runningSummary
            ? `Existing summary:\n${runningSummary}\n\nNew conversation chunk:\n${chunk}\n\nMerge the chunk into the running summary, keeping it focused (<600 words).`
            : `Summarize this conversation, keeping it focused (<600 words):\n\n${chunk}`;

          runningSummary = (await summarizer.send(prompt)).trim();
        }

        if (!runningSummary) {
          throw new Error('Summarizer produced no output');
        }
        return runningSummary;
      } catch (error) {
        // Throw (don't return a string) so the ContextManager's catch runs its
        // fallback — simple pruning that KEEPS the real recent messages.
        // Returning a "[Summarization failed: …]" string here would instead be
        // inserted AS the summary, permanently replacing the pruned history with
        // that error text.
        throw error instanceof Error ? error : new Error(String(error));
      }
    };

    return createDefaultContextManager({
      useLLMSummarization: true,
      summarizationCallback,
    }, profileConfig.model);
  }


  get profile(): ProfileName {
    return this.state.profile;
  }

  get profileConfig(): ResolvedProfileConfig {
    return this.state.profileConfig;
  }

  get workspaceContext(): string | null {
    return this.state.workspaceContext ?? null;
  }

  get toolRuntime(): ToolRuntime {
    return this.state.toolRuntime;
  }

  get toolContext(): ToolExecutionContext {
    return this.state.toolContext;
  }

  createAgent(
    selection: ModelSelection,
    callbacks?: AgentCallbacks,
    toolRuntimeOverride?: IToolRuntime,
    options?: { explainEdits?: boolean }
  ): AgentRuntime {
    const provider = createProvider(asProviderConfig(selection));
    const systemPrompt = (selection.systemPrompt ?? this.state.profileConfig.systemPrompt).trim();

    return new AgentRuntime({
      provider,
      toolRuntime: toolRuntimeOverride ?? this.state.toolRuntime,
      systemPrompt,
      callbacks,
      contextManager: this.state.contextManager, // Pass context manager for history pruning
      explainEdits: options?.explainEdits,
    });
  }

  updateToolContext(selection: ModelSelection): void {
    // Create new context with updated provider/model (properties are readonly)
    this.state.toolContext = {
      ...this.state.toolContext,
      provider: selection.provider,
      model: selection.model,
    };
  }

  refreshWorkspaceContext(workspaceContext: string | null): ResolvedProfileConfig {
    const resolved = resolveProfileConfig(this.state.profile, workspaceContext);
    this.state.workspaceContext = workspaceContext;
    // Create new context with updated workspace (properties are readonly)
    this.state.toolContext = {
      ...this.state.toolContext,
      workspaceContext,
    };
    this.state.profileConfig = {
      ...this.state.profileConfig,
      systemPrompt: resolved.systemPrompt,
      rulebook: resolved.rulebook,
    };
    this.state.toolRuntime = createDefaultToolRuntime(
      this.state.toolContext,
      this.state.toolSuites,
      {
        observer: this.state.toolObserver,
        contextManager: this.state.contextManager, // Preserve context manager
      }
    );
    return this.state.profileConfig;
  }

  get contextManager(): ContextManager {
    return this.state.contextManager;
  }

  get toolSuites(): ToolSuite[] {
    return this.state.toolSuites;
  }
}

/**
 * Serialize a message for summarization. Tool BODIES are capped: stale tool
 * output (file reads, command logs — up to 50k chars each) is the bulk of a
 * compaction's input while contributing the least summary value; uncapped, it
 * multiplied the chunk count several-fold.
 */
function serializeMessage(message: ConversationMessage): string {
  switch (message.role) {
    case 'user':
      return `User: ${message.content}`;
    case 'assistant': {
      // Audit #22: a tool-calling assistant message often has EMPTY content
      // (the work is in toolCalls). Dropping them erased "which files were
      // edited / what was run" from every summary. Append a compact tool-call
      // trace so the post-compaction model still knows what it did.
      const calls = Array.isArray(message.toolCalls) && message.toolCalls.length
        ? ' [called: ' + message.toolCalls.map((c) => {
            const a = c.arguments as Record<string, unknown> | undefined;
            const arg = a?.['file_path'] ?? a?.['path'] ?? a?.['command'] ?? a?.['pattern'] ?? a?.['query'];
            const argStr = typeof arg === 'string' ? `(${arg.slice(0, 60)})` : '';
            return `${c.name}${argStr}`;
          }).join(', ') + ']'
        : '';
      return `Assistant: ${message.content}${calls}`;
    }
    case 'tool': {
      const body = typeof message.content === 'string' ? message.content : String(message.content ?? '');
      const capped = body.length > 500 ? `${body.slice(0, 500)}… [tool output truncated for summary]` : body;
      return `Tool(${message.name ?? 'unknown'}): ${capped}`;
    }
    case 'system':
      return `System: ${message.content}`;
    default:
      return '';
  }
}

/**
 * Chunk messages by character count
 */
function chunkMessages(serialized: string[], maxCharsPerChunk: number): string[] {
  const chunks: string[] = [];
  let buffer = '';

  for (const entry of serialized) {
    const segment = buffer ? `\n\n${entry}` : entry;
    if (buffer && buffer.length + segment.length > maxCharsPerChunk) {
      chunks.push(buffer.trim());
      buffer = entry;
      continue;
    }
    buffer += buffer ? `\n\n${entry}` : entry;
  }

  if (buffer) {
    chunks.push(buffer.trim());
  }

  return chunks;
}

function asProviderConfig(selection: ModelSelection): ProviderConfig {
  return {
    provider: selection.provider,
    model: selection.model,
    temperature: selection.temperature,
    maxTokens: selection.maxTokens,
    reasoningEffort: selection.reasoningEffort,
    textVerbosity: selection.textVerbosity,
    // Pass thinking configuration for extended thinking models
    thinking: selection.thinking,
    thinkingLevel: selection.thinkingLevel,
  };
}

// Re-exported so the agentController can build providers on demand
// (e.g., for parallel sub-agents that spawn their own LeanAgent
// per task — they need to construct a fresh provider matching the
// user's current model selection without coupling to the session).
export function selectionToProviderConfig(selection: ModelSelection): ProviderConfig {
  return asProviderConfig(selection);
}
