/**
 * Agent Contract v1.0
 * 
 * Stable interface for agent interaction across all frontends.
 * Breaking changes require a new version (v2/).
 */

export const AGENT_CONTRACT_VERSION = '1.0.0';

/**
 * Event types emitted during agent execution
 */
export type AgentEventType =
  | 'message.start'
  | 'message.delta'
  | 'message.complete'
  | 'tool.start'
  | 'tool.complete'
  | 'tool.error'
  | 'edit.explanation'
  | 'reasoning'
  | 'error'
  | 'usage'
  | 'provider.fallback'
  | 'context.compacted'
  | 'subagent.start'
  | 'subagent.complete'
  | 'adversarial.findings';

/**
 * Base event structure
 */
export interface AgentEvent {
  type: AgentEventType;
  timestamp: number;
}

/**
 * Message events
 */
export interface MessageStartEvent extends AgentEvent {
  type: 'message.start';
}

export interface MessageDeltaEvent extends AgentEvent {
  type: 'message.delta';
  content: string;
  isFinal: boolean;
  /** Replayed/notice content (already-streamed narration, retry notices) — never meter it as model output. */
  synthetic?: boolean;
}

export interface MessageCompleteEvent extends AgentEvent {
  type: 'message.complete';
  content: string;
  elapsedMs: number;
}

/**
 * Tool execution events
 */
export interface ToolStartEvent extends AgentEvent {
  type: 'tool.start';
  toolName: string;
  toolCallId: string;
  parameters: Record<string, unknown>;
}

export interface ToolCompleteEvent extends AgentEvent {
  type: 'tool.complete';
  toolName: string;
  toolCallId: string;
  result: string;
  // Carried through from the originating call so result formatters can render
  // structured output (e.g. the TodoWrite checklist) without re-parsing text.
  parameters?: Record<string, unknown>;
}

export interface ToolErrorEvent extends AgentEvent {
  type: 'tool.error';
  toolName: string;
  toolCallId: string;
  error: string;
}

export interface EditExplanationEvent extends AgentEvent {
  type: 'edit.explanation';
  content: string;
  files?: string[];
  toolName?: string;
  toolCallId?: string;
}

/**
 * Reasoning/thought event - model's internal thinking process
 */
export interface ReasoningEvent extends AgentEvent {
  type: 'reasoning';
  content: string;
}

/**
 * Error and usage events
 */
export interface ErrorEvent extends AgentEvent {
  type: 'error';
  error: string;
  code?: string;
}

export interface UsageEvent extends AgentEvent {
  type: 'usage';
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * Provider fallback event - emitted when switching to another provider due to error
 */
export interface ProviderFallbackEvent extends AgentEvent {
  type: 'provider.fallback';
  /** Provider that failed */
  fromProvider: string;
  /** Model that failed */
  fromModel: string;
  /** Provider being switched to */
  toProvider: string;
  /** Model being switched to */
  toModel: string;
  /** Reason for fallback */
  reason: string;
  /** Original error message */
  error: string;
}

/**
 * Emitted when the context manager auto-compacts the conversation to stay
 * within the model's window — surfaced to the user as a dim transcript note.
 */
export interface ContextCompactedEvent extends AgentEvent {
  type: 'context.compacted';
  /** messages removed / summarized */
  removed: number;
  /** approximate tokens freed (estimate before − after) */
  freedTokens: number;
  /** true if LLM summarization was used; false for a simple prune */
  summarized: boolean;
  /** resulting context-usage percentage after compaction */
  percentage: number;
}

/**
 * Emitted when a parallel sub-agent (Task) spawns / finishes — surfaced live
 * like Claude Code's Task tool so the parallel fan-out is visible.
 */
export interface SubAgentStartEvent extends AgentEvent {
  type: 'subagent.start';
  id: string;
  /** short label for the sub-task */
  description: string;
}

export interface SubAgentCompleteEvent extends AgentEvent {
  type: 'subagent.complete';
  id: string;
  description: string;
  success: boolean;
  elapsedMs: number;
}

/**
 * Emitted when the always-on adversarial reviewer refutes a finished draft —
 * the shell turns this into a bounded auto-correction (re-run the agent to fix
 * the findings) rather than just appending an advisory caveat.
 */
export interface AdversarialFindingsEvent extends AgentEvent {
  type: 'adversarial.findings';
  findings: string;
}

/**
 * Union of all event types
 */
export type AgentEventUnion =
  | MessageStartEvent
  | MessageDeltaEvent
  | MessageCompleteEvent
  | ToolStartEvent
  | ToolCompleteEvent
  | ToolErrorEvent
  | EditExplanationEvent
  | ReasoningEvent
  | ErrorEvent
  | UsageEvent
  | ProviderFallbackEvent
  | ContextCompactedEvent
  | SubAgentStartEvent
  | SubAgentCompleteEvent
  | AdversarialFindingsEvent;

/**
 * Model selection configuration
 */
export interface ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Capability manifest
 */
export interface CapabilityManifest {
  contractVersion: string;
  profile: string;
  model: ModelConfig;
  tools: ToolCapability[];
  features: string[];
}

export interface ToolCapability {
  name: string;
  description: string;
  category: string;
}

/**
 * Core agent controller interface
 * 
 * This is the stable contract that all frontends depend on.
 */
export interface IAgentController {
  /**
   * Send a message and receive streaming events
   */
  send(message: string): AsyncIterableIterator<AgentEventUnion>;

  /**
   * Switch the active model
   */
  switchModel(config: ModelConfig): Promise<void>;

  /**
   * Get current capabilities
   */
  getCapabilities(): CapabilityManifest;

  /**
   * Register a tool suite
   */
  registerToolSuite(suiteId: string, suite: unknown): void;

  /**
   * Unregister a tool suite
   */
  unregisterToolSuite(suiteId: string): void;

  /**
   * Get conversation history
   */
  getHistory(): ConversationMessage[];

  /**
   * Clear conversation history
   */
  clearHistory(): void;

  /**
   * Restore a prior conversation into context (session resume)
   */
  loadHistory(history: ConversationMessage[]): void;
}

/**
 * Conversation message structure
 */
export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  toolCallId?: string;
  name?: string;
}
