/**
 * AI Provider identifier for multi-provider support
 */
export type ProviderId = string;

/**
 * Reasoning effort levels for AI model optimization
 */
export type ReasoningEffortLevel = 'low' | 'medium' | 'high';

/**
 * Text verbosity levels for output control
 */
export type TextVerbosityLevel = 'low' | 'medium' | 'high';

/**
 * Thinking budget configuration for reasoning models
 * Controls how much reasoning/thinking the model performs
 */
export interface ThinkingBudgetConfig {
  /** Enable extended thinking mode */
  readonly enabled: boolean;
  /** Maximum tokens for thinking/reasoning (provider-specific ranges apply) */
  readonly budgetTokens?: number;
}

/**
 * Thinking level for models that support discrete thinking intensities
 */
export type ThinkingLevel = 'low' | 'medium' | 'high';

/**
 * Conversation roles in AI message flow
 */
export type ConversationRole = 'system' | 'user' | 'assistant' | 'tool';

export interface SystemMessage {
  role: 'system';
  content: string;
}

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface ToolCallArguments {
  [key: string]: unknown;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: ToolCallArguments;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  toolCalls?: ToolCallRequest[];
}

export interface ToolMessage {
  role: 'tool';
  name: string;
  content: string;
  toolCallId: string;
}

/**
 * Enhanced discriminated union for type-safe tool responses
 * Provides comprehensive error handling and metadata tracking
 */
export interface ToolSuccessResponse {
  readonly type: 'success';
  readonly content: string;
  readonly metadata?: {
    readonly linesRead?: number;
    readonly fileSize?: number;
    readonly executionTime?: number;
    readonly cacheHit?: boolean;
    readonly toolName?: string;
    readonly timestamp?: number;
  };
}

/**
 * Structured error response with recovery guidance
 */
export interface ToolErrorResponse {
  readonly type: 'error';
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly suggestion?: string;
    readonly recoverable: boolean;
    readonly toolName?: string;
  };
}

/**
 * Warning response with actionable suggestions
 */
export interface ToolWarningResponse {
  readonly type: 'warning';
  readonly content: string;
  readonly warnings: ReadonlyArray<{
    readonly code: string;
    readonly message: string;
    readonly severity: 'critical' | 'warning' | 'info';
    readonly suggestion: string;
  }>;
}

/**
 * Progress update for long-running operations
 */
export interface ToolProgressResponse {
  readonly type: 'progress';
  readonly progress: number;
  readonly message: string;
  readonly metadata?: {
    readonly estimatedRemaining?: number;
    readonly currentStep?: string;
  };
}

/**
 * Comprehensive tool response union for AI flow control
 */
export type ToolResponse = 
  | ToolSuccessResponse 
  | ToolErrorResponse 
  | ToolWarningResponse
  | ToolProgressResponse;

/**
 * Type guard for successful tool responses
 */
export function isToolSuccess(response: ToolResponse): response is ToolSuccessResponse {
  return response.type === 'success';
}

/**
 * Type guard for error tool responses
 */
export function isToolError(response: ToolResponse): response is ToolErrorResponse {
  return response.type === 'error';
}

/**
 * Type guard for warning tool responses
 */
export function isToolWarning(response: ToolResponse): response is ToolWarningResponse {
  return response.type === 'warning';
}

/**
 * Type guard for progress tool responses
 */
export function isToolProgress(response: ToolResponse): response is ToolProgressResponse {
  return response.type === 'progress';
}

export type ConversationMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/**
 * Base interface for all JSON Schema property definitions
 */
export interface JSONSchemaPropertyBase {
  readonly description?: string;
  readonly nullable?: boolean;
  readonly deprecated?: boolean;
  readonly readOnly?: boolean;
  readonly writeOnly?: boolean;
}

/**
 * String schema with validation constraints
 */
export interface JSONSchemaString extends JSONSchemaPropertyBase {
  readonly type: 'string';
  readonly enum?: ReadonlyArray<string>;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: 'date-time' | 'email' | 'uri' | 'uuid' | 'hostname';
  readonly default?: string;
}

/**
 * Number schema with validation constraints
 */
export interface JSONSchemaNumber extends JSONSchemaPropertyBase {
  readonly type: 'number';
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
  readonly default?: number;
}

/**
 * Boolean schema
 */
export interface JSONSchemaBoolean extends JSONSchemaPropertyBase {
  readonly type: 'boolean';
  readonly default?: boolean;
}

