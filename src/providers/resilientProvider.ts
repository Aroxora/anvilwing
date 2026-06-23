/**
 * Resilient Provider Wrapper
 *
 * Adds rate limiting, exponential backoff retry, and circuit breaker
 * patterns to any LLM provider for maximum reliability and performance.
 *
 * PERF: Provider-agnostic wrapper that prevents rate limit errors and
 * automatically recovers from transient failures.
 */

import type {
  LLMProvider,
  ConversationMessage,
  ProviderToolDefinition,
  ProviderResponse,
  StreamChunk,
  ProviderId,
} from '../core/types.js';
import { RateLimiter, retry, sleep } from '../utils/asyncUtils.js';
// Error classification lives in the canonical module (audit Rank 5). Imported
// under this module's historical local names so the retry loop + circuit
// breaker call sites below are unchanged; isFallbackEligibleError +
// getFallbackReason are re-exported for agentController + the tests.
import {
  isFallbackEligibleError,
  getFallbackReason,
  isResilientRateLimitError as isRateLimitError,
  isResilientTransientError as isTransientError,
  shouldRetryResilient as shouldRetry,
} from '../core/errorClassification.js';

export { isFallbackEligibleError, getFallbackReason };

export interface ResilientProviderConfig {
  /** Maximum requests per window (default: 50) */
  maxRequestsPerMinute?: number;
  /** Maximum retry attempts (default: 4) */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay between retries in ms (default: 32000) */
  maxDelayMs?: number;
  /** Enable circuit breaker pattern (default: true) */
  enableCircuitBreaker?: boolean;
  /** Number of failures before circuit opens (default: 5) */
  circuitBreakerThreshold?: number;
  /** Time before circuit resets in ms (default: 60000) */
  circuitBreakerResetMs?: number;
}

interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

/**
 * Wraps any LLM provider with rate limiting and retry logic
 */
