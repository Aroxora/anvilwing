/**
 * Base Provider - Abstract LLM Provider Implementation
 *
 * Provides common functionality for LLM providers:
 * - Retry logic with exponential backoff
 * - Rate limit handling
 * - Transient error recovery
 * - Message conversion utilities
 * - Usage tracking
 *
 * Usage:
 * ```typescript
 * class MyProvider extends BaseProvider {
 *   readonly id = 'my-provider';
 *
 *   protected async doGenerate(messages, tools): Promise<ProviderResponse> {
 *     // Provider-specific implementation
 *   }
 *
 *   protected async doGenerateStream(messages, tools): AsyncIterable<StreamChunk> {
 *     // Provider-specific implementation
 *   }
 * }
 * ```
 */

import type {
  ConversationMessage,
  LLMProvider,
  ProviderResponse,
  ProviderToolDefinition,
  ProviderUsage,
  StreamChunk,
  ProviderModelInfo,
} from '../core/types.js';
// Error classification lives in the canonical module (audit Rank 5). These are
// re-exported below under this module's historical public names so importers
// (test/providers/baseProvider.test.ts) and withRetry's defaults are unchanged.
import {
  BASE_TRANSIENT_ERROR_PATTERNS,
  isBaseTransientError,
  isBaseRateLimitError,
  isAuthError,
} from '../core/errorClassification.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

/** Patterns that indicate transient/retryable errors (canonical: errorClassification) */
export const TRANSIENT_ERROR_PATTERNS = BASE_TRANSIENT_ERROR_PATTERNS;

/** Default retry configuration */
export const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
} as const;

/** Default rate limit configuration */
export const DEFAULT_RATE_LIMIT_CONFIG = {
  maxRetries: 4,
  initialDelayMs: 1500,
  minDelayMs: 750,
  maxDelayMs: 40000,
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

export interface RateLimitConfig {
  maxRetries: number;
  initialDelayMs: number;
  minDelayMs: number;
  maxDelayMs: number;
}

export interface BaseProviderOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  retryConfig?: Partial<RetryConfig>;
  rateLimitConfig?: Partial<RateLimitConfig>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Error Detection Utilities
// ═══════════════════════════════════════════════════════════════════════════════

// Re-exported under this module's historical public names. Definitions live in
// src/core/errorClassification.ts (moved verbatim, audit Rank 5). withRetry
// below still references isTransientError/isAuthError through these bindings.
export const isTransientError = isBaseTransientError;
export const isRateLimitError = isBaseRateLimitError;
export { isAuthError };

// ═══════════════════════════════════════════════════════════════════════════════
// Retry Utilities
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sleep for a given duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay
 */
export function calculateBackoffDelay(
  attempt: number,
  config: RetryConfig
): number {
  const delay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
  // Add jitter (±10%)
  const jitter = delay * 0.1 * (Math.random() * 2 - 1);
  return Math.min(delay + jitter, config.maxDelayMs);
}

/**
 * Execute an operation with retry logic
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    config?: Partial<RetryConfig>;
    shouldRetry?: (error: unknown) => boolean;
    onRetry?: (error: unknown, attempt: number, delay: number) => void;
  } = {}
): Promise<T> {
  const config: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...options.config,
  };
  const shouldRetry = options.shouldRetry ?? isTransientError;

  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Don't retry auth errors
      if (isAuthError(error)) {
        throw error;
      }

      // Check if we should retry
      if (attempt === config.maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Calculate delay and wait
      const delay = calculateBackoffDelay(attempt, config);
      options.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }

  throw lastError;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Message Utilities
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract system message from conversation
 */
export function extractSystemMessage(
  messages: ConversationMessage[]
): { system: string | null; rest: ConversationMessage[] } {
  const systemMessages = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');

  if (systemMessages.length === 0) {
    return { system: null, rest };
  }

  // Combine all system messages
  const system = systemMessages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n\n');

  return { system, rest };
}

/**
 * Merge consecutive messages from the same role
 */
export function mergeConsecutiveMessages(
  messages: ConversationMessage[]
): ConversationMessage[] {
  if (messages.length === 0) return [];

  const merged: ConversationMessage[] = [];
  let current: ConversationMessage | null = null;

  for (const message of messages) {
    if (!current) {
      current = { ...message };
      continue;
    }

    if (current.role === message.role && typeof current.content === 'string' && typeof message.content === 'string') {
      // Merge text content
      current.content = `${current.content}\n\n${message.content}`;
    } else {
      merged.push(current);
      current = { ...message };
    }
  }

  if (current) {
    merged.push(current);
  }

  return merged;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Usage Tracking
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create an empty usage object
 */
export function emptyUsage(): ProviderUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

/**
 * Merge usage objects
 */
export function mergeUsage(a: ProviderUsage, b: ProviderUsage): ProviderUsage {
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Abstract Base Provider
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Abstract base class for LLM providers
 *
 * Implements common functionality like retry logic and error handling.
 * Subclasses must implement the abstract methods for provider-specific behavior.
 */
export abstract class BaseProvider implements LLMProvider {
  abstract readonly id: string;
  readonly model: string;

  protected readonly maxTokens: number;
  protected readonly temperature: number;
  protected readonly retryConfig: RetryConfig;
  protected readonly rateLimitConfig: RateLimitConfig;

  constructor(options: BaseProviderOptions) {
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? 4096;
    this.temperature = options.temperature ?? 0;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...options.retryConfig };
    this.rateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG, ...options.rateLimitConfig };
  }

  /**
   * Generate a response (implemented by subclass)
   */
  async generate(
    messages: ConversationMessage[],
    tools: ProviderToolDefinition[]
  ): Promise<ProviderResponse> {
    return withRetry(
      () => this.doGenerate(messages, tools),
      {
        config: this.retryConfig,
        shouldRetry: (error) => isTransientError(error) || isRateLimitError(error),
        onRetry: (error, attempt, delay) => {
          this.onRetry(error, attempt, delay);
        },
      }
    );
  }

  /**
   * Generate a streaming response (implemented by subclass)
   */
  async *generateStream(
    messages: ConversationMessage[],
    tools: ProviderToolDefinition[]
  ): AsyncIterableIterator<StreamChunk> {
    // Stream operations are harder to retry, so we do best-effort
    yield* this.doGenerateStream(messages, tools);
  }

  /**
   * Get available models (optional, implemented by subclass)
   */
  async getModels(): Promise<ProviderModelInfo[]> {
    return [];
  }

  /**
   * Provider-specific generate implementation
   */
  protected abstract doGenerate(
    messages: ConversationMessage[],
    tools: ProviderToolDefinition[]
  ): Promise<ProviderResponse>;

  /**
   * Provider-specific stream implementation
   */
  protected abstract doGenerateStream(
    messages: ConversationMessage[],
    tools: ProviderToolDefinition[]
  ): AsyncIterable<StreamChunk>;

  /**
   * Called when a retry is about to happen
   */
  protected onRetry(_error: unknown, _attempt: number, _delay: number): void {
    // Subclasses can override for logging
  }
}
