import path from 'node:path';
import type { IToolRuntime } from './toolRuntime.js';
import {
  type ConversationMessage,
  type LLMProvider,
  type ProviderModelInfo,
  type ProviderToolDefinition,
  type ToolCallRequest,
  type ProviderUsage,
  type StreamChunk,
} from './types.js';
import { ContextManager } from './contextManager.js';
import { isMultilinePaste, processPaste, type PasteSummary } from './multilinePasteHandler.js';
import { safeErrorMessage } from './secretStore.js';
import { logDebug, debugSnippet } from '../utils/debugLogger.js';
import { ensureNextSteps } from './finalResponseFormatter.js';
import { isAdversarialEnabled, reviewDraft } from './adversarial.js';
// Canonical error classification (audit Rank 5, Phase 2). The agent's transient
// semantics is distinct (rate-limit + 5xx folded into transient), so it imports
// isAgentTransientError under its historical local name; logic moved verbatim.
import { isContextOverflowError, isAgentTransientError as isTransientError } from './errorClassification.js';
import { detectRepetitionLoop, trimRepetition } from './repetitionGuard.js';
import { buildTodoReminder } from '../tools/todoTools.js';

/**
 * Maximum number of context overflow recovery attempts
 */
const MAX_CONTEXT_RECOVERY_ATTEMPTS = 3;

// Streaming runs without timeouts - we let the model take as long as it needs

/**
 * Maximum number of transient error retries
 */
const MAX_TRANSIENT_RETRIES = 3;

/**
 * Delay before retry (in ms), with exponential backoff
 */
function getRetryDelay(attempt: number): number {
  // Base delay of 1 second, doubles each attempt: 1s, 2s, 4s
  return Math.min(1000 * Math.pow(2, attempt - 1), 10000);
}

/**
 * Sleep for the specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Intent analysis result passed to callbacks for verification
 */
export interface IntentAnalysis {
  /** Restatement of what the agent understood */
  intentRestatement: string;
  /** Specific files/components/scope identified */
  identifiedScope: string[];
  /** Potential risks or concerns about the interpretation */
  interpretationRisks: string[];
  /** Confidence score (0-1) */
  confidence: number;
  /** Questions that need clarification before proceeding */
  clarificationNeeded: string[];
}

export interface AgentCallbacks {
  onAssistantMessage?(content: string, metadata: AssistantMessageMetadata): void;
  onStreamChunk?(chunk: string, type?: 'content' | 'reasoning'): void;
  /** Called when real token usage is received from the provider during streaming */
  onUsage?(usage: ProviderUsage): void;
  onContextPruned?(removedCount: number, stats: Record<string, unknown>): void;
  /** Called when the adversarial reviewer refutes a finished draft (drives auto-correction). */
  onAdversarialFindings?(findings: string): void;
  /** Called when auto context squishing occurs in background */
  onContextSquishing?(message: string): void;
  /** Called when context recovery from overflow is attempted */
  onContextRecovery?(attempt: number, maxAttempts: number, message: string): void;
  /** Called when agent continues after context recovery - useful for updating UI */
  onContinueAfterRecovery?(): void;
  /** Called when multi-line paste is detected - displays the actual pasted content */
  onMultilinePaste?(content: string, metadata: PasteSummary): void;
  /** Called when verification should be triggered for a final response */
  onVerificationNeeded?(response: string, context: VerificationCallbackContext): void;
  /** Called when the operation is cancelled by the user */
  onCancelled?(): void;
  /** Called when tool execution starts - useful for updating activity status */
  onToolExecution?(toolName: string, isStart: boolean, args?: Record<string, unknown>): void;
  /** Called when the agent generates an explanation for a completed edit */
  onEditExplanation?(payload: EditExplanationPayload): void;
  /**
   * Called IMMEDIATELY when a user request is received, BEFORE any provider call.
   * Useful for updating UI activity without showing filler messages.
   */
  onRequestReceived?(requestPreview: string): void;
  /**
   * Called BEFORE the first tool call in a turn, allowing UI to update activity state.
   * @param toolNames - Names of tools about to be called
   * @param hasModelNarration - Whether the model provided narration/thinking before tools
   * @returns Optional acknowledgement text to display (if model didn't provide narration)
   */
  onBeforeFirstToolCall?(toolNames: string[], hasModelNarration: boolean): string | undefined;
  /**
   * Called when the agent encounters a transient error and will retry.
   * @param attempt - Current retry attempt number
   * @param maxAttempts - Maximum retry attempts
   * @param error - The error that triggered the retry
   */
  onRetrying?(attempt: number, maxAttempts: number, error: Error): void;
  /**
   * Called when intent analysis is complete, BEFORE processing begins.
   * Allows UI to display understanding verification and get user confirmation if needed.
   * @param analysis - The intent analysis with restatement, scope, and risks
   * @returns true to proceed, false to abort (user can provide clarification)
   */
  onIntentAnalyzed?(analysis: IntentAnalysis): boolean | Promise<boolean>;
}

export interface ToolExecutionRecord {
  name: string;
  success: boolean;
  hasOutput: boolean;
}

export interface VerificationCallbackContext {
  /** Working directory for verification */
  workingDirectory: string;
  /** Recent conversation history for context */
  conversationHistory: string[];
  /** Provider ID */
  provider: string;
  /** Model ID */
  model: string;
}

export interface AssistantMessageMetadata {
  isFinal: boolean;
  elapsedMs?: number;
  usage?: ProviderUsage | null;
  contextStats?: Record<string, unknown> | null;
  /** True if content was already displayed via streaming chunks */
  wasStreamed?: boolean;
  /** Hint to UI to suppress rendering of internal/system filler messages */
  suppressDisplay?: boolean;
}

export interface EditExplanationPayload {
  explanation: string;
  files: string[];
  toolName: string;
  toolCallId?: string;
}


interface AgentOptions {
  provider: LLMProvider;
  toolRuntime: IToolRuntime;
  systemPrompt: string;
  callbacks?: AgentCallbacks;
  contextManager?: ContextManager;
  /** Provider ID for verification context */
  providerId?: string;
  /** Model ID for verification context */
  modelId?: string;
  /** Working directory for verification */
  workingDirectory?: string;
  /** Whether to generate and surface explanations after edit tools complete */
  explainEdits?: boolean;
}

export class AgentRuntime {
  private readonly messages: ConversationMessage[] = [];
  private readonly provider: LLMProvider;
  private readonly toolRuntime: IToolRuntime;
  private readonly callbacks: AgentCallbacks;
  private readonly contextManager: ContextManager | null;
  private activeRun: { startedAt: number } | null = null;
  private readonly baseSystemPrompt: string | null;
  private readonly providerId: string;
  private readonly modelId: string;
  private readonly workingDirectory: string;
  private readonly explainEdits: boolean;
  private cancellationRequested = false;
  // Loop detection: track last tool calls to detect stuck loops
  private lastToolCallSignature: string | null = null;
  private repeatedToolCallCount = 0;
  private static readonly MAX_REPEATED_TOOL_CALLS = 5; // Stop on 5th identical call (4 allowed)

  // Session-level context recovery tracking to prevent endless recovery loops
  private totalContextRecoveries = 0;
  private static readonly MAX_TOTAL_RECOVERIES = 5; // Max recoveries across entire session

  // Behavioral loop detection: track recent tool calls to catch repetitive patterns
  // e.g., calling "execute_bash" with "git status" 5 times even if output differs slightly
  private recentToolCalls: Array<{ name: string; cmdHash: string }> = [];
  // Per-episode count of genuinely-executed writes per file path, and paths already
  // nudged. Edits are loop-exempt and the governor only fingerprints at turn
  // boundaries, so without this a re-read->rewrite cycle can rewrite one file
  // unboundedly within a single send(). Reset each episode in resetBehavioralLoopTracking.
  private editPathCounts = new Map<string, number>();
  private nudgedEditPaths = new Set<string>();
  private static readonly TOOL_HISTORY_SIZE = 12;
  private static readonly BEHAVIORAL_LOOP_THRESHOLD = 3; // Same tool+cmd 3+ times in last 12 = stuck
  private static readonly EDIT_NUDGE_THRESHOLD = 4;   // nudge once at the 4th rewrite of one file
  private static readonly MAX_SAME_FILE_REWRITES = 8; // hard-stop the episode at the 9th

  // Consecutive failure detection: track failed commands to prevent stuck loops
  private consecutiveFailures = 0;
  private static readonly MAX_CONSECUTIVE_FAILURES = 3; // Stop after 3 consecutive failed commands
  private static readonly EDIT_CONTEXT_CHAR_LIMIT = 4000;

  // Never cache stateful tools - they must always execute to reflect current system state
  private static readonly NON_CACHEABLE_TOOL_NAMES = new Set([
    'bash',
    'execute_bash',
    'execute_command',
    'run_command',
    'edit',
    'edit_file',
    'write',
    'write_file',
    'notebookedit',
    'read',
    'read_file',
    'read_files',
    'list_files',
    'list_dir',
    'glob',
    'grep',
    'search',
    'search_text',
    'git_status',
    'git_diff',
    'git_log',
    'git_commit',
    'git_push',
    // Registry names (compared lowercased). These were silently cacheable
    // because the legacy deny-list above predates the current tool registry —
    // caching them serves stale results, freezes polling tools on their first
    // snapshot, skips a mutation entirely, or reuses a stale human decision.
    'multiedit',        // mutates files
    'search_replace',   // mutates files
    'file_exists',      // filesystem state changes
    'bashoutput',       // polls a background shell — must be fresh each call
    'killshell',        // mutates (terminates a shell)
    'todoread',         // session-mutable todo state
    'todowrite',        // mutates todo state
    'memory_save',      // mutates persistent memory
    'memory_delete',    // mutates persistent memory
    'memory_list',      // reflects mutable memory state
    'memory_load',      // reflects mutable memory state
    'hitl_approval',    // human input — never reuse a prior decision
    'hitl_decision',
    'hitl_select',
    'hitl_status',
    'hitl_yesno',
    'agent',            // spawns a sub-agent (side effects)
    'agent_list',       // polls live sub-agents
    'agent_output',     // polls a sub-agent — must be fresh
    'agent_status',     // polls a sub-agent — must be fresh
    'agent_send_message',
    'agent_stop',
    'parallel_agents',  // spawns sub-agents
    'skill',            // executes a playbook (side effects)
    'git',              // unified git tool — repo state changes
    'git_smart_commit',
    'git_create_pr',
    'gitrestore',
    'githistory',
    'web_fetch',        // remote content changes between calls
    'webfetch',
    'webextract',
    'websearch',
    'helia',
  ]);

