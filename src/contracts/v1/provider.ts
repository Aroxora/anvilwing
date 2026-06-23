/**
 * Provider Contract v1.0
 * 
 * Stable interface for LLM provider integration.
 */

export const PROVIDER_CONTRACT_VERSION = '1.0.0';

/**
 * Provider configuration
 */
export interface ProviderConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Conversation message structure
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface BaseMessage {
  role: MessageRole;
  content: string;
}

export interface SystemMessage extends BaseMessage {
  role: 'system';
}

export interface UserMessage extends BaseMessage {
  role: 'user';
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AssistantMessage extends BaseMessage {
  role: 'assistant';
  toolCalls?: ToolCall[];
}

export interface ToolMessage extends BaseMessage {
  role: 'tool';
  name: string;
  toolCallId: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/**
 * Tool definition for providers
 */
export interface ProviderToolDefinition {
  name: string;
  description: string;
  parameters?: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/**
 * Provider response types
 */
export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ProviderMessageResponse {
  type: 'message';
  content: string;
  usage?: ProviderUsage | null;
}

export interface ProviderToolCallsResponse {
  type: 'tool_calls';
  toolCalls: ToolCall[];
  content?: string;
  usage?: ProviderUsage | null;
}

export type ProviderResponse = ProviderMessageResponse | ProviderToolCallsResponse;

/**
 * Streaming response
 */
export interface StreamChunk {
  type: 'content' | 'reasoning' | 'tool_call' | 'usage' | 'done';
  content?: string;
  toolCall?: Partial<ToolCall>;
  usage?: ProviderUsage;
}

/**
 * Provider interface
 */
export interface ILLMProvider {
  readonly id: string;
  readonly model: string;

  /**
   * Generate a completion (non-streaming)
   */
  generate(messages: Message[], tools: ProviderToolDefinition[]): Promise<ProviderResponse>;

  /**
   * Generate a streaming completion
   */
  generateStream?(
    messages: Message[],
    tools: ProviderToolDefinition[]
  ): AsyncIterableIterator<StreamChunk>;

  /**
   * Get provider capabilities
   */
  getCapabilities(): ProviderCapabilities;
}

/**
 * Provider capabilities
 */
export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  vision: boolean;
  functionCalling: boolean;
  maxTokens: number;
  supportedModalities: ('text' | 'image' | 'audio')[];
}

/**
 * Provider factory
 */
export type ProviderFactory = (config: ProviderConfig) => ILLMProvider;

/**
 * Provider registry interface
 */
export interface IProviderRegistry {
  /**
   * Register a provider factory
   */
  register(providerId: string, factory: ProviderFactory): void;

  /**
   * Unregister a provider
   */
  unregister(providerId: string): void;

  /**
   * Create a provider instance
   */
  create(config: ProviderConfig): ILLMProvider;

  /**
   * Check if provider is registered
   */
  has(providerId: string): boolean;

  /**
   * List all registered providers
   */
  list(): string[];
}
