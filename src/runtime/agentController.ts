import { LOCKED_MODEL, LOCKED_PROVIDER, type ProfileName } from '../config.js';
import type { AgentSession, ModelSelection } from './agentSession.js';
import type { UniversalRuntime } from './universal.js';
import { createNodeRuntime, type NodeRuntimeOptions } from './node.js';
import type { CapabilityModule } from './agentHost.js';
import type { AgentCallbacks, AssistantMessageMetadata, EditExplanationPayload } from '../core/agent.js';
import type { ToolRuntimeObserver, ToolSuite } from '../core/toolRuntime.js';
import type { ConversationMessage, ProviderUsage, ProviderId } from '../core/types.js';
import type {
  AgentEventUnion,
  CapabilityManifest,
  IAgentController,
  ModelConfig,
  ToolCapability,
} from '../contracts/v1/agent.js';
import { AGENT_CONTRACT_VERSION } from '../contracts/v1/agent.js';
import { logDebug } from '../utils/debugLogger.js';
import { isFallbackEligibleError, getFallbackReason } from '../providers/resilientProvider.js';
import { getConfiguredProviders, getLatestModelForProvider } from '../core/modelDiscovery.js';
import { hitlEvents } from '../core/hitl.js';

interface EventSinkRef {
  current: EventStream<AgentEventUnion> | null;
}

class EventStream<T> implements AsyncIterableIterator<T> {
  private readonly queue: T[] = [];
  private pending: { resolve: (value: IteratorResult<T>) => void; reject: (error: unknown) => void } | null = null;
  private closed = false;
  private failure: Error | null = null;

  push(value: T): void {
    if (this.closed || this.failure) {
      return;
    }
    if (this.pending) {
      this.pending.resolve({ value, done: false });
      this.pending = null;
      return;
    }
    this.queue.push(value);
  }

  close(): void {
    if (this.closed || this.failure) {
      return;
    }
    this.closed = true;
    if (this.pending) {
      this.pending.resolve({ value: undefined as unknown as T, done: true });
      this.pending = null;
    }
  }