  // Skip loop short-circuiting for direct execution tools to avoid blocking user commands
  private static readonly LOOP_EXEMPT_TOOL_NAMES = new Set([
    'bash',
    'execute_bash',
    'execute_command',
    'run_command',
    'edit',
    'edit_file',
    'write',
    'write_file',
    'notebookedit',
    // Read/search tools are noise-prone and often repeated legitimately
    'read',
    'read_file',
    'read_files',
    'list_files',
    'list_dir',
    'glob',
    'glob_search',
    'grep',
    'search',
    // Polling tools repeat by design (watching a background shell or sub-agent);
    // now that they are non-cacheable, exempt them so legitimate repeated polls
    // don't false-trip the behavioral-loop guard.
    'bashoutput',
    'agent_output',
    'agent_status',
    'agent_list',
    // Read-only lookups the agent legitimately repeats (todos, memory, presence
    // checks). They became non-cacheable above, so without this they could
    // false-trip the loop guard on a normal 3rd identical call.
    'todoread',
    'file_exists',
    'memory_load',
    'memory_list',
    'hitl_status', // polled while waiting on a human — repeats are expected
  ]);

  // Tool result cache: prevent duplicate identical tool calls by returning cached results
  // Key: tool signature (name + JSON args), Value: result string
  private toolResultCache = new Map<string, string>();
  private static readonly TOOL_CACHE_MAX_SIZE = 50; // Keep last 50 tool results

  // Track tool history position per send() call for accurate progress detection
  private toolHistoryCursor = 0;

  // Cached model info from provider API (real context window limits)
  private modelInfo: ProviderModelInfo | null = null;
  private modelInfoFetched = false;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.toolRuntime = options.toolRuntime;
    this.callbacks = options.callbacks ?? {};
    this.contextManager = options.contextManager ?? null;
    this.providerId = options.providerId ?? 'unknown';
    this.modelId = options.modelId ?? 'unknown';
    this.workingDirectory = options.workingDirectory ?? process.cwd();
    this.explainEdits = options.explainEdits ?? false;