export class ResilientProvider implements LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  private readonly provider: LLMProvider;
  private readonly rateLimiter: RateLimiter;
  private readonly config: Required<ResilientProviderConfig>;
  private readonly circuitBreaker: CircuitBreakerState;
  private stats = {
    totalRequests: 0,
    rateLimitHits: 0,
    retries: 0,
    circuitBreakerTrips: 0,
  };

  constructor(provider: LLMProvider, config: ResilientProviderConfig = {}) {
    this.provider = provider;
    this.id = provider.id;
    this.model = provider.model;
    this.config = {
      maxRequestsPerMinute: config.maxRequestsPerMinute ?? 50,
      maxRetries: config.maxRetries ?? 4,
      baseDelayMs: config.baseDelayMs ?? 1000,
      maxDelayMs: config.maxDelayMs ?? 32000,
      enableCircuitBreaker: config.enableCircuitBreaker ?? true,
      circuitBreakerThreshold: config.circuitBreakerThreshold ?? 5,
      circuitBreakerResetMs: config.circuitBreakerResetMs ?? 60000,
    };

    this.rateLimiter = new RateLimiter({
      maxRequests: this.config.maxRequestsPerMinute,
      windowMs: 60000,
    });

    this.circuitBreaker = {
      failures: 0,
      lastFailure: 0,
      isOpen: false,
    };
  }

  /**
   * Check and potentially reset circuit breaker
   */
  private checkCircuitBreaker(): void {
    if (!this.config.enableCircuitBreaker) return;

    if (this.circuitBreaker.isOpen) {
      const elapsed = Date.now() - this.circuitBreaker.lastFailure;
      if (elapsed >= this.config.circuitBreakerResetMs) {
        // Half-open: allow one request through
        this.circuitBreaker.isOpen = false;
        this.circuitBreaker.failures = Math.floor(this.circuitBreaker.failures / 2);
      } else {
        throw new Error(
          `Circuit breaker is open. Too many failures (${this.circuitBreaker.failures}). ` +
          `Retry in ${Math.ceil((this.config.circuitBreakerResetMs - elapsed) / 1000)}s.`
        );
      }
    }
  }

  /**
   * Record a failure for circuit breaker
   */
  private recordFailure(_error?: unknown): void {
    if (!this.config.enableCircuitBreaker) return;

    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailure = Date.now();

    if (this.circuitBreaker.failures >= this.config.circuitBreakerThreshold) {
      this.circuitBreaker.isOpen = true;
      this.stats.circuitBreakerTrips++;
    }
  }

  /**
   * Record a success to reset circuit breaker
   */
  private recordSuccess(): void {
    if (this.config.enableCircuitBreaker && this.circuitBreaker.failures > 0) {
      this.circuitBreaker.failures = Math.max(0, this.circuitBreaker.failures - 1);
    }
  }

  /**
   * Execute a request with rate limiting and retry
   */
  private async executeWithResilience<T>(
    operation: () => Promise<T>,
    _operationName?: string
  ): Promise<T> {
    this.stats.totalRequests++;

    // Check circuit breaker
    this.checkCircuitBreaker();

    // Acquire rate limit token
    await this.rateLimiter.acquire();

    try {
      const result = await retry(
        operation,
        {
          maxRetries: this.config.maxRetries,
          baseDelayMs: this.config.baseDelayMs,
          maxDelayMs: this.config.maxDelayMs,
          backoffMultiplier: 2,
          shouldRetry: (error) => {
            if (shouldRetry(error)) {
              this.stats.retries++;
              if (isRateLimitError(error)) {
                this.stats.rateLimitHits++;
              }
              return true;
            }
            return false;
          },
        }
      );

      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
  }

  /**
   * Generate a response with resilience
   */
  async generate(
    messages: ConversationMessage[],
    tools: ProviderToolDefinition[]
  ): Promise<ProviderResponse> {
    return this.executeWithResilience(
      () => this.provider.generate(messages, tools),
      'generate'
    );
  }

  /**
   * Generate a streaming response with resilience
   *
   * Note: Retry logic is limited for streaming - we can only retry
   * before the stream starts, not mid-stream.
   */
  async *generateStream(
    messages: ConversationMessage[],
    tools: ProviderToolDefinition[]
  ): AsyncIterableIterator<StreamChunk> {
    if (!this.provider.generateStream) {
      // Fall back to non-streaming
      const response = await this.generate(messages, tools);
      if (response.type === 'message') {
        yield { type: 'content', content: response.content };
      } else if (response.type === 'tool_calls') {
        if (response.content) {
          yield { type: 'content', content: response.content };
        }
        if (response.toolCalls) {
          for (const call of response.toolCalls) {
            yield { type: 'tool_call', toolCall: call };
          }
        }
      }
      if (response.usage) {
        yield { type: 'usage', usage: response.usage };
      }
      return;
    }

    this.stats.totalRequests++;

    // Check circuit breaker
    this.checkCircuitBreaker();

    // Acquire rate limit token
    await this.rateLimiter.acquire();

    let attempts = 0;
    let lastError: unknown;
    // Retry is only safe BEFORE the first chunk is emitted (see the note above).
    // Once we've yielded anything, re-running the stream would re-emit it from
    // chunk 0 and duplicate content downstream — so a mid-stream failure must
    // surface, not retry.
    let yieldedAny = false;

    while (attempts <= this.config.maxRetries) {
      try {
        const stream = this.provider.generateStream(messages, tools);
        for await (const chunk of stream) {
          yieldedAny = true;
          yield chunk;
        }
        this.recordSuccess();
        return;
      } catch (err) {
        lastError = err;
        attempts++;

        if (!yieldedAny && attempts <= this.config.maxRetries && shouldRetry(err)) {
          this.stats.retries++;
          if (isRateLimitError(err)) {
            this.stats.rateLimitHits++;
          }

          const delay = Math.min(
            this.config.baseDelayMs * Math.pow(2, attempts - 1),
            this.config.maxDelayMs
          );
          await sleep(delay);
          continue;
        }

        this.recordFailure(err);
        throw err;
      }
    }

    this.recordFailure(lastError);
    throw lastError;
  }

  /**
   * Get resilience statistics
   */
  getStats(): {
    totalRequests: number;
    rateLimitHits: number;
    retries: number;
    circuitBreakerTrips: number;
    circuitBreakerOpen: boolean;
    availableTokens: number;
  } {
    return {
      ...this.stats,
      circuitBreakerOpen: this.circuitBreaker.isOpen,
      availableTokens: this.rateLimiter.availableTokens,
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalRequests: 0,
      rateLimitHits: 0,
      retries: 0,
      circuitBreakerTrips: 0,
    };
  }
}

/**
 * Wrap any provider with resilience features
 */
export function withResilience(
  provider: LLMProvider,
  config?: ResilientProviderConfig
): ResilientProvider {
  return new ResilientProvider(provider, config);
}

/**
 * Provider-specific recommended configurations
 */
export const PROVIDER_RESILIENCE_CONFIGS: Record<string, ResilientProviderConfig> = {
  anvilwing: {
    maxRequestsPerMinute: 30,
    maxRetries: 4,
    baseDelayMs: 2000,
    maxDelayMs: 45000,
  },
};

/**
 * Wrap a provider with resilience using provider-specific defaults
 */
export function withProviderResilience(
  provider: LLMProvider,
  providerId: string,
  overrides?: Partial<ResilientProviderConfig>
): ResilientProvider {
  const defaults = PROVIDER_RESILIENCE_CONFIGS[providerId] ?? {};
  return new ResilientProvider(provider, { ...defaults, ...overrides });
}