/**
 * Array schema with item validation
 */
export interface JSONSchemaArray extends JSONSchemaPropertyBase {
  readonly type: 'array';
  readonly items: JSONSchemaProperty;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
}

/**
 * Union type for all JSON Schema property types
 */
export type JSONSchemaProperty =
  | JSONSchemaString
  | JSONSchemaNumber
  | JSONSchemaBoolean
  | JSONSchemaArray
  | JSONSchemaObject;

/**
 * Object schema with property validation
 */
export interface JSONSchemaObject extends JSONSchemaPropertyBase {
  readonly type: 'object';
  readonly properties?: Readonly<Record<string, JSONSchemaProperty>>;
  readonly required?: ReadonlyArray<string>;
  readonly additionalProperties?: boolean;
  readonly minProperties?: number;
  readonly maxProperties?: number;
}

/**
 * Definition of a tool available to AI providers
 */
export interface ProviderToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters?: JSONSchemaObject;
}

/**
 * Token usage statistics from AI provider
 */
export interface ProviderUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

/**
 * Why the model stopped generating - critical for agentic loop control
 */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';

/**
 * Base interface for all provider responses
 */
export interface ProviderResponseBase {
  readonly usage?: ProviderUsage | null;
  /** Why the model stopped - determines if auto-continuation is needed */
  readonly stopReason?: StopReason;
}

/**
 * Discriminated union for provider responses
 */
export type ProviderResponse =
  | (ProviderResponseBase & {
      readonly type: 'message';
      readonly content: string;
    })
  | (ProviderResponseBase & {
      readonly type: 'tool_calls';
      readonly toolCalls: ToolCallRequest[];
      readonly content?: string;
    });

/**
 * Streaming chunk for real-time AI responses
 */
export interface StreamChunk {
  readonly type: 'content' | 'reasoning' | 'tool_call' | 'usage' | 'done';
  readonly content?: string;
  readonly toolCall?: ToolCallRequest;
  readonly usage?: ProviderUsage;
  /** Stop reason from the final message - included with 'done' chunk */
  readonly stopReason?: StopReason;
}

/**
 * AI Provider interface for multi-provider support
 */
export interface LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  generate(messages: ConversationMessage[], tools: ProviderToolDefinition[]): Promise<ProviderResponse>;
  generateStream?(messages: ConversationMessage[], tools: ProviderToolDefinition[]): AsyncIterableIterator<StreamChunk>;
  getCapabilities?(): ProviderCapabilities;
  /** Fetch model info from the provider API (context window, limits, etc.) */
  getModelInfo?(): Promise<ProviderModelInfo | null>;
}

/**
 * Model information retrieved from the provider API
 */
export interface ProviderModelInfo {
  readonly id: string;
  readonly contextWindow: number;
  readonly maxOutputTokens?: number;
  readonly inputTokenLimit?: number;
  readonly outputTokenLimit?: number;
}

/**
 * Capabilities of an AI provider
 */
export interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly toolCalling: boolean;
  readonly vision: boolean;
  readonly functionCalling: boolean;
  readonly maxTokens: number;
  readonly supportedModalities: ReadonlyArray<'text' | 'image' | 'audio'>;
  /** Context window size from provider API (undefined if not yet fetched) */
  readonly contextWindow?: number;
}

/**
 * Type-safe Result pattern for error handling
 * Eliminates the need for try-catch blocks and provides compile-time safety
 */
export type Result<T, E = Error> = 
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/**
 * Type guard for successful Result
 */
export function isOk<T, E>(result: Result<T, E>): result is { readonly ok: true; readonly value: T } {
  return result.ok;
}

/**
 * Type guard for failed Result
 */
export function isErr<T, E>(result: Result<T, E>): result is { readonly ok: false; readonly error: E } {
  return !result.ok;
}

/**
 * Creates a successful Result
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Creates a failed Result
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Unwraps a Result, throwing if it's an error
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw (result as { ok: false; error: E }).error;
}

/**
 * Unwraps a Result, returning a default value if it's an error
 */
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  return result.ok ? result.value : defaultValue;
}

/**
 * Maps a successful Result to a new value
 */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? { ok: true, value: fn(result.value) } : result as Result<U, E>;
}

/**
 * Maps an error Result to a new error
 */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result as unknown as Result<T, F> : { ok: false, error: fn((result as { ok: false; error: E }).error) };
}