    const trimmedPrompt = options.systemPrompt.trim();
    this.baseSystemPrompt = trimmedPrompt || null;
    if (trimmedPrompt) {
      this.messages.push({ role: 'system', content: trimmedPrompt });
    }
  }

  /**
   * Request cancellation of the current operation.
   * The agent will stop at the next safe point (after current tool completes).
   */
  requestCancellation(): void {
    this.cancellationRequested = true;
  }

  /**
   * Check if cancellation has been requested.
   */
  isCancellationRequested(): boolean {
    return this.cancellationRequested;
  }

  /**
   * Check if the agent is currently processing a request.
   */
  isRunning(): boolean {
    return this.activeRun !== null;
  }

  /**
   * Check if any of the tool calls are edit operations (Edit, Write)
   */
  private isEditToolCall(toolName: string): boolean {
    const name = toolName.toLowerCase();
    return name === 'edit' || name === 'edit_file' || name === 'write' || name === 'write_file';
  }

  /**
   * Normalized absolute path key for an edit/write call — derived the same way
   * interactiveShell builds filesModified so 'edit' and 'write' to one file collide.
   */
  private editPathKey(call: ToolCallRequest): string | null {
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    const raw = args.file_path ?? args.path;
    if (typeof raw !== 'string' || !raw.trim()) {
      return null;
    }
    return path.resolve(this.workingDirectory, raw);
  }

  /**
   * Count one non-cached write to a path this episode. Returns a one-line nudge to
   * append to the tool result the first time a path crosses the soft threshold, else
   * null. The hard ceiling (episode stop) is enforced in checkBehavioralLoop.
   */
  private recordEditWrite(call: ToolCallRequest): string | null {
    const key = this.editPathKey(call);
    if (!key) {
      return null;
    }
    const n = (this.editPathCounts.get(key) ?? 0) + 1;
    this.editPathCounts.set(key, n);
    if (n === AgentRuntime.EDIT_NUDGE_THRESHOLD && !this.nudgedEditPaths.has(key)) {
      this.nudgedEditPaths.add(key);
      const rel = path.relative(this.workingDirectory, key) || key;
      return `${rel} has been rewritten ${n} times this turn. Make ONE targeted edit of the remaining change — do not re-read and rewrite the whole file.`;
    }
    return null;
  }

  /**
   * Extract a display-friendly file path from a tool call (prefers workspace-relative path)
   */
  private getEditedFilePath(call: ToolCallRequest): string | null {
    const args = call.arguments as Record<string, unknown>;
    const rawPath = typeof args['file_path'] === 'string'
      ? args['file_path']
      : typeof args['path'] === 'string'
        ? args['path']
        : null;

    if (!rawPath) {
      return null;
    }

    const relativePath = path.relative(this.workingDirectory, rawPath);
    if (relativePath && !relativePath.startsWith('..') && relativePath !== '') {
      return relativePath;
    }

    return rawPath;
  }

  /**
   * Get the file paths from edit tool calls for the explanation prompt
   */
  private getEditedFiles(toolCalls: ToolCallRequest[]): string[] {
    const files: string[] = [];
    for (const call of toolCalls) {
      if (this.isEditToolCall(call.name)) {
        const filePath = this.getEditedFilePath(call);
        if (filePath) {
          files.push(filePath);
        }
      }
    }
    return files;
  }

  async send(text: string, useStreaming = false): Promise<string> {
    const prompt = text.trim();
    if (!prompt) {
      return '';
    }
    // Notify UI immediately so it can reflect activity without waiting for generation
    this.callbacks.onRequestReceived?.(prompt.slice(0, 400));

    // Reset cancellation flag and loop tracking at start of new request
    this.cancellationRequested = false;
    this.resetBehavioralLoopTracking();
    // Track tool history position for this run
    this.toolHistoryCursor = this.toolRuntime.getToolHistory().length;

    // Handle multi-line paste: show actual content to user, send full content to AI
    if (isMultilinePaste(prompt)) {
      const processed = processPaste(prompt);
      // Notify UI about the paste with the actual content, not just summary
      this.callbacks.onMultilinePaste?.(processed.fullContent, processed.metadata);
      // Send the full content to the AI
      this.messages.push({ role: 'user', content: processed.fullContent });
    } else {
      // Single-line or short text: send as-is
      this.messages.push({ role: 'user', content: prompt });
    }
    const run = { startedAt: Date.now() };
    this.activeRun = run;
    try {
      // Always use streaming when available - no fallback
      if (useStreaming && this.provider.generateStream) {
        return await this.processConversationStreaming();
      }
      return await this.processConversation();
    } finally {
      if (this.activeRun === run) {
        this.activeRun = null;
      }
      // Reset cancellation flag when done
      this.cancellationRequested = false;
    }
  }

  /**
   * The messages to SEND this request: the persisted history plus a transient
   * <system-reminder> of the live TODO plan (Claude Code parity). Computed
   * fresh each call so the model always sees the current checklist even after
   * older turns — including the original TodoWrite result — were compacted
   * away. The reminder is NEVER pushed into this.messages, so it doesn't
   * accumulate or get persisted; only the live plan drives it.
   */
  private messagesForRequest(): ConversationMessage[] {
    const reminder = buildTodoReminder();
    if (!reminder) return this.messages;
    return [...this.messages, { role: 'system', content: reminder }];
  }

  private async processConversation(): Promise<string> {
    let contextRecoveryAttempts = 0;
    let transientRetryAttempts = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Check for cancellation at start of each iteration
      if (this.cancellationRequested) {
        this.callbacks.onCancelled?.();
        return '[Operation cancelled by user]';
      }

      // Prune messages if approaching context limit (BEFORE generation)
      await this.pruneMessagesIfNeeded();

      try {
        const response = await this.provider.generate(this.messagesForRequest(), this.providerTools);
        const usage = response.usage ?? null;
        const contextStats = this.getContextStats();

        // Reset recovery attempts on successful generation
        contextRecoveryAttempts = 0;

        if (response.type === 'tool_calls') {
          // BEHAVIORAL LOOP DETECTION: Check if model is stuck calling same tool repeatedly
          const behavioralLoopResult = this.checkBehavioralLoop(response.toolCalls);
          if (behavioralLoopResult) {
            this.emitAssistantMessage(behavioralLoopResult, { isFinal: true, usage, contextStats });
            this.messages.push({ role: 'assistant', content: behavioralLoopResult });
            return behavioralLoopResult;
          }

          // Loop detection: check if same tool calls are being repeated (exact signature match)
          const signatureCalls = response.toolCalls.filter(call => !this.shouldSkipLoopDetection(call));
          const toolSignature = signatureCalls.length
            ? signatureCalls
              .map((t) => `${t.name}:${JSON.stringify(t.arguments)}`)
              .sort()
              .join('|')
            : null;
          if (toolSignature && toolSignature === this.lastToolCallSignature) {
            this.repeatedToolCallCount++;
            if (this.repeatedToolCallCount >= AgentRuntime.MAX_REPEATED_TOOL_CALLS) {
              // Break out of loop - model is stuck
              const loopMsg = `Tool loop detected: same tools called ${this.repeatedToolCallCount} times. Please try a different approach or provide more specific instructions.`;
              this.emitAssistantMessage(loopMsg, { isFinal: true, usage, contextStats });
              this.messages.push({ role: 'assistant', content: loopMsg });
              this.lastToolCallSignature = null;
              this.repeatedToolCallCount = 0;
              return loopMsg;
            }
          } else if (toolSignature) {
            this.lastToolCallSignature = toolSignature;
            this.repeatedToolCallCount = 1;
          } else {
            this.lastToolCallSignature = null;
            this.repeatedToolCallCount = 0;
          }

          // Emit narration if present - it shows the AI's thought process before tools
          const narration = response.content?.trim();
          if (narration) {
            this.emitAssistantMessage(narration, {
              isFinal: false,
              usage,
              contextStats,
            });
          }
          this.maybeAckToolCalls(response.toolCalls, Boolean(narration?.length), usage, contextStats);
          const assistantMessage: ConversationMessage = {
            role: 'assistant',
            content: response.content ?? '',
          };
          if (response.toolCalls?.length) {
            assistantMessage.toolCalls = response.toolCalls;
          }
          this.messages.push(assistantMessage);
          await this.resolveToolCalls(response.toolCalls);
          continue;
        }

        const reply = response.content?.trim() ?? '';
        const { output: ensuredReply } = ensureNextSteps(reply);
        let finalReply = ensuredReply;

        // Reset loop detection when we get a text response (not just tool calls)
        if (finalReply.length >= 10) {
          this.lastToolCallSignature = null;
          this.repeatedToolCallCount = 0;
        }

        finalReply = await this.maybeAdversarialReview(finalReply);

        if (finalReply) {
          this.emitAssistantMessage(finalReply, { isFinal: true, usage, contextStats });
        }
        this.messages.push({ role: 'assistant', content: finalReply });

        // Trigger verification for final responses with verifiable claims
        this.triggerVerificationIfNeeded(finalReply);

        return finalReply;
      } catch (error) {
        // Auto-recover from context overflow errors (with session-level limit)
        const canRecover = contextRecoveryAttempts < MAX_CONTEXT_RECOVERY_ATTEMPTS &&
                          this.totalContextRecoveries < AgentRuntime.MAX_TOTAL_RECOVERIES;
        if (isContextOverflowError(error) && canRecover) {
          contextRecoveryAttempts++;
          this.totalContextRecoveries++;
          const recovered = await this.recoverFromContextOverflow(contextRecoveryAttempts);
          if (recovered) {
            // Notify UI that we're continuing after recovery
            this.callbacks.onContinueAfterRecovery?.();
            // Retry the generation with reduced context
            continue;
          }
        }
        // Auto-retry transient errors (network issues, rate limits, server errors)
        if (isTransientError(error) && transientRetryAttempts < MAX_TRANSIENT_RETRIES) {
          transientRetryAttempts++;
          const delayMs = getRetryDelay(transientRetryAttempts);
          this.callbacks.onRetrying?.(transientRetryAttempts, MAX_TRANSIENT_RETRIES, error as Error);
          await sleep(delayMs);
          continue;
        }
        // Re-throw if not recoverable or recovery failed
        throw error;
      }
    }
  }

  private async processConversationStreaming(): Promise<string> {
    if (!this.provider.generateStream) {
      return this.processConversation();
    }

    let contextRecoveryAttempts = 0;
    let transientRetryAttempts = 0;
    // Once any content/reasoning has reached the UI, a mid-stream transient error
    // must NOT retry: re-running the stream re-emits from chunk 0 and duplicates
    // what the user already saw. (The ResilientProvider has the same latch one
    // layer down; this guards the agent's own retry loop wrapped around it.)
    let hasStreamedToUser = false;
    // Hard guardrail against RUNAWAY provider output, sized to the model's
    // real maximum: anvilwing can emit up to 384,000 output tokens
    // (~1.5M chars) in ONE response — the old 120k-char cap force-truncated
    // legitimately long responses. Applied PER REQUEST (totalCharsReceived
    // resets each loop iteration below): the old never-reset counter
    // accumulated across a turn's whole tool loop, so a long agentic turn of
    // many small responses tripped the limit and had its pending tool calls
    // dropped mid-task.
    const STREAM_HARD_CHAR_LIMIT = 1_600_000;
    let totalCharsReceived = 0;
    let truncatedResponse = false;
    // Degeneration cutoff bookkeeping (see the content-chunk handler below).
    let degeneratedResponse = false;
    let lastRepetitionCheck = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Check for cancellation at start of each iteration
      if (this.cancellationRequested) {
        this.callbacks.onCancelled?.();
        return '[Operation cancelled by user]';
      }

      // Prune messages if approaching context limit (BEFORE generation)
      await this.pruneMessagesIfNeeded();

      try {
        // Per-request guardrail window (see STREAM_HARD_CHAR_LIMIT above).
        totalCharsReceived = 0;
        lastRepetitionCheck = 0;
        degeneratedResponse = false;
        let fullContent = '';
        let reasoningContent = '';
        const toolCalls: ToolCallRequest[] = [];
        let usage: ProviderUsage | null = null;
        const suppressStreamNarration = this.shouldSuppressToolNarration();
        let bufferedContent = '';

        const stream = this.provider.generateStream(this.messagesForRequest(), this.providerTools);
        const iterator = stream[Symbol.asyncIterator]();
        let streamClosed = false;
        const closeStream = async (): Promise<void> => {
          if (streamClosed) {
            return;
          }
          streamClosed = true;
          if (typeof iterator.return === 'function') {
            try {
              await iterator.return();
            } catch (closeError) {
              logDebug(`[agent] Failed to close stream cleanly: ${safeErrorMessage(closeError)}`);
            }
          }
        };

        const describeChunk = (chunk?: StreamChunk): string => {
          if (!chunk) {
            return 'unknown chunk';
          }
          switch (chunk.type) {
            case 'content':
            case 'reasoning': {
              const snippet = debugSnippet(chunk.content);
              return snippet ? `${chunk.type} → ${snippet}` : chunk.type;
            }
            case 'tool_call':
              return chunk.toolCall ? `tool_call ${chunk.toolCall.name}` : 'tool_call';
            case 'usage':
              if (chunk.usage?.totalTokens != null) {
                return `usage tokens=${chunk.usage.totalTokens}`;
              }
              return 'usage';
            case 'done':
              return 'done';
            default:
              return chunk.type;
          }
        };

        // Inter-chunk stall watchdog. A silently dead SSE socket (TCP black
        // hole, proxy drop) yields NOTHING and never errors — without this the
        // turn froze for up to the 24h API timeout, halting an autonomous
        // multi-hour run until a human noticed. ANY chunk (reasoning included)
        // resets the window, so a model that thinks for minutes is fine; only
        // total silence past the window trips it. Surfacing a retryable error
        // lets the resilience layer re-issue when no chunk has been yielded yet.
        const STREAM_STALL_MS = (() => {
          const raw = parseInt(process.env['ANVILWING_STREAM_STALL_MS'] ?? '', 10);
          return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000; // 10 min default
        })();
        const nextWithWatchdog = (): Promise<IteratorResult<StreamChunk>> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const watchdog = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              // "timeout" in the message → isAgentTransientError classifies it
              // retryable, so the turn-level retry re-issues when nothing has
              // streamed to the user yet (hasStreamedToUser guard at the catch).
              reject(new Error(
                `Stream stalled (inter-chunk timeout): no data for ${Math.round(STREAM_STALL_MS / 1000)}s — likely a dead connection`,
              ));
            }, STREAM_STALL_MS);
            if (typeof timer.unref === 'function') timer.unref();
          });
          // Promise.race does NOT cancel the loser — clear the timer on settle
          // so we don't leak one armed timer per consumed chunk.
          return Promise.race([iterator.next(), watchdog]).finally(() => clearTimeout(timer));
        };

        try {
          let chunkCount = 0;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            let result: IteratorResult<StreamChunk>;
            try {
              result = await nextWithWatchdog();
            } catch (stallError) {
              // Unfreeze the turn: close the dead stream, then rethrow so the
              // turn-level transient-retry / resilience path handles it.
              await closeStream();
              throw stallError;
            }
            chunkCount++;
            // Only log significant chunks (tool calls, done), not every content/reasoning token
            if (result.done || result.value?.type === 'tool_call') {
              const chunkLabel = result.done ? 'done' : describeChunk(result.value);
              logDebug(`[agent] chunk ${chunkCount}: ${chunkLabel}`);
            }

            // Check for cancellation during streaming
            if (this.cancellationRequested) {
              await closeStream();
              this.callbacks.onCancelled?.();
              const partial = (fullContent || reasoningContent).trim();
              if (partial) {
                this.messages.push({ role: 'assistant', content: `${partial}\n\n[Cancelled by user]` });
              }
              return '[Operation cancelled by user]';
            }

            if (result.done) {
              break;
            }

            const chunk = result.value;

            if (chunk.type === 'reasoning' && chunk.content) {
              // Buffer reasoning content - don't stream token-by-token
              // It will be emitted as a complete block when ready.
              // Cap sized to the model's real output limit (384k tokens) — the
              // old 24k-char tail-slice SILENTLY amputated the head of any
              // long reasoning block, and for models that deliver the whole
              // answer via reasoning_content the mangled version became the
              // user-visible reply AND the persisted history entry.
              const next = reasoningContent + chunk.content;
              totalCharsReceived += chunk.content.length;
              if (next.length > 1_600_000) {
                reasoningContent = `[earlier reasoning truncated]\n${next.slice(-1_600_000)}`;
              } else {
                reasoningContent = next;
              }
              if (totalCharsReceived > STREAM_HARD_CHAR_LIMIT) {
                truncatedResponse = true;
                await closeStream();
                break;
              }
              continue;
            }

            if (chunk.type === 'content' && chunk.content) {
              const nextContent = fullContent + chunk.content;
              totalCharsReceived += chunk.content.length;
              // OOM guard sized to the model's real 384k-token output limit.
              // The old 48k-char tail-slice SILENTLY head-truncated any long
              // response: the user saw the full stream, but history (and the
              // persisted session) stored a mangled copy the model then read
              // back on the next request. Truncation now carries a marker.
              fullContent = nextContent.length > 1_600_000
                ? `[earlier output truncated]\n${nextContent.slice(-1_600_000)}`
                : nextContent;
              if (suppressStreamNarration) {
                const nextBuffered = bufferedContent + chunk.content;
                bufferedContent = nextBuffered.length > 1_600_000
                  ? `[earlier output truncated]\n${nextBuffered.slice(-1_600_000)}`
                  : nextBuffered;
              } else {
                this.callbacks.onStreamChunk?.(chunk.content, 'content');
                hasStreamedToUser = true;
              }
              if (totalCharsReceived > STREAM_HARD_CHAR_LIMIT) {
                truncatedResponse = true;
                await closeStream();
                break;
              }
              // Degeneration cutoff: if the model has fallen into a repetition
              // loop (same block emitted back-to-back many times), stop the
              // stream early and keep one copy. Checked periodically — the
              // detector is cheap but not free, and a loop only matters once
              // it's many copies deep. Without this a real run streamed the
              // same summary ~30× over 336s.
              if (fullContent.length - lastRepetitionCheck >= 4000) {
                lastRepetitionCheck = fullContent.length;
                const rep = detectRepetitionLoop(fullContent);
                if (rep.looping && rep.unit && rep.repeats) {
                  fullContent = trimRepetition(fullContent, rep.unit, rep.repeats);
                  if (suppressStreamNarration) {
                    bufferedContent = trimRepetition(bufferedContent, rep.unit, rep.repeats);
                  }
                  degeneratedResponse = true;
                  await closeStream();
                  break;
                }
              }
            } else if (chunk.type === 'tool_call' && chunk.toolCall) {
              // On first tool call, flush any buffered content
              if (toolCalls.length === 0) {
                // Emit complete reasoning block first
                if (reasoningContent.trim()) {
                  this.callbacks.onStreamChunk?.(reasoningContent, 'reasoning');
                  hasStreamedToUser = true;
                }
                // Then emit buffered narration content
                if (suppressStreamNarration && bufferedContent) {
                  this.callbacks.onStreamChunk?.(bufferedContent, 'content');
                  hasStreamedToUser = true;
                  bufferedContent = '';
                }
              }
              toolCalls.push(chunk.toolCall);
            } else if (chunk.type === 'usage' && chunk.usage) {
              usage = chunk.usage;
              // Emit real token usage during streaming
              this.callbacks.onUsage?.(chunk.usage);
            }
          }
        } finally {
          await closeStream();
        }

        // Reset recovery attempts on successful generation
        contextRecoveryAttempts = 0;

        const contextStats = this.getContextStats();
        // IMPORTANT: Only use fullContent for user-visible output
        // reasoningContent is internal model thinking and should NEVER be shown to users
        // We keep it for conversation history (helps the model) but not for display
        const combinedContent = fullContent;

        if (truncatedResponse) {
          const notice = '\n\n[Response truncated: reached the runaway-output safety limit (1.6M characters in one response) to prevent OOM.]';
          const updated = combinedContent ? `${combinedContent}${notice}` : notice.trim();
          fullContent = updated;
          reasoningContent = '';
          // Partial tool calls are unsafe when truncated; drop them
          toolCalls.length = 0;
          // Emit the notice via streaming so it reaches the UI — message.complete is suppressed
          // when the buffer is already populated (wasStreamed=true path in interactiveShell.ts)
          this.callbacks.onStreamChunk?.(notice, 'content');
        }

        if (degeneratedResponse) {
          // fullContent was already trimmed (one copy + marker) at cutoff time.
          // Mid-loop tool calls are unreliable once the model is degenerating.
          toolCalls.length = 0;
          logDebug('[agent] degeneration cutoff: stopped a repetition loop and kept one copy');
        }

        // If no tool calls were issued, emit reasoning and buffered content as complete blocks
        if (toolCalls.length === 0) {
          // Emit complete reasoning block if we have one
          if (reasoningContent.trim()) {
            this.callbacks.onStreamChunk?.(reasoningContent, 'reasoning');
          }
          // Emit buffered narration content
          if (suppressStreamNarration && bufferedContent) {
            this.callbacks.onStreamChunk?.(bufferedContent, 'content');
            bufferedContent = '';
          }
        }

        // Check if we got tool calls
        if (toolCalls.length > 0) {
          // BEHAVIORAL LOOP DETECTION: Check if model is stuck calling same tool repeatedly
          // This catches patterns like "git status" called 5 times even with slightly different outputs
          const behavioralLoopResult = this.checkBehavioralLoop(toolCalls);
          if (behavioralLoopResult) {
            this.emitAssistantMessage(behavioralLoopResult, { isFinal: true, usage, contextStats, wasStreamed: true });
            this.messages.push({ role: 'assistant', content: behavioralLoopResult });
            return behavioralLoopResult;
          }

          // Loop detection: check if same tool calls are being repeated (exact signature match)
          const signatureCalls = toolCalls.filter(call => !this.shouldSkipLoopDetection(call));
          const toolSignature = signatureCalls.length
            ? signatureCalls
              .map((t) => `${t.name}:${JSON.stringify(t.arguments)}`)
              .sort()
              .join('|')
            : null;
          if (toolSignature && toolSignature === this.lastToolCallSignature) {
            this.repeatedToolCallCount++;
            if (this.repeatedToolCallCount >= AgentRuntime.MAX_REPEATED_TOOL_CALLS) {
              // Break out of loop - model is stuck
              const loopMsg = `Tool loop detected: same tools called ${this.repeatedToolCallCount} times. Please try a different approach or provide more specific instructions.`;
              this.emitAssistantMessage(loopMsg, { isFinal: true, usage, contextStats, wasStreamed: true });
              this.messages.push({ role: 'assistant', content: loopMsg });
              this.lastToolCallSignature = null;
              this.repeatedToolCallCount = 0;
              return loopMsg;
            }
          } else if (toolSignature) {
            this.lastToolCallSignature = toolSignature;
            this.repeatedToolCallCount = 1;
          } else {
            this.lastToolCallSignature = null;
            this.repeatedToolCallCount = 0;
          }

          // Content was already streamed via onStreamChunk, just record it for context
          // (wasStreamed=true prevents duplicate display)
          // Note: Acknowledgement injection happens during streaming (when first tool_call chunk arrives)
          const narration = combinedContent.trim();
          if (narration) {
            this.emitAssistantMessage(narration, {
              isFinal: false,
              usage,
              contextStats,
              wasStreamed: true,
            });
          }
          this.maybeAckToolCalls(toolCalls, Boolean(narration.length), usage, contextStats);
          const assistantMessage: ConversationMessage = {
            role: 'assistant',
            content: combinedContent,
            toolCalls,
          };
          this.messages.push(assistantMessage);
          await this.resolveToolCalls(toolCalls);
          continue;
        }

        let reply = combinedContent.trim();

        // For reasoning models: if no content but we have reasoning, use reasoning as the response
        // This handles models like anvilwing that put their entire response in reasoning_content
        // The reasoning has already been streamed as 'thought' events showing the AI's thinking
        if (!reply && reasoningContent.trim()) {
          // Use reasoning as the reply - it contains the model's answer
          reply = reasoningContent.trim();
          // Stream the content so it appears as the actual response (not just thoughts)
          this.callbacks.onStreamChunk?.(reply, 'content');
        }

        const { output: ensuredReply, appended } = ensureNextSteps(reply);
        let finalReply = ensuredReply;

        // Reset loop detection when we get a text response (not just tool calls)
        if (finalReply.length >= 10) {
          this.lastToolCallSignature = null;
          this.repeatedToolCallCount = 0;
        }

        // If we appended a required Next steps section, stream just the delta
        if (appended) {
          this.callbacks.onStreamChunk?.(appended, 'content');
        }

        finalReply = await this.maybeAdversarialReview(finalReply);

        // Final message - mark as streamed to avoid double-display in UI
        if (finalReply) {
          this.emitAssistantMessage(finalReply, { isFinal: true, usage, contextStats, wasStreamed: true });
        }
        this.messages.push({ role: 'assistant', content: finalReply });

        // Trigger verification for final responses with verifiable claims
        this.triggerVerificationIfNeeded(finalReply);

        return finalReply;
      } catch (error) {
        // Auto-recover from context overflow errors (with session-level limit)
        const canRecover = contextRecoveryAttempts < MAX_CONTEXT_RECOVERY_ATTEMPTS &&
                          this.totalContextRecoveries < AgentRuntime.MAX_TOTAL_RECOVERIES;
        if (isContextOverflowError(error) && canRecover) {
          contextRecoveryAttempts++;
          this.totalContextRecoveries++;
          const recovered = await this.recoverFromContextOverflow(contextRecoveryAttempts);
          if (recovered) {
            // Notify UI that we're continuing after recovery
            this.callbacks.onContinueAfterRecovery?.();
            // Retry the generation with reduced context
            continue;
          }
        }
        // Auto-retry transient errors — but ONLY if nothing has reached the UI
        // yet. Retrying after a partial stream re-emits from the start and
        // duplicates the content the user already saw.
        if (isTransientError(error) && transientRetryAttempts < MAX_TRANSIENT_RETRIES && !hasStreamedToUser) {
          transientRetryAttempts++;
          const delayMs = getRetryDelay(transientRetryAttempts);
          this.callbacks.onRetrying?.(transientRetryAttempts, MAX_TRANSIENT_RETRIES, error as Error);
          await sleep(delayMs);
          continue;
        }
        // Re-throw if not recoverable or recovery failed
        throw error;
      }
    }
  }

  /**
   * Execute tool calls with optimized concurrency
   *
   * PERF: Uses Promise.all for parallel execution with early result handling.
   * Results are collected in order but execution happens concurrently.
   * For very large batches (>10 tools), uses chunked execution to prevent
   * overwhelming system resources.
   */
  private async resolveToolCalls(toolCalls: ToolCallRequest[]): Promise<void> {
    const numCalls = toolCalls.length;
    const executedEdits: Array<{ call: ToolCallRequest; output: string; fromCache: boolean }> = [];

    // Check for cancellation before starting tool execution
    if (this.cancellationRequested) {
      // Add cancellation message for each pending tool call
      for (const call of toolCalls) {
        this.messages.push({
          role: 'tool',
          name: call.name,
          toolCallId: call.id,
          content: '[Tool execution cancelled by user]',
        });
      }
      return;
    }

    // Fast path: single tool call
    if (numCalls === 1) {
      const call = toolCalls[0]!;

      // Check cache first - prevent duplicate identical tool calls
      const cached = this.getCachedToolResult(call);
      if (cached !== null) {
        // Return cached result with indicator that it was from cache
        this.messages.push({
          role: 'tool',
          name: call.name,
          toolCallId: call.id,
          content: `[Cached result - identical call already executed]\n\n${cached}`,
        });
        return;
      }

      this.callbacks.onToolExecution?.(call.name, true);
      const output = await this.toolRuntime.execute(call);
      this.callbacks.onToolExecution?.(call.name, false);

      // Track consecutive failures
      const failureMsg = this.trackToolResult(output);

      // Cache the result for future identical calls
      this.cacheToolResult(call, output);

      let editNudge: string | null = null;
      if (this.isEditToolCall(call.name)) {
        executedEdits.push({ call, output, fromCache: false });
        editNudge = this.recordEditWrite(call);
      }

      // Add tool result to messages
      const singleNotes = [failureMsg, editNudge].filter(Boolean) as string[];
      const toolContent = singleNotes.length
        ? `${output}\n\n${singleNotes.map((n) => `[SYSTEM: ${n}]`).join('\n\n')}`
        : output;
      this.messages.push({
        role: 'tool',
        name: call.name,
        toolCallId: call.id,
        content: toolContent,
      });
      await this.maybeExplainEdits(executedEdits);
      return;
    }

    // PERF: For reasonable batch sizes, execute all in parallel
    // Check cache for each call and only execute non-cached ones
    if (numCalls <= 10) {
      const cachedResults: Array<{ call: ToolCallRequest; output: string; fromCache: boolean }> = [];
      const toExecute: ToolCallRequest[] = [];

      // Separate cached from non-cached calls
      for (const call of toolCalls) {
        const cached = this.getCachedToolResult(call);
        if (cached !== null) {
          cachedResults.push({ call, output: cached, fromCache: true });
          if (this.isEditToolCall(call.name)) {
            executedEdits.push({ call, output: cached, fromCache: true });
          }
        } else {
          toExecute.push(call);
        }
      }

      // Execute non-cached calls in parallel
      if (toExecute.length > 0) {
        const toolNames = toExecute.map(c => c.name).join(', ');
        this.callbacks.onToolExecution?.(toolNames, true);
        const executed = await Promise.all(
          toExecute.map(async (call) => {
            const output = await this.toolRuntime.execute(call);
            this.cacheToolResult(call, output);
            if (this.isEditToolCall(call.name)) {
              executedEdits.push({ call, output, fromCache: false });
            }
            return { call, output, fromCache: false };
          })
        );
        this.callbacks.onToolExecution?.(toolNames, false);
        cachedResults.push(...executed);
      }

      // Count non-cached same-path writes in deterministic (request) order
      const editNudges = this.collectEditNudges(toolCalls, cachedResults);

      // Add all results to messages in the original order and track failures
      let failureMsg: string | null = null;
      for (const originalCall of toolCalls) {
        const result = cachedResults.find(r => r.call.id === originalCall.id);
        if (result) {
          // Track consecutive failures for non-cached results
          if (!result.fromCache) {
            failureMsg = this.trackToolResult(result.output) ?? failureMsg;
          }
          let content = result.fromCache
            ? `[Cached result - identical call already executed]\n\n${result.output}`
            : result.output;
          // Append failure message to last tool result if detected
          if (failureMsg && originalCall === toolCalls[toolCalls.length - 1]) {
            content = `${content}\n\n[SYSTEM: ${failureMsg}]`;
          }
          const nudge = editNudges.get(originalCall.id);
          if (nudge) {
            content = `${content}\n\n[SYSTEM: ${nudge}]`;
          }
          this.messages.push({
            role: 'tool',
            name: result.call.name,
            toolCallId: result.call.id,
            content,
          });
        }
      }
      await this.maybeExplainEdits(executedEdits);
      return;
    }

    // PERF: For large batches, use chunked parallel execution with caching
    const CHUNK_SIZE = 8;
    const allResults: Array<{ call: ToolCallRequest; output: string; fromCache: boolean }> = [];

    for (let i = 0; i < numCalls; i += CHUNK_SIZE) {
      const chunk = toolCalls.slice(i, i + CHUNK_SIZE);
      const cachedInChunk: Array<{ call: ToolCallRequest; output: string; fromCache: boolean }> = [];
      const toExecuteInChunk: ToolCallRequest[] = [];

      for (const call of chunk) {
        const cached = this.getCachedToolResult(call);
        if (cached !== null) {
          cachedInChunk.push({ call, output: cached, fromCache: true });
          if (this.isEditToolCall(call.name)) {
            executedEdits.push({ call, output: cached, fromCache: true });
          }
        } else {
          toExecuteInChunk.push(call);
        }
      }

      if (toExecuteInChunk.length > 0) {
        const chunkNames = toExecuteInChunk.map(c => c.name).join(', ');
        this.callbacks.onToolExecution?.(chunkNames, true);
        const executed = await Promise.all(
          toExecuteInChunk.map(async (call) => {
            const output = await this.toolRuntime.execute(call);
            this.cacheToolResult(call, output);
            if (this.isEditToolCall(call.name)) {
              executedEdits.push({ call, output, fromCache: false });
            }
            return { call, output, fromCache: false };
          })
        );
        this.callbacks.onToolExecution?.(chunkNames, false);
        cachedInChunk.push(...executed);
      }

      allResults.push(...cachedInChunk);
    }

    // Count non-cached same-path writes in deterministic (request) order
    const editNudges = this.collectEditNudges(toolCalls, allResults);

    // Add results to messages in original order and track failures
    let failureMsg: string | null = null;
    for (const originalCall of toolCalls) {
      const result = allResults.find(r => r.call.id === originalCall.id);
      if (result) {
        // Track consecutive failures for non-cached results
        if (!result.fromCache) {
          failureMsg = this.trackToolResult(result.output) ?? failureMsg;
        }
        let content = result.fromCache
          ? `[Cached result - identical call already executed]\n\n${result.output}`
          : result.output;
        // Append failure message to last tool result if detected
        if (failureMsg && originalCall === toolCalls[toolCalls.length - 1]) {
          content = `${content}\n\n[SYSTEM: ${failureMsg}]`;
        }
        const nudge = editNudges.get(originalCall.id);
        if (nudge) {
          content = `${content}\n\n[SYSTEM: ${nudge}]`;
        }
        this.messages.push({
          role: 'tool',
          name: result.call.name,
          toolCallId: result.call.id,
          content,
        });
      }
    }
    await this.maybeExplainEdits(executedEdits);
  }

  /**
   * Count non-cached same-path writes across a resolved batch in request order and
   * return callId -> nudge for any path that crossed the soft threshold.
   */
  private collectEditNudges(
    toolCalls: ToolCallRequest[],
    results: Array<{ call: ToolCallRequest; output: string; fromCache: boolean }>
  ): Map<string, string> {
    const nudges = new Map<string, string>();
    for (const originalCall of toolCalls) {
      const r = results.find((x) => x.call.id === originalCall.id);
      if (r && !r.fromCache && this.isEditToolCall(r.call.name)) {
        const nudge = this.recordEditWrite(r.call);
        if (nudge) {
          nudges.set(r.call.id, nudge);
        }
      }
    }
    return nudges;
  }

  private truncateEditOutput(output: string): string {
    if (!output) {
      return '[no tool output available]';
    }
    const limit = AgentRuntime.EDIT_CONTEXT_CHAR_LIMIT;
    if (output.length <= limit) {
      return output;
    }

    const head = output.slice(0, Math.floor(limit * 0.7));
    const tail = output.slice(-Math.floor(limit * 0.2));
    const omitted = output.length - head.length - tail.length;
    return `${head}\n... [truncated ${omitted} chars] ...\n${tail}`;
  }

  private buildEditExplanationPrompt(toolName: string, files: string[], toolOutput: string): ConversationMessage[] {
    const fileNames = files.map(f => f.split('/').pop()).join(', ');
    const userContent = [
      `Summarize this ${toolName} operation in 1-2 sentences for the UI status line.`,
      `Files: ${fileNames || 'unknown'}`,
      '',
      'Output:',
      toolOutput.slice(0, 500), // Limit context to reduce hallucination
    ].join('\n');

    return [
      {
        role: 'system',
        content: 'You write brief UI status messages. Reply with ONLY a 1-2 sentence summary. No analysis, no reasoning, no explanations of your process.',
      },
      { role: 'user', content: userContent },
      // Prefill assistant response to guide format
      { role: 'assistant', content: '' },
    ];
  }

  /**
   * Extract clean explanation from model output that may contain reasoning.
   * Reasoning models like anvilwing output chain-of-thought which we need to filter.
   */
  private extractCleanExplanation(rawOutput: string): string {
    if (!rawOutput) return '';

    // Check for common reasoning patterns and extract final output
    const patterns = [
      // "Final explanation:" or "Final concise explanation:" patterns
      /(?:final\s+(?:concise\s+)?explanation\s*:?\s*["']?)([^"'\n]+(?:["']|$))/i,
      // Quoted final output
      /"([^"]{20,})"(?:\s*\([^)]+\))?$/,
      // Last paragraph after deliberation markers
      /(?:draft|summary|output|result)\s*:?\s*\n?\s*["']?([^"'\n]+)/i,
    ];

    for (const pattern of patterns) {
      const match = rawOutput.match(pattern);
      if (match?.[1]) {
        // Clean up the extracted text
        return match[1].replace(/^["']|["']$/g, '').trim();
      }
    }

    // Check if the output looks like reasoning (contains deliberation markers)
    const reasoningMarkers = [
      /^first,?\s+(the user|i need|let me|looking at)/i,
      /^(from this|based on|analyzing|the tool output shows)/i,
      /^(intent:|impact:|user-visible changes:)/im,
      /^(now,?\s+i (?:need|should|will)|let me (?:craft|think|analyze))/i,
      /\b(draft:|final (?:draft|explanation):)/i,
    ];

    const hasReasoning = reasoningMarkers.some(marker => marker.test(rawOutput));

    if (hasReasoning) {
      // Try to extract the last meaningful sentence/paragraph
      const lines = rawOutput.split('\n').filter(l => l.trim());
      // Look for the last line that looks like a summary (not a reasoning line)
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        // Skip lines that look like reasoning
        if (reasoningMarkers.some(m => m.test(line))) continue;
        // Skip very short lines or lines that are just labels
        if (line.length < 30 || /^[\w\s]+:$/.test(line)) continue;
        // Found a good candidate
        return line.replace(/^["']|["']$/g, '').replace(/\([^)]+\)$/, '').trim();
      }

      // Fallback: take last 200 chars and try to find a sentence
      const tail = rawOutput.slice(-300);
      const lastSentence = tail.match(/[A-Z][^.!?]*[.!?](?:\s|$)/g);
      if (lastSentence?.length) {
        return lastSentence[lastSentence.length - 1].trim();
      }
    }

    // No reasoning detected, return as-is but truncate if too long
    if (rawOutput.length > 500) {
      // Find a sentence break near the end
      const truncated = rawOutput.slice(0, 500);
      const lastPeriod = truncated.lastIndexOf('.');
      if (lastPeriod > 200) {
        return truncated.slice(0, lastPeriod + 1);
      }
    }

    return rawOutput.trim();
  }

  private async maybeExplainEdits(results: Array<{ call: ToolCallRequest; output: string; fromCache: boolean }>): Promise<void> {
    if (!this.explainEdits || results.length === 0 || this.cancellationRequested) {
      return;
    }

    for (const result of results) {
      if (result.fromCache || !this.isEditToolCall(result.call.name)) {
        continue;
      }

      const files = this.getEditedFiles([result.call]);
      const truncatedOutput = this.truncateEditOutput(result.output);
      const prompt = this.buildEditExplanationPrompt(result.call.name, files, truncatedOutput);

      try {
        const response = await this.provider.generate(prompt, []);
        if (response.type !== 'message') {
          continue;
        }
        // Extract clean explanation, filtering out any reasoning/deliberation
        const rawExplanation = response.content?.trim() ?? '';
        const explanation = this.extractCleanExplanation(rawExplanation);
        if (explanation) {
          this.callbacks.onEditExplanation?.({
            explanation,
            files,
            toolName: result.call.name,
            toolCallId: result.call.id,
          });
        }
      } catch (error) {
        logDebug(`[agent] Failed to generate edit explanation: ${safeErrorMessage(error)}`);
      }
    }
  }

  private get providerTools(): ProviderToolDefinition[] {
    return this.toolRuntime.listProviderTools();
  }

  /**
   * Whether to suppress tool narration in the content field.
   * Previously suppressed for OpenAI but now we show all thinking/narration.
   */
  private shouldSuppressToolNarration(): boolean {
    return false; // Always show thinking/narration
  }

  private emitAssistantMessage(content: string, metadata: AssistantMessageMetadata): void {
    if (!content || !content.trim()) {
      return;
    }
    const elapsedMs = this.activeRun ? Date.now() - this.activeRun.startedAt : undefined;
    const payload: AssistantMessageMetadata = { ...metadata };
    if (typeof elapsedMs === 'number') {
      payload.elapsedMs = elapsedMs;
    }
    this.callbacks.onAssistantMessage?.(content, payload);
  }

  /**
   * Trigger verification for a final response if callback is registered
   * and response contains verifiable claims (implementation, build success, etc.)
   */
  /**
   * Always-on adversarial review of a finished answer (annotate-only). When
   * the adversarial flag is on and real work happened this turn, a critic
   * pass tries to refute the draft; findings are appended as a visible
   * caveat. Non-destructive (peeks tool history without draining the cursor
   * drainToolExecutions relies on) and fail-open — a critic error returns
   * the answer unchanged.
   */
  private async maybeAdversarialReview(finalReply: string): Promise<string> {
    if (!isAdversarialEnabled() || this.cancellationRequested || !finalReply.trim()) {
      return finalReply;
    }
    try {
      if (typeof this.toolRuntime.getToolHistory !== 'function') return finalReply;
      const recent = this.toolRuntime.getToolHistory().slice(this.toolHistoryCursor);
      if (recent.length === 0) return finalReply; // no real work this turn — skip
      const actions = recent.map((e) => `${e.toolName}${e.success === false ? ' (failed)' : ''}`).join(', ');
      let request = '';
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const m = this.messages[i];
        if (m && m.role === 'user') {
          request = typeof m.content === 'string' ? m.content : '';
          break;
        }
      }
      const review = await reviewDraft(this.provider, { request, actions, draft: finalReply });
      if (review.ok || !review.findings) return finalReply;
      // The critic refuted the draft. Signal the shell so it can re-run the
      // full tool-executing loop to actually FIX the findings (bounded), rather
      // than this caveat being the end of it. Still append the visible caveat.
      this.callbacks.onAdversarialFindings?.(review.findings);
      return `${finalReply}\n\n---\n⚠ Adversarial review:\n${review.findings}`;
    } catch {
      return finalReply;
    }
  }

  private triggerVerificationIfNeeded(response: string): void {
    if (!this.callbacks.onVerificationNeeded) {
      return;
    }

    // Only trigger verification for responses that likely contain verifiable claims
    // These patterns indicate the model is claiming to have completed work
    const verifiablePatterns = [
      /\b(implemented|created|wrote|added|fixed|built|deployed|completed|refactored)\b/i,
      /\b(tests?\s+(are\s+)?pass(ing)?|build\s+succeed)/i,
      /\b(file|function|class|module|component)\s+(has been|is now|was)\s+(created|updated|modified)/i,
      /✅|✓|\[done\]|\[complete\]/i,
      /\bcommit(ted)?\b.*\b(success|done)\b/i,
    ];

    const hasVerifiableClaims = verifiablePatterns.some(pattern => pattern.test(response));
    if (!hasVerifiableClaims) {
      return;
    }

    // Build conversation history for context (last 5 user/assistant exchanges)
    const conversationHistory: string[] = [];
    const recentMessages = this.messages.slice(-10);
    for (const msg of recentMessages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (content.length > 0) {
          conversationHistory.push(`${msg.role}: ${content.slice(0, 500)}`);
        }
      }
    }

    // Trigger verification callback
    this.callbacks.onVerificationNeeded(response, {
      workingDirectory: this.workingDirectory,
      conversationHistory,
      provider: this.providerId,
      model: this.modelId,
    });
  }

  /**
   * Extract a "command hash" from tool arguments for behavioral loop detection.
   * For execute_bash, this is the actual command. For other tools, key identifying args.
   */
  private extractCmdHash(name: string, args: Record<string, unknown>): string {
    // For bash/execute commands, extract the command itself
    if (name === 'execute_bash' || name === 'Bash') {
      const cmd = args['command'] as string | undefined;
      if (cmd) {
        // Normalize: trim, take first 100 chars, remove variable parts like timestamps
        return cmd.trim().slice(0, 100).replace(/\d{10,}/g, 'N');
      }
    }
    // For file operations, use the path
    if (name === 'read_file' || name === 'Read' || name === 'read_files') {
      const path = args['path'] || args['file_path'] || args['paths'];
      if (path) return `path:${JSON.stringify(path).slice(0, 100)}`;
    }
    if (name === 'list_files' || name === 'Glob') {
      const path = args['path'] || args['pattern'];
      if (path) return `path:${JSON.stringify(path).slice(0, 100)}`;
    }
    // For search, use the query/pattern
    if (name === 'Grep' || name === 'grep' || name === 'search') {
      const pattern = args['pattern'] || args['query'];
      if (pattern) return `search:${String(pattern).slice(0, 100)}`;
    }
    // Default: use first significant arg value
    const firstArg = Object.values(args)[0];
    if (firstArg) {
      return String(firstArg).slice(0, 100);
    }
    return 'no-args';
  }

  /**
   * Check for behavioral loops - model calling the same tool with similar args repeatedly.
   * Returns an error message if a loop is detected, null otherwise.
   *
   * FUNDAMENTAL PREVENTION: Cached calls are excluded from loop detection since they
   * don't actually execute (the cache provides the result). This means:
   * - First call: executes and caches result
   * - Second identical call: returns cached result, NOT counted toward loop
   * - Only genuinely NEW (non-cached) repetitive calls trigger loop detection
   *
   * Direct execution tools (bash/edit) are also exempt to avoid short-circuiting
   * legitimate repeated user commands.
   *
   * This catches patterns like:
   * - "git status -sb" called 3 times with DIFFERENT outputs (cache miss each time)
   * - Repeated file reads where file content changed
   * - Repeated searches with same pattern but new results
   */
  private checkBehavioralLoop(toolCalls: ToolCallRequest[]): string | null {
    // Hard ceiling: stop the episode if the model keeps rewriting one file whole.
    // Edits are exempt from the loop guard below, so this is their only mechanical bound.
    for (const call of toolCalls) {
      if (!this.isEditToolCall(call.name)) {
        continue;
      }
      const key = this.editPathKey(call);
      if (key && (this.editPathCounts.get(key) ?? 0) >= AgentRuntime.MAX_SAME_FILE_REWRITES) {
        this.editPathCounts.set(key, 0); // prevent immediate re-trigger
        const rel = path.relative(this.workingDirectory, key) || key;
        return `Repeated whole-file rewrites detected: "${rel}" was rewritten ${AgentRuntime.MAX_SAME_FILE_REWRITES} times this turn. Stopping to avoid wasting turns — make a single targeted edit of the remaining change, or report what is blocking it.`;
      }
    }

    // Skip loop detection for direct execution tools (bash/edit) to avoid false positives
    const loopEligibleCalls = toolCalls.filter(call => !this.shouldSkipLoopDetection(call));

    if (loopEligibleCalls.length === 0) {
      return null;
    }

    // Filter out calls that will be served from cache - these don't count toward loops
    // since they're handled fundamentally by the caching mechanism
    const nonCachedCalls = loopEligibleCalls.filter(call => this.getCachedToolResult(call) === null);

    // If all calls are cached, no loop detection needed
    if (nonCachedCalls.length === 0) {
      return null;
    }

    // Count existing occurrences in recent history
    const existingCounts = new Map<string, number>();
    for (const { name, cmdHash } of this.recentToolCalls) {
      const key = `${name}:${cmdHash}`;
      existingCounts.set(key, (existingCounts.get(key) ?? 0) + 1);
    }

    // Check if ANY incoming NON-CACHED call would exceed threshold
    for (const call of nonCachedCalls) {
      const cmdHash = this.extractCmdHash(call.name, call.arguments ?? {});
      const key = `${call.name}:${cmdHash}`;
      const currentCount = existingCounts.get(key) ?? 0;
      // If adding this call would reach or exceed threshold, block immediately
      if (currentCount + 1 >= AgentRuntime.BEHAVIORAL_LOOP_THRESHOLD) {
        // Reset history to prevent immediate re-trigger
        this.recentToolCalls = [];
        return `Behavioral loop detected: "${call.name}" called ${currentCount + 1} times with similar arguments. The task appears stuck. Please try a different approach or provide more specific instructions.`;
      }
    }

    // Track only non-cached tool calls (cached ones are handled by caching)
    for (const call of nonCachedCalls) {
      const cmdHash = this.extractCmdHash(call.name, call.arguments ?? {});
      this.recentToolCalls.push({ name: call.name, cmdHash });
    }

    // Keep only recent history
    while (this.recentToolCalls.length > AgentRuntime.TOOL_HISTORY_SIZE) {
      this.recentToolCalls.shift();
    }

    return null;
  }

  /**
   * Provide an acknowledgement before the first tool call when the model
   * hasn't narrated its plan. This keeps the UI responsive and lets the
   * user know work is happening even before tool output arrives.
   */
  private maybeAckToolCalls(
    toolCalls: ToolCallRequest[],
    hasModelNarration: boolean,
    usage: ProviderUsage | null,
    contextStats: Record<string, unknown> | null
  ): void {
    if (!toolCalls?.length) {
      return;
    }
    const acknowledgement = this.callbacks.onBeforeFirstToolCall?.(
      toolCalls.map((call) => call.name),
      hasModelNarration
    );
    if (acknowledgement && acknowledgement.trim()) {
      this.emitAssistantMessage(acknowledgement, {
        isFinal: false,
        usage,
        contextStats,
      });
    }
  }

  /**
   * Reset behavioral loop tracking (called when user provides new input or task completes)
   */
  private resetBehavioralLoopTracking(): void {
    this.recentToolCalls = [];
    this.lastToolCallSignature = null;
    this.repeatedToolCallCount = 0;
    this.consecutiveFailures = 0;
    this.editPathCounts.clear();
    this.nudgedEditPaths.clear();
    // Note: we DON'T clear toolResultCache here for cacheable tools; stateful tools bypass caching
  }

  /**
   * Create a stable cache key for a tool call based on name and arguments
   */
  private getToolCacheKey(call: ToolCallRequest): string {
    const args = call.arguments ?? {};
    // Sort keys for consistent ordering
    const sortedArgs = Object.keys(args).sort().reduce((acc, key) => {
      acc[key] = args[key];
      return acc;
    }, {} as Record<string, unknown>);
    return `${call.name}:${JSON.stringify(sortedArgs)}`;
  }

  /**
   * Only cache tools that are safe to reuse; stateful commands must always execute.
   */
  private isCacheableTool(call: ToolCallRequest): boolean {
    const nameLower = call.name.toLowerCase();
    return !AgentRuntime.NON_CACHEABLE_TOOL_NAMES.has(nameLower);
  }

  /**
   * Direct execution tools should not trigger behavioral loop short-circuiting.
   */
  private shouldSkipLoopDetection(call: ToolCallRequest): boolean {
    const nameLower = call.name.toLowerCase();
    return AgentRuntime.LOOP_EXEMPT_TOOL_NAMES.has(nameLower);
  }

  /**
   * Check if a tool output indicates failure
   */
  private isToolOutputFailure(output: string): boolean {
    const failurePatterns = [
      /\bfailed\b/i,
      /\berror[:\s]/i,
      /\bexception\b/i,
      /\bcommand not found\b/i,
      /\bno such file\b/i,
      /\bpermission denied\b/i,
      /\bexit code [1-9]/i,
      /\btimeout\b/i,
      /\bcannot\b.*\bfind\b/i,
      /\bunable to\b/i,
      /\bsyntax error\b/i,
    ];
    return failurePatterns.some(pattern => pattern.test(output));
  }

  /**
   * Track tool execution result and check for consecutive failures.
   * Returns error message if too many consecutive failures, null otherwise.
   */
  private trackToolResult(output: string): string | null {
    if (this.isToolOutputFailure(output)) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= AgentRuntime.MAX_CONSECUTIVE_FAILURES) {
        // Functional reflection (obstacles-as-signal, baked into the loop, not
        // just the prompt): N failures on one path usually means the APPROACH is
        // wrong, not that it needs another attempt — so steer to a different one
        // rather than letting the model grind the same call.
        const msg = `${this.consecutiveFailures} consecutive failures on this path — treat that as signal, not noise. Repeating the same call won't help; the approach itself is likely wrong. Re-read the FIRST error for the underlying constraint, then switch to a genuinely different approach (different tool, different file, or a smaller step).`;
        this.consecutiveFailures = 0; // Reset to allow retry with new approach
        return msg;
      }
    } else {
      // Successful execution resets the counter
      this.consecutiveFailures = 0;
    }
    return null;
  }

  /**
   * Get cached result for a tool call, or null if not cached
   */
  private getCachedToolResult(call: ToolCallRequest): string | null {
    if (!this.isCacheableTool(call)) {
      return null;
    }
    const key = this.getToolCacheKey(call);
    return this.toolResultCache.get(key) ?? null;
  }

  /**
   * Cache a tool result for future identical calls
   */
  private cacheToolResult(call: ToolCallRequest, result: string): void {
    if (!this.isCacheableTool(call)) {
      return;
    }
    // Never cache a failure — caching an error string would replay it for the
    // rest of the session even after the underlying condition is fixed.
    if (this.isToolOutputFailure(result)) {
      return;
    }
    const key = this.getToolCacheKey(call);

    // Evict oldest entries if cache is full
    if (this.toolResultCache.size >= AgentRuntime.TOOL_CACHE_MAX_SIZE) {
      const firstKey = this.toolResultCache.keys().next().value;
      if (firstKey) {
        this.toolResultCache.delete(firstKey);
      }
    }

    this.toolResultCache.set(key, result);
  }

  /**
   * Drain the list of tools executed during the most recent send() call.
   * Used by higher-level orchestrators to reason about progress.
   */
  drainToolExecutions(): ToolExecutionRecord[] {
    if (typeof this.toolRuntime.getToolHistory !== 'function') {
      return [];
    }

    const history = this.toolRuntime.getToolHistory();
    const newEntries = history.slice(this.toolHistoryCursor);
    this.toolHistoryCursor = history.length;

    return newEntries.map((entry) => ({
      name: entry.toolName,
      success: entry.success ?? true,
      hasOutput: entry.hasOutput ?? true,
    }));
  }

  getHistory(): ConversationMessage[] {
    return this.messages.map(cloneMessage);
  }

  loadHistory(history: ConversationMessage[]): void {
    // Swapping the conversation invalidates per-session caches: a cached tool
    // result or loop fingerprint from the old history must not bleed into the
    // new one.
    this.toolResultCache.clear();
    this.recentToolCalls = [];
    this.messages.length = 0;
    if (history.length === 0) {
      if (this.baseSystemPrompt) {
        this.messages.push({ role: 'system', content: this.baseSystemPrompt });
      }
      return;
    }
    for (const message of history) {
      this.messages.push(cloneMessage(message));
    }
  }

  clearHistory(): void {
    this.toolResultCache.clear();
    this.recentToolCalls = [];
    this.messages.length = 0;
    if (this.baseSystemPrompt) {
      this.messages.push({ role: 'system', content: this.baseSystemPrompt });
    }
  }

  /**
   * Prune messages if approaching context limit
   *
   * This runs BEFORE each generation to ensure we stay within budget.
   * If LLM summarization is available, it will create intelligent summaries
   * instead of just removing old messages.
   */
  private async pruneMessagesIfNeeded(): Promise<void> {
    if (!this.contextManager) {
      return;
    }

    if (this.contextManager.isApproachingLimit(this.messages)) {
      // Token count before compaction, so we can report how much was freed.
      const beforeTokens = this.contextManager.getStats(this.messages).totalTokens;
      // Try LLM-based summarization first (preserves context better)
      const result = await this.contextManager.pruneMessagesWithSummary(this.messages);

      if (result.removed > 0) {
        // Replace messages with pruned/summarized version
        this.messages.length = 0;
        this.messages.push(...result.pruned);

        // Notify callback with enriched stats
        const stats = this.contextManager.getStats(this.messages);
        const enrichedStats = {
          ...stats,
          summarized: result.summarized,
          method: result.summarized ? 'llm-summary' : 'simple-prune',
          freedTokens: Math.max(0, beforeTokens - stats.totalTokens),
        };
        this.callbacks.onContextPruned?.(result.removed, enrichedStats);

        if (process.env['DEBUG_CONTEXT']) {
          logDebug(
            `[Context Manager] ${result.summarized ? 'Summarized' : 'Pruned'} ${result.removed} messages. ` +
            `Tokens: ${stats.totalTokens} (${stats.percentage}%)`
          );
        }
      }
    }
  }

  /**
   * Force a compaction NOW (manual /compact), regardless of the token budget.
   * Reuses the same summarize-and-notify path as the automatic compactor, so
   * the goal + plan pins and the context.compacted UI note all apply. Lets a
   * user proactively reclaim context on a long task instead of waiting for the
   * automatic trigger. Returns what was freed.
   */
  async compactNow(): Promise<{ removed: number; summarized: boolean; freedTokens: number }> {
    if (!this.contextManager) return { removed: 0, summarized: false, freedTokens: 0 };
    const beforeTokens = this.contextManager.getStats(this.messages).totalTokens;
    const result = await this.contextManager.pruneMessagesWithSummary(this.messages, { force: true });
    let freedTokens = 0;
    if (result.removed > 0) {
      this.messages.length = 0;
      this.messages.push(...result.pruned);
      const stats = this.contextManager.getStats(this.messages);
      freedTokens = Math.max(0, beforeTokens - (stats.totalTokens as number));
      this.callbacks.onContextPruned?.(result.removed, {
        ...stats,
        summarized: result.summarized,
        method: result.summarized ? 'llm-summary' : 'simple-prune',
        freedTokens,
      });
    }
    return { removed: result.removed, summarized: result.summarized, freedTokens };
  }

  /**
   * Get current context statistics
   */
  private getContextStats(): Record<string, unknown> | null {
    if (!this.contextManager) {
      return null;
    }
    return this.contextManager.getStats(this.messages);
  }

  /**
   * Get context manager instance
   */
  getContextManager(): ContextManager | null {
    return this.contextManager;
  }

  /**
   * Fetch model info from the provider API.
   * Returns context window and token limits from the real API.
   * Results are cached for the lifetime of this agent instance.
   */
  async fetchModelInfo(): Promise<ProviderModelInfo | null> {
    if (this.modelInfoFetched) {
      return this.modelInfo;
    }

    this.modelInfoFetched = true;

    if (typeof this.provider.getModelInfo === 'function') {
      try {
        this.modelInfo = await this.provider.getModelInfo();
      } catch {
        // Ignore errors - fall back to null
        this.modelInfo = null;
      }
    }

    return this.modelInfo;
  }

  /**
   * Get cached model info (must call fetchModelInfo first)
   */
  getModelInfo(): ProviderModelInfo | null {
    return this.modelInfo;
  }

  /**
   * Get the context window size from the provider API.
   * Returns null if the provider doesn't support this or the API call fails.
   */
  async getContextWindowFromProvider(): Promise<number | null> {
    const info = await this.fetchModelInfo();
    return info?.contextWindow ?? null;
  }

  /**
   * Auto-recover from context overflow errors by aggressively pruning messages.
   *
   * This is called when an API call fails due to context length exceeding limits.
   * It performs increasingly aggressive pruning on each attempt:
   * - Attempt 1: Remove 30% of oldest messages + truncate tool outputs to 5k
   * - Attempt 2: Remove 50% of oldest messages + truncate tool outputs to 2k
   * - Attempt 3: Remove 70% of oldest messages + truncate tool outputs to 500 chars
   *
   * @returns true if recovery was successful (context was reduced)
   */
  private async recoverFromContextOverflow(attempt: number): Promise<boolean> {
    // Calculate reduction percentage based on attempt
    const reductionPercentages = [0.3, 0.5, 0.7];
    const reductionPercent = reductionPercentages[attempt - 1] ?? 0.7;

    // Increasingly aggressive tool output truncation limits
    const toolOutputLimits = [5000, 2000, 500];
    const toolOutputLimit = toolOutputLimits[attempt - 1] ?? 500;

    // Notify UI about recovery attempt
    const message = `Context overflow detected. Auto-squishing context (attempt ${attempt}/${MAX_CONTEXT_RECOVERY_ATTEMPTS}, removing ${Math.round(reductionPercent * 100)}% of history)...`;
    this.callbacks.onContextRecovery?.(attempt, MAX_CONTEXT_RECOVERY_ATTEMPTS, message);
    this.callbacks.onContextSquishing?.(message);

    // Separate system messages from conversation
    const systemMessages: ConversationMessage[] = [];
    const conversationMessages: ConversationMessage[] = [];

    for (const msg of this.messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg);
      } else {
        conversationMessages.push(msg);
      }
    }

    // Calculate how many messages to remove (target)
    const targetRemoveCount = Math.floor(conversationMessages.length * reductionPercent);
    if (targetRemoveCount === 0 || conversationMessages.length <= 2) {
      // Nothing to remove or too few messages - can't recover
      return false;
    }

    // Group messages into conversation "turns" to maintain tool call/result pairing
    // A turn is: [user] or [assistant + tool results] or [assistant without tools]
    const turns: ConversationMessage[][] = [];
    let currentTurn: ConversationMessage[] = [];

    for (let i = 0; i < conversationMessages.length; i++) {
      const msg = conversationMessages[i]!;

      if (msg.role === 'user') {
        // User messages start a new turn
        if (currentTurn.length > 0) {
          turns.push(currentTurn);
        }
        currentTurn = [msg];
      } else if (msg.role === 'assistant') {
        // Assistant messages start a new turn (flush previous)
        if (currentTurn.length > 0) {
          turns.push(currentTurn);
        }
        currentTurn = [msg];
      } else if (msg.role === 'tool') {
        // Tool results belong to the current assistant turn
        currentTurn.push(msg);
      }
    }
    // Don't forget the last turn
    if (currentTurn.length > 0) {
      turns.push(currentTurn);
    }

    // Calculate how many turns to remove
    const targetTurnsToRemove = Math.floor(turns.length * reductionPercent);
    if (targetTurnsToRemove === 0 || turns.length <= 2) {
      return false;
    }

    // Keep recent turns (remove from the beginning)
    const keepTurns = turns.slice(targetTurnsToRemove);

    // IMPORTANT: Ensure we don't start with orphaned tool messages
    // The first kept turn must NOT be a tool-only turn
    let startIndex = 0;
    while (startIndex < keepTurns.length) {
      const firstTurn = keepTurns[startIndex];
      if (firstTurn && firstTurn.length > 0) {
        const firstMsg = firstTurn[0];
        // If first message is a tool result, skip this turn
        if (firstMsg?.role === 'tool') {
          startIndex++;
          continue;
        }
        // If first message is an assistant with tool calls but we're missing results,
        // check if all tool results are present
        if (firstMsg?.role === 'assistant' && firstMsg.toolCalls && firstMsg.toolCalls.length > 0) {
          // PERF: Pre-compute tool call IDs as array, use direct Set lookup
          const toolCallIds = firstMsg.toolCalls.map(tc => tc.id);
          const presentToolResultIds = new Set(
            firstTurn.filter(m => m.role === 'tool').map(m => (m as { toolCallId?: string }).toolCallId)
          );
          // PERF: Direct has() calls with early exit instead of spread + every()
          let allPresent = true;
          for (const id of toolCallIds) {
            if (!presentToolResultIds.has(id)) {
              allPresent = false;
              break;
            }
          }
          if (allPresent) {
            break;
          }
          // Otherwise skip this turn
          startIndex++;
          continue;
        }
      }
      break;
    }

    const validTurns = keepTurns.slice(startIndex);
    if (validTurns.length === 0) {
      return false;
    }

    // Flatten valid turns back to messages
    const keepMessages = validTurns.flat();
    const actualRemoveCount = conversationMessages.length - keepMessages.length;

    // Aggressively truncate tool outputs in remaining messages
    let truncatedCount = 0;
    for (const msg of keepMessages) {
      if (msg.role === 'tool' && msg.content) {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        if (content.length > toolOutputLimit) {
          // Truncate with smart ending
          const truncated = content.slice(0, toolOutputLimit);
          const lastNewline = truncated.lastIndexOf('\n');
          const cutPoint = lastNewline > toolOutputLimit * 0.7 ? lastNewline : toolOutputLimit;
          msg.content = `${truncated.slice(0, cutPoint)  }\n\n[... truncated ${content.length - cutPoint} chars for context recovery ...]`;
          truncatedCount++;
        }
      }
      // Also truncate very long assistant messages
      if (msg.role === 'assistant' && msg.content && msg.content.length > toolOutputLimit * 2) {
        const content = msg.content;
        const limit = toolOutputLimit * 2;
        const truncated = content.slice(0, limit);
        const lastNewline = truncated.lastIndexOf('\n');
        const cutPoint = lastNewline > limit * 0.8 ? lastNewline : limit;
        msg.content = `${truncated.slice(0, cutPoint)  }\n\n[... truncated for context recovery ...]`;
        truncatedCount++;
      }
    }

    // Also truncate system messages if they're huge (except first system prompt)
    for (let i = 1; i < systemMessages.length; i++) {
      const sys = systemMessages[i];
      if (sys && sys.content && sys.content.length > toolOutputLimit) {
        sys.content = `${sys.content.slice(0, toolOutputLimit)  }\n[... truncated ...]`;
        truncatedCount++;
      }
    }

    // Rebuild message array
    this.messages.length = 0;

    // Add system messages
    for (const sys of systemMessages) {
      this.messages.push(sys);
    }

    // Add summary notice
    this.messages.push({
      role: 'system',
      content: `[Auto Context Recovery] Removed ${actualRemoveCount} messages and truncated ${truncatedCount} large outputs to stay within token limits.`,
    });

    // Add remaining conversation (maintaining tool call/result pairing)
    for (const msg of keepMessages) {
      this.messages.push(msg);
    }

    // Notify about pruning
    const stats = this.contextManager?.getStats(this.messages) ?? {};
    this.callbacks.onContextPruned?.(actualRemoveCount, {
      ...stats,
      method: 'emergency-recovery',
      attempt,
      removedPercent: reductionPercent * 100,
      turnsRemoved: targetTurnsToRemove + startIndex,
      truncatedOutputs: truncatedCount,
      toolOutputLimit,
    });

    // Check if we're still over limit after all reductions
    const newStats = this.contextManager?.getStats(this.messages);
    if (newStats && newStats.percentage > 100) {
      // Still over limit - do one more aggressive pass
      // Truncate ALL tool outputs to absolute minimum
      const minLimit = 200;
      for (const msg of this.messages) {
        if (msg.role === 'tool' && msg.content) {
          const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          if (content.length > minLimit) {
            msg.content = `${content.slice(0, minLimit)  }\n[... severely truncated ...]`;
          }
        }
      }
    }

    return true;
  }
}

function cloneMessage(message: ConversationMessage): ConversationMessage {
  switch (message.role) {
    case 'assistant': {
      const clone: ConversationMessage = {
        role: 'assistant',
        content: message.content,
      };
      if (message.toolCalls) {
        clone.toolCalls = message.toolCalls.map(cloneToolCall);
      }
      return clone;
    }
    case 'tool':
      return {
        role: 'tool',
        name: message.name,
        content: message.content,
        toolCallId: message.toolCallId,
      };
    case 'system':
      return { role: 'system', content: message.content };
    case 'user':
    default:
      return { role: 'user', content: message.content };
  }
}

function cloneToolCall(call: ToolCallRequest): ToolCallRequest {
  return {
    id: call.id,
    name: call.name,
    arguments: { ...(call.arguments ?? {}) },
  };
}
