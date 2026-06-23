import type {
  ConversationMessage,
  LLMProvider,
  ProviderCapabilities,
  ProviderId,
  ProviderModelInfo,
  ProviderResponse,
  ProviderToolDefinition,
  StreamChunk,
} from '../../../core/types.js';
import { OpenAIChatCompletionsProvider } from '../../../providers/openaiChatCompletionsProvider.js';
import { registerProvider } from '../../../providers/providerFactory.js';
import { withProviderResilience } from '../../../providers/resilientProvider.js';
import { buildAnvilwingQuotaError, isAnvilwingQuotaError } from '../../../core/quotaErrors.js';
import { resolveAnvilwingEndpoint } from '../../../core/keyResolution.js';
import { getModelContextInfo } from '../../../core/contextWindow.js';

let registered = false;

/**
 * Translate raw Anvilwing HTTP 402 / "Insufficient Balance" errors into a
 * single recognizable message at the provider boundary. The resilience /
 * retry layer above this wrapper already treats non-transient errors as
 * terminal, so all we have to do is rewrite the message — no retry-policy
 * change needed. Wrapping at the provider boundary (not at the agent
 * loop or the renderer) means BOTH streaming and non-streaming code
 * paths get the same translation without a second touchpoint.
 */
class AnvilwingQuotaAwareProvider implements LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  private readonly inner: LLMProvider;

  constructor(inner: LLMProvider) {
    this.inner = inner;
    this.id = inner.id;
    this.model = inner.model;
  }

  async generate(
    messages: ConversationMessage[],
    tools: ProviderToolDefinition[],
  ): Promise<ProviderResponse> {
    try {
      return await this.inner.generate(messages, tools);
    } catch (error) {
      if (isAnvilwingQuotaError(error)) {
        throw buildAnvilwingQuotaError();
      }
      throw error;
    }
  }

  async *generateStream(
    messages: ConversationMessage[],
    tools: ProviderToolDefinition[],
  ): AsyncIterableIterator<StreamChunk> {
    if (!this.inner.generateStream) {
      const res = await this.generate(messages, tools);
      if (res.type === 'message') yield { type: 'content', content: res.content };
      if (res.usage) yield { type: 'usage', usage: res.usage };
      return;
    }
    try {
      yield* this.inner.generateStream(messages, tools);
    } catch (error) {
      if (isAnvilwingQuotaError(error)) {
        throw buildAnvilwingQuotaError();
      }
      throw error;
    }
  }

  getCapabilities(): ProviderCapabilities | undefined {
    return this.inner.getCapabilities?.();
  }

  async getModelInfo(): Promise<ProviderModelInfo | null> {
    return (await this.inner.getModelInfo?.()) ?? null;
  }
}

/**
 * Anvilwing Provider Plugin
 *
 * Registers the Anvilwing provider with hardened error handling for:
 * - Network failures (premature close, connection reset)
 * - Stream errors (gunzip, decompression failures)
 * - Rate limiting with exponential backoff
 * - Circuit breaker for cascading failure prevention
 * - Quota / balance exhaustion (402 Insufficient Balance) translation
 */
export function registerAnvilwingProviderPlugin(): void {
  if (registered) {
    return;
  }

  registerProvider('anvilwing', (config) => {
    // Bring-your-own-key: no API key ships in source and there's no login.
    // The user supplies ANVILWING_API_KEY via the env var or the /key
    // slash command in-shell; we error clearly if it's missing.
    const endpoint = resolveAnvilwingOptions();
    const windowInfo = getModelContextInfo(config.model);
    const baseProvider = new OpenAIChatCompletionsProvider({
      apiKey: endpoint.apiKey,
      model: config.model,
      baseURL: endpoint.baseURL,
      providerId: 'anvilwing',
      // Anvilwing timeout - extended to 24 hours to allow for complex reasoning and prevent step timeout errors
      timeout: 24 * 60 * 60 * 1000, // 24 hours per API call
      // ZERO inner retries: the ResilientProvider wrapper below is the SINGLE
      // retry authority (5 retries + circuit breaker + rate limiter). The old
      // maxRetries:3 here STACKED with the wrapper's 5 — a persistently
      // 'transient' failure re-sent the full (near-1M-token) prompt up to
      // 4×6 = 24 times, ~19MB of redundant upload per failed turn, and the
      // inner retries bypassed the 30-req/min rate limiter entirely.
      maxRetries: 0,
      // Deterministic agentic coding by default (matches the summarizer and
      // adversarial verifier, which already pin 0). Caller override wins.
      temperature: typeof config.temperature === 'number' ? config.temperature : 0,
      // Ask for the model's FULL documented output budget (384k tokens,
      // probe-verified accepted). The provider's old 4096 default silently
      // cut long responses — and since thinking counts inside max_tokens,
      // one long thought could starve the entire visible reply.
      maxTokens: typeof config.maxTokens === 'number' ? config.maxTokens : 384_000,
      // Size the request cap to the model's real window (chars ≈ tokens ×3.5)
      // instead of the generic 800k-char default, which capped the 1M-token
      // window at ~228k tokens and silently dropped mid-conversation history.
      requestCharLimit: Math.floor(windowInfo.contextWindow * 3.5),
    });

    // Translate balance-exhaustion errors at the provider boundary so the
    // user-visible message is identical regardless of whether the error
    // surfaces from streaming or non-streaming, retry layer or direct.
    const quotaAware = new AnvilwingQuotaAwareProvider(baseProvider);

    // Wrap with resilience layer for additional protection
    return withProviderResilience(quotaAware, 'anvilwing', {
      // Anvilwing has lower rate limits
      maxRequestsPerMinute: 30,
      // More aggressive retries for Anvilwing's connection issues
      maxRetries: 5,
      baseDelayMs: 2000,
      maxDelayMs: 60000,
      // Enable circuit breaker to prevent cascading failures
      enableCircuitBreaker: true,
      circuitBreakerThreshold: 5,
      circuitBreakerResetMs: 120000, // 2 minutes
    });
  });

  registered = true;
}

function resolveAnvilwingOptions(): { apiKey: string; baseURL: string } {
  // Bring-your-own-key: the user's own ANVILWING_API_KEY hits the API directly.
  const endpoint = resolveAnvilwingEndpoint();
  if (!endpoint.apiKey) {
    throw new Error(
      'No Anvilwing API key. Set yours with /key sk-… (or the ANVILWING_API_KEY env var).',
    );
  }
  return { apiKey: endpoint.apiKey, baseURL: endpoint.baseURL };
}