  fail(error: Error): void {
    if (this.closed || this.failure) {
      return;
    }
    this.failure = error;
    this.closed = true; // Mark as closed to prevent new pending promises
    if (this.pending) {
      this.pending.reject(error);
      this.pending = null;
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.queue.length) {
      const value = this.queue.shift()!;
      return Promise.resolve({ value, done: false });
    }
    if (this.failure) {
      const error = this.failure;
      this.failure = null;
      return Promise.reject(error);
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  return(): Promise<IteratorResult<T>> {
    this.close();
    return Promise.resolve({ value: undefined as unknown as T, done: true });
  }

  throw(error: unknown): Promise<IteratorResult<T>> {
    const err = error instanceof Error ? error : new Error(String(error));
    this.fail(err);
    return Promise.reject(err);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

function mergeToolObservers(
  primary: ToolRuntimeObserver,
  secondary?: ToolRuntimeObserver
): ToolRuntimeObserver {
  if (!secondary) {
    return primary;
  }
  return {
    onToolStart(call) {
      primary.onToolStart?.(call);
      secondary.onToolStart?.(call);
    },
    onToolResult(call, output) {
      primary.onToolResult?.(call, output);
      secondary.onToolResult?.(call, output);
    },
    onToolProgress(call, progress) {
      primary.onToolProgress?.(call, progress);
      secondary.onToolProgress?.(call, progress);
    },
    onToolError(call, error) {
      primary.onToolError?.(call, error);
      secondary.onToolError?.(call, error);
    },
    onCacheHit(call) {
      primary.onCacheHit?.(call);
      secondary.onCacheHit?.(call);
    },
    onToolWarning(call, warning) {
      primary.onToolWarning?.(call, warning);
      secondary.onToolWarning?.(call, warning);
    },
  } satisfies ToolRuntimeObserver;
}

function createControllerToolObserver(ref: EventSinkRef): ToolRuntimeObserver {
  const emit = (event: AgentEventUnion) => {
    ref.current?.push(event);
  };
  const timestamp = () => Date.now();
  return {
    onToolStart(call) {
      emit({
        type: 'tool.start',
        timestamp: timestamp(),
        toolName: call.name,
        toolCallId: call.id,
        parameters: { ...call.arguments },
      });
    },
    onToolResult(call, output) {
      emit({
        type: 'tool.complete',
        timestamp: timestamp(),
        toolName: call.name,
        toolCallId: call.id,
        result: output,
        parameters: { ...call.arguments },
      });
    },
    onToolError(call, error) {
      emit({
        type: 'tool.error',
        timestamp: timestamp(),
        toolName: call.name,
        toolCallId: call.id,
        error,
      });
    },
  } satisfies ToolRuntimeObserver;
}

interface AgentControllerDependencies {
  runtime: UniversalRuntime;
  sinkRef: EventSinkRef;
  externalCallbacks?: AgentCallbacks;
}

export interface AgentControllerCreateOptions extends Omit<NodeRuntimeOptions, 'toolObserver'> {
  profile: ProfileName;
  workspaceContext: string | null;
  workingDir: string;
  modules?: CapabilityModule[];
  callbacks?: AgentCallbacks;
  /** Skip provider discovery for faster startup (used in quick mode) */
  skipProviderDiscovery?: boolean;
}

export async function createAgentController(
  options: AgentControllerCreateOptions,
  additionalObserver?: ToolRuntimeObserver
): Promise<AgentController> {
  const sinkRef: EventSinkRef = { current: null };
  const observer = createControllerToolObserver(sinkRef);
  const runtime = await createNodeRuntime({
    profile: options.profile,
    workspaceContext: options.workspaceContext,
    workingDir: options.workingDir,
    env: options.env,
    toolObserver: mergeToolObservers(observer, additionalObserver),
    additionalModules: options.modules,
  });
  const controller = new AgentController({ runtime, sinkRef, externalCallbacks: options.callbacks });
  // Register the parallel-sub-agent tool now that the controller
  // exists — the tool handler resolves the provider lazily via the
  // controller's current selection, so it stays in sync with model
  // switches the user makes mid-session.
  try {
    const { wireAgentSpawning } = await import('./agentSpawningWiring.js');
    wireAgentSpawning({
      session: runtime.session,
      workingDir: options.workingDir,
      getSelection: () => controller.getSelection(),
      notifySubAgent: (e) => controller.emitSubAgentEvent(e),
    });
  } catch (err) {
    // Non-fatal: spawning is an optional capability. Surface the
    // failure for diagnostics but don't block CLI startup.
    logDebug?.('agent-spawning wiring failed: ' + (err instanceof Error ? err.message : String(err)));
  }
  return controller;
}

export class AgentController implements IAgentController {
  private readonly session: AgentSession;
  private readonly sinkRef: EventSinkRef;
  private readonly externalCallbacks: AgentCallbacks | undefined;
  private activeSink: EventStream<AgentEventUnion> | null = null;
  private agent: ReturnType<AgentSession['createAgent']> | null = null;
  private cachedHistory: ConversationMessage[] = [];
  private selection: ModelSelection;
  /** Set of providers that have failed with non-retryable errors in this session */
  private failedProviders: Set<ProviderId> = new Set();
  /** Maximum fallback attempts per send() call */
  private static readonly MAX_FALLBACK_ATTEMPTS = 3;
  private activeTimeout: NodeJS.Timeout | null = null;
  private inflightReject: ((error: Error) => void) | null = null;

  constructor(dependencies: AgentControllerDependencies) {
    this.session = dependencies.runtime.session;
    this.sinkRef = dependencies.sinkRef;
    this.externalCallbacks = dependencies.externalCallbacks;
    this.selection = this.buildInitialSelection();
  }

  private buildInitialSelection(): ModelSelection {
    const config = this.session.profileConfig;
    return {
      provider: config.provider,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      systemPrompt: config.systemPrompt,
    } satisfies ModelSelection;
  }

  /**
   * Live read of the current model selection. Used by the
   * agent-spawning wiring so sub-agents inherit whatever model the
   * user has currently chosen, even if they switched mid-session.
   */
  getSelection(): ModelSelection {
    return this.selection;
  }

  private ensureAgent(): ReturnType<AgentSession['createAgent']> {
    if (this.agent) {
      return this.agent;
    }
    const agent = this.session.createAgent(this.selection, this.createAgentCallbacks(), undefined, {
      explainEdits: true,
    });
    if (this.cachedHistory.length) {
      agent.loadHistory(this.cachedHistory);
    }
    this.agent = agent;
    return agent;
  }

  private createAgentCallbacks(): AgentCallbacks {
    return {
      onRequestReceived: (requestPreview) => {
        // Signal to UI that request was received - let model handle natural acknowledgment
        // Don't emit verbatim echo - it's redundant and the model's response should acknowledge contextually
        this.externalCallbacks?.onRequestReceived?.(requestPreview);
      },
      onAssistantMessage: (content, metadata) => {
        this.handleAssistantMessage(content, metadata);
        this.externalCallbacks?.onAssistantMessage?.(content, metadata);
      },
      onStreamChunk: (chunk, type) => {
        if (type === 'content') {
          // Content chunks go to message.delta for streaming display
          this.emitDelta(chunk, false);
        } else if (type === 'reasoning') {
          // Reasoning chunks go to reasoning event for thought display
          this.emitReasoning(chunk);
        }
        // Pass all chunks to external callbacks
        this.externalCallbacks?.onStreamChunk?.(chunk, type);
      },
      onUsage: (usage) => {
        this.emitUsage(usage);
        this.externalCallbacks?.onUsage?.(usage);
      },
      onContextPruned: (removedCount, stats) => {
        // Surface auto-compaction to the UI as a transcript event.
        this.activeSink?.push({
          type: 'context.compacted',
          timestamp: Date.now(),
          removed: removedCount,
          freedTokens: typeof stats['freedTokens'] === 'number' ? (stats['freedTokens'] as number) : 0,
          summarized: stats['summarized'] === true,
          percentage: typeof stats['percentage'] === 'number' ? (stats['percentage'] as number) : 0,
        });
        this.externalCallbacks?.onContextPruned?.(removedCount, stats);
      },
      onAdversarialFindings: (findings) => {
        // The reviewer refuted the draft — surface it so the shell can run a
        // bounded auto-correction (re-fix), not just show the caveat.
        this.activeSink?.push({ type: 'adversarial.findings', timestamp: Date.now(), findings });
        this.externalCallbacks?.onAdversarialFindings?.(findings);
      },
      onContextSquishing: (message) => {
        this.externalCallbacks?.onContextSquishing?.(message);
      },
      onContextRecovery: (attempt, maxAttempts, message) => {
        this.externalCallbacks?.onContextRecovery?.(attempt, maxAttempts, message);
      },
      onContinueAfterRecovery: () => {
        this.externalCallbacks?.onContinueAfterRecovery?.();
      },
      onMultilinePaste: (summary, metadata) => {
        this.externalCallbacks?.onMultilinePaste?.(summary, metadata);
      },
      onEditExplanation: (payload) => {
        this.handleEditExplanation(payload);
        this.externalCallbacks?.onEditExplanation?.(payload);
      },
      onRetrying: (attempt, maxAttempts, error) => {
        // Emit delta event to show retry status (synthetic: not model output)
        this.emitDelta(`[Retrying ${attempt}/${maxAttempts}: ${error.message}]`, false, true);
        this.externalCallbacks?.onRetrying?.(attempt, maxAttempts, error);
      },
      // onBeforeFirstToolCall not needed - model's reasoning is now emitted as thought events
    } satisfies AgentCallbacks;
  }

  /**
   * Check if content looks like garbage/leaked reasoning fragments.
   * Returns true if the content should be filtered out.
   * NOTE: Keep this minimal to avoid suppressing legitimate short responses.
   */
  private isGarbageContent(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed) return true;

    // Only filter pure punctuation/markdown artifacts
    if (/^[)\]}>*`'".:,!?|│┃─━═\s]+$/.test(trimmed)) return true;

    // Just newlines or whitespace
    if (/^[\s\n\r]+$/.test(trimmed)) return true;

    // Removed aggressive short fragment filtering - was suppressing legitimate content
    return false;
  }

  private emitDelta(content: string, isFinal: boolean, synthetic = false): void {
    // Only TRULY-empty content is skipped. A whitespace-only or
    // punctuation-only delta — the space before "3", the ":" in "DONE:", the
    // "\n\n" before a list — is LEGITIMATE streamed text, not garbage. The old
    // `!content.trim()` guard and isGarbageContent (a leaked-reasoning filter)
    // dropped these, gluing tokens in scrollback ("across 3"→"across3",
    // "files\n\n- litho"→"fileslitho"). The agent.ts accumulator keeps every
    // chunk, so dropping them here made the live/committed stream diverge from
    // the canonical message.complete; passing them through realigns the two.
    if (content == null || content === '') {
      return;
    }
    this.activeSink?.push({
      type: 'message.delta',
      timestamp: Date.now(),
      content,
      isFinal,
      synthetic,
    });
  }

  private emitError(message: string): void {
    this.activeSink?.push({
      type: 'error',
      timestamp: Date.now(),
      error: message,
    });
  }

  private emitReasoning(content: string): void {
    if (!content?.trim()) {
      return;
    }
    // Filter out garbage/leaked formatting fragments in reasoning too
    if (this.isGarbageContent(content)) {
      return;
    }
    this.activeSink?.push({
      type: 'reasoning',
      timestamp: Date.now(),
      content,
    });
  }

  private emitUsage(usage: ProviderUsage | null | undefined): void {
    if (!usage) {
      return;
    }
    this.activeSink?.push({
      type: 'usage',
      timestamp: Date.now(),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    });
  }

  /** Surface a parallel sub-agent's lifecycle to the UI (Task notes). */
  emitSubAgentEvent(e: { phase: 'start' | 'complete'; id: string; description: string; success?: boolean; elapsedMs?: number }): void {
    if (e.phase === 'start') {
      this.activeSink?.push({ type: 'subagent.start', timestamp: Date.now(), id: e.id, description: e.description });
    } else {
      this.activeSink?.push({
        type: 'subagent.complete',
        timestamp: Date.now(),
        id: e.id,
        description: e.description,
        success: e.success ?? true,
        elapsedMs: e.elapsedMs ?? 0,
      });
    }
  }

  private handleEditExplanation(payload: EditExplanationPayload): void {
    if (!this.activeSink) {
      return;
    }
    if (!payload.explanation?.trim()) {
      return;
    }
    this.activeSink.push({
      type: 'edit.explanation',
      timestamp: Date.now(),
      content: payload.explanation,
      files: payload.files,
      toolName: payload.toolName,
      toolCallId: payload.toolCallId,
    });
  }

  private handleAssistantMessage(content: string, metadata: AssistantMessageMetadata): void {
    if (!this.activeSink) {
      return;
    }
    if (!content.trim()) {
      return;
    }
    if (metadata.suppressDisplay) {
      return;
    }
    if (!metadata.isFinal) {
      // wasStreamed means these exact chars ALREADY went out live as
      // message.delta during streaming. Re-emitting them (even flagged
      // synthetic, which only suppresses metering — NOT display) makes the
      // shell append the narration to its stream buffer a second time, so it
      // renders twice ("…proposing an upgrade planI'll start by exploring…").
      // The agent records this content in conversation context itself via
      // messages.push, so the replay has no purpose here — drop it.
      if (metadata.wasStreamed) {
        return;
      }
      this.emitDelta(content, false, false);
      return;
    }
    const elapsedMs = metadata.elapsedMs ?? 0;
    this.activeSink.push({
      type: 'message.complete',
      timestamp: Date.now(),
      content,
      elapsedMs,
    });
    // Streamed runs already emitted this exact usage via onUsage when the
    // provider's usage chunk arrived; re-emitting it here double-counts
    // every turn's final request in the token meter and /usage accounting.
    if (!metadata.wasStreamed) {
      this.emitUsage(metadata.usage ?? null);
    }
  }

  private updateCachedHistory(): void {
    if (this.agent) {
      this.cachedHistory = this.agent.getHistory();
    }
  }

  cancel(reason?: string): void {
    if (!this.activeSink) {
      return;
    }
    const error = new Error(reason ?? 'Run cancelled');
    try {
      this.agent?.requestCancellation();
    } catch {
      // ignore cancellation errors
    }
    this.rejectInflight(error);
    this.activeSink.fail(error);
    this.activeSink = null;
    this.sinkRef.current = null;
    this.clearActiveTimeout();
  }

  private clearActiveTimeout(): void {
    if (this.activeTimeout) {
      clearTimeout(this.activeTimeout);
      this.activeTimeout = null;
    }
  }

  private rejectInflight(error: Error): void {
    if (this.inflightReject) {
      this.inflightReject(error);
      this.inflightReject = null;
    }
  }

  async *send(message: string): AsyncIterableIterator<AgentEventUnion> {
    if (this.activeSink) {
      throw new Error('Agent runtime is already processing a message. Please wait for the current run to finish.');
    }

    // Reset failed providers at the start of each new message
    // (providers might have recovered, quotas might have reset, etc.)
    this.failedProviders.clear();

    let fallbackAttempts = 0;

    // Retry loop for fallback handling
    while (fallbackAttempts < AgentController.MAX_FALLBACK_ATTEMPTS) {
      const agent = this.ensureAgent();
      const sink = new EventStream<AgentEventUnion>();
      this.activeSink = sink;
      this.sinkRef.current = sink;
      sink.push({ type: 'message.start', timestamp: Date.now() });

      const timeoutMsRaw = process.env['ANVILWING_AGENT_RUN_TIMEOUT_MS'];
      const parsed = timeoutMsRaw ? Number(timeoutMsRaw) : NaN;
      const effectiveTimeoutMs =
        !Number.isNaN(parsed) && parsed > 0 && parsed < 24 * 60 * 60 * 1000
          ? parsed
          : 24 * 60 * 60 * 1000;

      // The run-timeout must NOT count user think-time at HITL prompts.
      // We track when a HITL prompt is open, freeze the deadline while open,
      // and reschedule from the remaining-budget when it closes. This way a
      // configured run-timeout (e.g. ANVILWING_AGENT_RUN_TIMEOUT_MS=120000)
      // still bounds model+tool work, but a slow human never aborts the run.
      let remainingMs = effectiveTimeoutMs;
      let armedAt: number | null = null;
      const fireTimeout = () => {
        const err = new Error(`Run timed out after ${effectiveTimeoutMs}ms`);
        this.rejectInflight(err);
        sink.fail(err);
        try {
          this.agent?.requestCancellation();
        } catch {
          // ignore
        }
      };
      const arm = () => {
        if (this.activeTimeout || remainingMs <= 0) return;
        armedAt = Date.now();
        this.activeTimeout = setTimeout(fireTimeout, remainingMs);
      };
      const disarm = () => {
        if (!this.activeTimeout) return;
        clearTimeout(this.activeTimeout);
        this.activeTimeout = null;
        if (armedAt !== null) {
          remainingMs = Math.max(0, remainingMs - (Date.now() - armedAt));
          armedAt = null;
        }
      };

      const onPromptOpen = () => disarm();
      const onPromptClose = () => arm();
      hitlEvents.on('prompt-open', onPromptOpen);
      hitlEvents.on('prompt-close', onPromptClose);
      const detachHitlListeners = () => {
        hitlEvents.removeListener('prompt-open', onPromptOpen);
        hitlEvents.removeListener('prompt-close', onPromptClose);
      };

      arm();

      let caughtError: Error | null = null;
      let fallbackSucceeded = false;

      let cancelRun: ((error: Error) => void) | null = null;
      const cancelPromise = new Promise<never>((_, reject) => {
        cancelRun = reject;
      });
      this.inflightReject = (error: Error) => {
        cancelRun?.(error);
      };

      const run = Promise.race([
        agent.send(message, true),
        cancelPromise,
      ])
        .then(() => {
          this.updateCachedHistory();
          this.clearActiveTimeout();
          sink.close();
        })
        .catch(async (error) => {
          const errorObj = error instanceof Error ? error : new Error(String(error));
          caughtError = errorObj;
          this.clearActiveTimeout();

          const cancelled = /cancel/i.test(errorObj.message);
          const timedOut = /timed out/i.test(errorObj.message);
          if (cancelled || timedOut) {
            this.emitError(errorObj.message);
            sink.fail(errorObj);
            return;
          }

          // Check if this error is eligible for fallback
          if (isFallbackEligibleError(error) && fallbackAttempts < AgentController.MAX_FALLBACK_ATTEMPTS - 1) {
            logDebug(`[AgentController] Fallback-eligible error detected: ${errorObj.message}`);
            fallbackSucceeded = await this.attemptFallback(errorObj);
            if (fallbackSucceeded) {
              // Close this sink without error - we'll retry with new provider
              sink.close();
              return;
            }
          }

          // Not fallback-eligible or no fallback available - emit error and fail
          this.emitError(errorObj.message);
          sink.fail(errorObj);
        })
        .finally(() => {
          this.clearActiveTimeout();
          detachHitlListeners();
          this.inflightReject = null;
          if (this.activeSink === sink) {
            this.activeSink = null;
            this.sinkRef.current = null;
          }
        });

      try {
        for await (const event of sink) {
          yield event;
        }
      } finally {
        await run;
      }

      // If we successfully fell back, increment counter and continue loop
      if (fallbackSucceeded && caughtError) {
        fallbackAttempts++;
        logDebug(`[AgentController] Retrying with fallback provider (attempt ${fallbackAttempts}/${AgentController.MAX_FALLBACK_ATTEMPTS})`);
        continue;
      }

      // No fallback happened or it failed - exit loop
      break;
    }
  }

  async switchModel(config: ModelConfig): Promise<void> {
    this.updateCachedHistory();
    this.agent = null;
    // Single-model lock (defense in depth alongside config.ts): the product
    // supports anvilwing on anvilwing ONLY. Whatever a caller passes, the
    // selection stays pinned — temperature/maxTokens overrides still apply.
    this.selection = {
      provider: LOCKED_PROVIDER,
      model: LOCKED_MODEL,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      systemPrompt: this.selection.systemPrompt,
    } satisfies ModelSelection;
    this.session.updateToolContext(this.selection);
  }

  getCapabilities(): CapabilityManifest {
    const tools = this.session.toolRuntime.listProviderTools();
    const manifestTools: ToolCapability[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      category: 'general',
    }));
    return {
      contractVersion: AGENT_CONTRACT_VERSION,
      profile: this.session.profile,
      model: this.toModelConfig(this.selection),
      tools: manifestTools,
      features: ['streaming', 'tool-calls'],
    } satisfies CapabilityManifest;
  }

  registerToolSuite(suiteId: string, suite: ToolSuite): void {
    this.session.toolRuntime.registerSuite({ ...suite, id: suiteId });
  }

  unregisterToolSuite(suiteId: string): void {
    this.session.toolRuntime.unregisterSuite(suiteId);
  }

  getHistory(): ConversationMessage[] {
    if (this.agent) {
      return this.agent.getHistory();
    }
    return [...this.cachedHistory];
  }

  clearHistory(): void {
    this.cachedHistory = [];
    this.agent?.clearHistory();
  }

  /** Force a compaction now (manual /compact). Returns what was freed; a
   *  zero-removed result means there was nothing worth compacting. */
  async compactNow(): Promise<{ removed: number; summarized: boolean; freedTokens: number }> {
    return (await this.agent?.compactNow()) ?? { removed: 0, summarized: false, freedTokens: 0 };
  }

  /**
   * Restore a prior conversation into context (used by /resume). Sets the
   * cached history and, if an agent is already live, loads it directly;
   * otherwise ensureAgent() picks up cachedHistory on next send(). Runs
   * sanitizeHistory() because a saved session may have been snapshotted
   * mid-tool-execution, leaving orphaned tool calls the provider rejects.
   */
  loadHistory(history: ConversationMessage[]): void {
    this.cachedHistory = Array.isArray(history) ? history.map((m) => ({ ...m })) : [];
    this.agent?.loadHistory(this.cachedHistory);
    this.sanitizeHistory();
  }

  /**
   * Check if the controller is currently processing a message.
   */
  isProcessing(): boolean {
    return this.activeSink !== null;
  }

  /**
   * Force-clear any lingering active state. Use this before starting a new
   * operation (like a complex reasoning task) to ensure clean state.
   * This will close any active sink without waiting for completion.
   */
  forceReset(): void {
    if (this.activeSink) {
      try {
        this.activeSink.close();
      } catch {
        // Ignore errors - sink may already be closed
      }
      this.activeSink = null;
      this.sinkRef.current = null;
    }
  }

  /**
   * Sanitize history by fixing orphaned tool calls (tool_calls without corresponding tool results).
   * This can happen when a run is interrupted mid-tool-execution.
   * We add placeholder error results for any orphaned tool calls to keep history valid.
   */
  sanitizeHistory(): void {
    const history = this.getHistory();
    if (history.length === 0) return;

    const sanitized: ConversationMessage[] = [];
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      sanitized.push(msg);

      // Check if this is an assistant message with tool_calls
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        // Look ahead for tool results
        const toolCallIds = new Set(msg.toolCalls.map(tc => tc.id));
        let nextIdx = i + 1;

        // Consume any following tool messages
        while (nextIdx < history.length && history[nextIdx].role === 'tool') {
          const toolMsg = history[nextIdx] as { role: 'tool'; toolCallId: string };
          if (toolMsg.toolCallId) {
            toolCallIds.delete(toolMsg.toolCallId);
          }
          sanitized.push(history[nextIdx]);
          nextIdx++;
        }

        // Add placeholder results for any orphaned tool calls
        for (const orphanedId of toolCallIds) {
          const orphanedCall = msg.toolCalls.find(tc => tc.id === orphanedId);
          const toolName = orphanedCall?.name ?? 'unknown';
          sanitized.push({
            role: 'tool',
            name: toolName,
            toolCallId: orphanedId,
            content: `[Interrupted: ${toolName} execution was cancelled]`,
          });
        }

        // Skip the tool messages we already processed
        i = nextIdx - 1;
      }
    }

    // Update both cached history and agent history
    this.cachedHistory = sanitized;
    if (this.agent) {
      this.agent.loadHistory(sanitized);
    }
  }

  private toModelConfig(selection: ModelSelection): ModelConfig {
    return {
      provider: selection.provider,
      model: selection.model,
      temperature: selection.temperature,
      maxTokens: selection.maxTokens,
    } satisfies ModelConfig;
  }

  /**
   * Find the next available provider for fallback.
   * Excludes providers that have already failed in this session.
   */
  private findFallbackProvider(): { provider: ProviderId; model: string } | null {
    const configured = getConfiguredProviders();
    const currentProvider = this.selection.provider;

    // Single-provider product: anvilwing only. There is no cross-provider
    // fallback (no second provider exists to fall back to); a anvilwing outage
    // surfaces as an error rather than silently switching models.
    const preferenceOrder: ProviderId[] = ['anvilwing'];

    for (const providerId of preferenceOrder) {
      // Skip current provider and already failed providers
      if (providerId === currentProvider || this.failedProviders.has(providerId)) {
        continue;
      }

      // Check if this provider is configured
      const provider = configured.find(p => p.id === providerId);
      if (provider) {
        const model = getLatestModelForProvider(providerId);
        if (model) {
          return { provider: providerId, model };
        }
      }
    }

    return null;
  }

  /**
   * Emit a provider fallback event
   */
  private emitFallbackEvent(
    fromProvider: string,
    fromModel: string,
    toProvider: string,
    toModel: string,
    reason: string,
    error: string
  ): void {
    this.activeSink?.push({
      type: 'provider.fallback',
      timestamp: Date.now(),
      fromProvider,
      fromModel,
      toProvider,
      toModel,
      reason,
      error,
    });
  }

  /**
   * Attempt to switch to a fallback provider
   */
  private async attemptFallback(error: Error): Promise<boolean> {
    const fallback = this.findFallbackProvider();
    if (!fallback) {
      logDebug('[AgentController] No fallback provider available');
      return false;
    }

    const reason = getFallbackReason(error);
    const fromProvider = this.selection.provider;
    const fromModel = this.selection.model;

    // Mark current provider as failed
    this.failedProviders.add(fromProvider);

    // Emit fallback event
    this.emitFallbackEvent(
      fromProvider,
      fromModel,
      fallback.provider,
      fallback.model,
      reason,
      error.message
    );

    logDebug(`[AgentController] Falling back from ${fromProvider}/${fromModel} to ${fallback.provider}/${fallback.model}: ${reason}`);

    // Switch to fallback provider
    await this.switchModel({
      provider: fallback.provider,
      model: fallback.model,
    });

    return true;
  }

  getToolSuites(): ToolSuite[] {
    return this.session.toolSuites;
  }
}
