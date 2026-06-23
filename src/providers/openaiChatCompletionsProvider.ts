import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageCustomToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions.js';
import type { FunctionDefinition } from 'openai/resources/shared.js';
import type {
  ConversationMessage,
  LLMProvider,
  ProviderId,
  ProviderModelInfo,
  ProviderResponse,
  ProviderToolDefinition,
  ToolCallRequest,
  ProviderUsage,
  StreamChunk,
} from '../core/types.js';
import { sanitizeErrorMessage, safeErrorMessage } from '../core/secretStore.js';
import { logDebug } from '../utils/debugLogger.js';
import { securityValidator, securityLogger } from '../utils/securityUtils.js';

/**
 * Security utility for safe JSON parsing with protection against prototype pollution
 */
export function safeJSONParse<T = unknown>(
  json: string,
  options?: { maxDepth?: number; maxProperties?: number }
): T {
  const maxDepth = options?.maxDepth ?? 20;
  const maxProperties = options?.maxProperties ?? 1000;
  
  if (!json || typeof json !== 'string') {
    throw new Error('JSON must be a non-empty string');
  }
  
  // Drop a literal "__proto__" key during parse — the actual prototype-pollution
  // vector (JSON.parse otherwise leaves it as a benign own property and does NOT
  // set the prototype). The previous code regex-scrubbed "__proto__:" /
  // "constructor:" / "prototype:" out of the RAW JSON string, which CORRUPTED any
  // tool argument whose VALUE merely contained those tokens (e.g. JS source being
  // written to a file: `{ constructor: ... }`). Sanitizing the parsed structure
  // is correct and non-destructive.
  const parsed = JSON.parse(json, (key, value) => (key === '__proto__' ? undefined : value));
  enforceJsonLimits(parsed, maxDepth, maxProperties);
  return parsed as T;
}

/**
 * Iteratively walk a parsed JSON value and throw if it exceeds the depth or
 * total-property limits — a real DoS guard for untrusted model output.
 */
function enforceJsonLimits(root: unknown, maxDepth: number, maxProperties: number): void {
  let propertyCount = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (depth > maxDepth) {
      throw new Error(`JSON depth exceeds maximum allowed depth ${maxDepth}`);
    }
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        propertyCount++;
        if (propertyCount > maxProperties) {
          throw new Error(`JSON property count exceeds maximum ${maxProperties}`);
        }
        stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
      }
    }
  }
}

/**
 * Validate and sanitize URL for OpenAI baseURL
 */
function validateOpenAIBaseURL(url: string): string {
  if (!url || typeof url !== 'string') {
    throw new Error('Base URL must be a non-empty string');
  }
  
  url = url.trim();
  
  // Must start with http:// or https://
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error(`Invalid baseURL format: ${url}. Must start with http:// or https://`);
  }
  
  // Parse URL to validate format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    throw new Error(`Invalid URL format: ${url}`);
  }
  
  // Single-provider product: anvilwing only. The official endpoint plus a
  // local-proxy escape hatch (localhost) for development; anything else trips
  // the warning below. (ANVILWING_BASE_URL can still point at a self-hosted
  // anvilwing-compatible gateway — it just won't be on the silent allowlist.)
  const allowedDomains = [
    'api.deepseek.com',
    'localhost',
    '127.0.0.1',
  ];
  
  const hostname = parsedUrl.hostname;
  const isAllowed = allowedDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  
  if (!isAllowed) {
    console.warn(`SECURITY: Using non-standard OpenAI baseURL: ${hostname}. This could be a security risk.`);
    // Allow but log warning for custom deployments, Azure, etc.
  }
  
  // Enforce HTTPS for production-like domains
  if (hostname.includes('openai.com') && parsedUrl.protocol !== 'https:') {
    throw new Error(`OpenAI API requires HTTPS for domain ${hostname}`);
  }
  
  return url;
}

const REQUEST_CHAR_LIMIT = 800_000; // Hard cap to avoid provider 413 errors

// ============================================================================
// Stream/Fetch Error Types for Detection
// ============================================================================

/**
 * Error types that indicate stream or network failures that should be retried
 */
const RECOVERABLE_ERROR_PATTERNS = [
  'premature close',
  'premature end',
  'unexpected end',
  'aborted',
  'fetcherror',
  'invalid response body',
  'gunzip',
  'decompress',
  'econnreset',
  'econnrefused',
  'epipe',
  'socket hang up',
  'network',
  'timeout',
] as const;

/**
 * Custom error class for provider-specific failures
 */
export class ProviderStreamError extends Error {
  readonly isRetryable: boolean;
  readonly originalError?: Error;
  readonly providerId: string;

  constructor(message: string, providerId: string, originalError?: Error, isRetryable = true) {
    // SECURITY: Sanitize the error message to prevent token leakage
    super(sanitizeErrorMessage(message));
    this.name = 'ProviderStreamError';
    this.providerId = providerId;
    this.originalError = originalError;
    this.isRetryable = isRetryable;

    // SECURITY: Sanitize stack trace to prevent token leakage
    if (originalError?.stack) {
      this.stack = `${this.stack}\nCaused by: ${sanitizeErrorMessage(originalError.stack)}`;
    }
  }
}

/**
 * Basic API key validation for non-OpenAI providers (Anvilwing, xAI, etc.)
 * Only checks that a key exists and has reasonable format - no OpenAI-specific validation
 */
function validateGenericApiKey(apiKey: string): string {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('API key is required and must be a string');
  }

  const trimmed = apiKey.trim();
  if (trimmed.length < 10) {
    throw new Error('API key is too short');
  }

  // Just log that we're using a custom provider key
  const redactedKey = trimmed.length > 8 ? `${trimmed.substring(0, 4)}...${trimmed.substring(trimmed.length - 4)}` : '[REDACTED]';
  logDebug(`[SECURITY] Using custom provider API key (redacted: ${redactedKey})`);

  return trimmed;
}

/**
 * Security audit: OpenAI API key validation and protection
 * Enhanced with comprehensive validation and security controls
 */
function validateAndProtectApiKey(apiKey: string): string {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('OpenAI API key is required and must be a string');
  }
  
  // Remove whitespace
  apiKey = apiKey.trim();
  
  // Comprehensive format validation
  const validation = validateOpenAIKeyFormat(apiKey);
  if (!validation.isValid) {
    throw new Error(`Invalid OpenAI API key: ${validation.reason}`);
  }
  
  // Security logging (redacted)
  const redactedKey = apiKey.length > 8 ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : '[REDACTED]';
  logDebug(`[SECURITY] Using OpenAI API key (type: ${validation.keyType}, redacted: ${redactedKey})`);
  
  return apiKey;
}

/**
 * Comprehensive OpenAI key format validation
 */
function validateOpenAIKeyFormat(apiKey: string): {
  isValid: boolean;
  reason?: string;
  keyType: 'standard' | 'project' | 'organization' | 'unknown';
} {
  // Length validation
  if (apiKey.length < 40 || apiKey.length > 200) {
    return { isValid: false, reason: `Invalid key length: ${apiKey.length} chars (expected 40-200)`, keyType: 'unknown' };
  }
  
  // Character validation (alphanumeric, dashes, underscores only)
  const validChars = /^[a-zA-Z0-9\-_]+$/;
  if (!validChars.test(apiKey)) {
    return { isValid: false, reason: 'Key contains invalid characters', keyType: 'unknown' };
  }
  
  // OpenAI key format patterns
  if (apiKey.startsWith('sk-proj-')) {
    // Project key format: sk-proj-xxxxxxxxxxxxxxxxxxxxxxxx
    if (apiKey.length !== 51) {
      return { isValid: false, reason: `Project key should be 51 chars, got ${apiKey.length}`, keyType: 'project' };
    }
    return { isValid: true, keyType: 'project' };
  }
  
  if (apiKey.startsWith('sk-')) {
    // Standard key format: sk-xxxxxxxxxxxxxxxxxxxxxxxx
    if (apiKey.length !== 51) {
      return { isValid: false, reason: `Standard key should be 51 chars, got ${apiKey.length}`, keyType: 'standard' };
    }
    return { isValid: true, keyType: 'standard' };
  }
  
  if (apiKey.startsWith('org-')) {
    // Organization key format: org-xxxxxxxxxxxxxxxxxxxxxxxx
    if (apiKey.length < 40 || apiKey.length > 100) {
      return { isValid: false, reason: `Organization key length ${apiKey.length} outside expected range`, keyType: 'organization' };
    }
    return { isValid: true, keyType: 'organization' };
  }
  
  // Unknown format but might be valid (custom deployments, Azure, etc.)
  console.warn(`Unrecognized OpenAI API key format: ${apiKey.substring(0, 12)}...`);
  return { isValid: true, keyType: 'unknown' };
}

/**
 * Check if an error is recoverable (should be retried)
 */
function isRecoverableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  const errorName = error.name?.toLowerCase() ?? '';
  const errorCode = (error as { code?: string }).code?.toLowerCase() ?? '';

  // Check all sources for recoverable patterns
  const allText = `${message} ${errorName} ${errorCode}`;

  return RECOVERABLE_ERROR_PATTERNS.some(pattern => allText.includes(pattern));
}

// ============================================================================
// Provider Configuration
// ============================================================================

interface OpenAIChatCompletionsOptions {
  apiKey: string;
  model: string;
  providerId?: ProviderId;
  baseURL?: string;
  /** Request timeout in milliseconds (default: 120000) */
  timeout?: number;
  /** Maximum retries for transient errors (default: 3) */
  maxRetries?: number;
  /** Optional temperature override */
  temperature?: number;
  /** Maximum completion tokens to request (default: 4096 to avoid runaway outputs) */
  maxTokens?: number;
  /** Serialized-request char cap before oldest-first trimming (default 800k).
   *  Callers that know the model's real window pass a window-derived value —
   *  the fixed default silently capped anvilwing-v4's 1M-token window at
   *  ~228k tokens. */
  requestCharLimit?: number;
  /** Custom fetch — e.g. to inject a dynamic Authorization header for a proxy. */
  fetchImpl?: typeof fetch;
  /** Disable SSE streaming: generateStream delegates to one generate() call.
   *  For proxies (the Anvilwing Lambda) that reject `stream: true`. */
  disableStreaming?: boolean;
}

type ChatCompletionsResult = Awaited<ReturnType<OpenAI['chat']['completions']['create']>>;

export class OpenAIChatCompletionsProvider implements LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  private readonly client: OpenAI;
  private readonly maxRetries: number;
  private readonly temperature?: number;
  private readonly maxTokens: number;
  private readonly requestCharLimit: number;
  private readonly disableStreaming: boolean;
  private readonly requestCount: number = 0;
  private readonly lastRequestTime: number = Date.now();
  
  constructor(options: OpenAIChatCompletionsOptions) {
    // SECURITY: Validate API key - skip OpenAI-specific format checks for custom providers
    const isCustomProvider = !!options.baseURL;
    const validatedApiKey = isCustomProvider
      ? validateGenericApiKey(options.apiKey)
      : validateAndProtectApiKey(options.apiKey);
    
    // SECURITY: Log security event
    securityLogger.logSecurityEvent({
      type: 'openai_provider_initialized',
      command: 'constructor',
      success: true,
      timestamp: new Date(),
      details: {
        model: options.model,
        providerId: options.providerId,
        hasBaseURL: !!options.baseURL
      }
    });
    
    const clientConfig: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: validatedApiKey,
      timeout: options.timeout ?? 120000,
      maxRetries: 0, // We handle retries ourselves for better control
    };

    if (options.fetchImpl) {
      // Lets a proxy inject a dynamic Authorization header per request.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (clientConfig as any).fetch = options.fetchImpl;
    }

    if (options.baseURL) {
      // SECURITY: Enhanced URL validation with domain restrictions
      try {
        clientConfig.baseURL = validateOpenAIBaseURL(options.baseURL);
        logDebug(`[SECURITY] Using validated baseURL: ${clientConfig.baseURL}`);
      } catch (error) {
        securityLogger.logSecurityEvent({
          type: 'invalid_baseurl',
          command: 'constructor',
          success: false,
          timestamp: new Date(),
          details: { error: error instanceof Error ? error.message : String(error) }
        });
        throw new Error(`Invalid baseURL: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.client = new OpenAI(clientConfig);
    this.id = options.providerId ?? 'openai';
    this.model = options.model;
    this.maxRetries = options.maxRetries ?? 3;
    this.temperature = typeof options.temperature === 'number' ? options.temperature : undefined;
    this.maxTokens = Math.max(1, options.maxTokens ?? 4096);
    this.requestCharLimit = Math.max(1, options.requestCharLimit ?? REQUEST_CHAR_LIMIT);
    this.disableStreaming = options.disableStreaming ?? false;
  }

  /**
   * Sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Calculate exponential backoff delay
   */
  private getBackoffDelay(attempt: number, baseDelay = 1000, maxDelay = 30000): number {
    const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
    // Add jitter to prevent thundering herd
    return delay + Math.random() * delay * 0.1;
  }

  /**
   * Execute request with retry logic for transient errors
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if this is a recoverable error
        if (isRecoverableError(error) && attempt < this.maxRetries) {
          const delay = this.getBackoffDelay(attempt);
          // SECURITY: Sanitize error message to prevent token leakage
          logDebug(
            `[${this.id}] ${operationName} failed (attempt ${attempt + 1}/${this.maxRetries + 1}): ` +
            `${safeErrorMessage(lastError)}. Retrying in ${Math.round(delay)}ms...`
          );
          await this.sleep(delay);
          continue;
        }

        // Non-recoverable error or out of retries
        throw new ProviderStreamError(
          `${operationName} failed after ${attempt + 1} attempts: ${lastError.message}`,
          this.id,
          lastError,
          isRecoverableError(error)
        );
      }
    }

    // Should not reach here, but TypeScript needs this
    throw lastError;
  }

  async generate(messages: ConversationMessage[], tools: ProviderToolDefinition[]): Promise<ProviderResponse> {
    const { messages: boundedMessages } = enforceRequestSizeLimit(messages, this.requestCharLimit);

    return this.executeWithRetry(async () => {
      const extraBody = anvilwingExtraBody(this.model, this.maxTokens);
      const request: Parameters<OpenAI['chat']['completions']['create']>[0] = {
        model: this.model,
        messages: mapMessages(boundedMessages, this.model),
        tools: tools.length ? tools.map(mapTool) : undefined,
        // Force tool usage when tools are available - prevents text-only rambling
        tool_choice: tools.length ? 'auto' : undefined,
        // Enable multiple tool calls in a single response
        parallel_tool_calls: tools.length ? true : undefined,
        stream: false,
        // Guardrails: enforce temperature and output cap to prevent runaway responses
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        ...(extraBody ?? {}),
      };

      let completion: ChatCompletion;

      try {
        const result = await this.client.chat.completions.create(request);
        assertHasChoices(result);
        completion = result;
      } catch (error) {
        // Wrap and rethrow with more context
        if (error instanceof Error) {
          // Check for specific API error types
          const apiError = error as { status?: number; code?: string };

          if (apiError.status === 401) {
            throw new ProviderStreamError(
              `Authentication failed for ${this.id}. Check your API key.`,
              this.id,
              error,
              false // Not retryable
            );
          }

          if (apiError.status === 403) {
            throw new ProviderStreamError(
              `Access forbidden for ${this.id}. Check your permissions.`,
              this.id,
              error,
              false // Not retryable
            );
          }

          // Let recoverable errors propagate for retry
          if (isRecoverableError(error)) {
            throw error;
          }

          // Wrap other errors
          throw new ProviderStreamError(
            `API request failed: ${error.message}`,
            this.id,
            error,
            false
          );
        }
        throw error;
      }

      const choice = completion.choices[0];
      const usage = mapUsage(completion.usage);

      if (!choice) {
        return {
          type: 'message',
          content: '',
          usage,
        };
      }

      // Safely extract tool calls with error recovery
      let toolCalls: ToolCallRequest[] = [];
      try {
        toolCalls = (choice.message.tool_calls ?? []).map(mapToolCall);
      } catch (parseError) {
        // SECURITY: Sanitize error message to prevent token leakage
        logDebug(
          `[${this.id}] Failed to parse tool calls, recovering: ` +
          `${safeErrorMessage(parseError)}`
        );
        // Continue with empty tool calls rather than failing
      }

      const content = extractMessageContent(choice);

      // Surface output-cap truncation instead of swallowing it: a 'length'
      // finish means the reply was cut by max_tokens and MUST NOT be
      // persisted as a complete turn without upper layers being able to tell.
      const stopReason = choice.finish_reason === 'length' ? ('max_tokens' as const) : undefined;

      if (toolCalls.length > 0) {
        return {
          type: 'tool_calls',
          toolCalls,
          content,
          usage,
          ...(stopReason ? { stopReason } : {}),
        };
      }

      return {
        type: 'message',
        content,
        usage,
        ...(stopReason ? { stopReason } : {}),
      };
    }, 'generate');
  }

  async *generateStream(
    messages: ConversationMessage[],
    tools: ProviderToolDefinition[]
  ): AsyncIterableIterator<StreamChunk> {
    // Non-streaming proxy mode: the Anvilwing Lambda proxy rejects stream:true,
    // so satisfy the streaming interface by running one non-streaming
    // generate() and emitting its result as chunks.
    if (this.disableStreaming) {
      const result = await this.generate(messages, tools);
      if (result.content) yield { type: 'content', content: result.content };
      if (result.type === 'tool_calls') {
        for (const toolCall of result.toolCalls) yield { type: 'tool_call', toolCall };
      }
      if (result.usage) yield { type: 'usage', usage: result.usage };
      yield result.type === 'message' && result.stopReason
        ? { type: 'done', stopReason: result.stopReason }
        : { type: 'done' };
      return;
    }

    const { messages: boundedMessages } = enforceRequestSizeLimit(messages, this.requestCharLimit);

    const extraBody = anvilwingExtraBody(this.model, this.maxTokens);
    const request: Parameters<OpenAI['chat']['completions']['create']>[0] = {
      model: this.model,
      messages: mapMessages(boundedMessages, this.model),
      tools: tools.length ? tools.map(mapTool) : undefined,
      // Force tool usage when tools are available - prevents text-only rambling
      tool_choice: tools.length ? 'auto' : undefined,
      // Enable multiple tool calls in a single response
      parallel_tool_calls: tools.length ? true : undefined,
      stream: true,
      // Without this, OpenAI-compatible streams (Anvilwing included) never send
      // a usage chunk, so live token metering has nothing exact to snap to.
      stream_options: { include_usage: true },
      // Guardrails: enforce temperature and output cap to prevent runaway responses
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      ...(extraBody ?? {}),
    };

    const response = await this.client.chat.completions.create(request);

    // TypeScript needs help knowing this is a stream when stream: true
    if (!Symbol.asyncIterator || !((response as AsyncIterable<unknown>)[Symbol.asyncIterator])) {
      throw new Error('Expected streaming response but got non-streaming');
    }

    const stream = response as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

    // Track tool calls being built (by index)
    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let usageEmitted = false;

    for await (const chunk of stream) {
      // include_usage delivers usage either on the finish chunk (Anvilwing) or
      // on a trailing chunk whose choices array is empty (OpenAI) — emit it
      // here, before the choices guard, exactly once. The guard matters: a
      // provider that sends usage on BOTH the finish chunk and a trailing
      // usage-only chunk would otherwise double-count the live token meter.
      if (!usageEmitted && 'usage' in chunk && chunk.usage) {
        usageEmitted = true;
        const usage = chunk.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        yield {
          type: 'usage',
          usage: {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          },
        };
      }

      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta as Record<string, unknown>;

      // Stream reasoning_content for models like anvilwing so users see progress
      const reasoning = extractTextContent(delta['reasoning_content']);
      if (reasoning) {
        yield { type: 'reasoning', content: reasoning };
      }

      // Handle content chunks (support both string and array formats)
      const content = extractTextContent(delta['content']);
      if (content) {
        yield { type: 'content', content };
      }

      // Handle tool call deltas
      const toolCalls = delta['tool_calls'] as Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }> | undefined;
      if (toolCalls) {
        for (const toolCallDelta of toolCalls) {
          const idx = toolCallDelta.index;

          if (!pendingToolCalls.has(idx)) {
            pendingToolCalls.set(idx, {
              id: toolCallDelta.id ?? `call_${idx}`,
              name: toolCallDelta.function?.name ?? '',
              arguments: '',
            });
          }

          const pending = pendingToolCalls.get(idx)!;

          // Accumulate function name if provided
          if (toolCallDelta.function?.name) {
            pending.name = toolCallDelta.function.name;
          }

          // Accumulate arguments with size limit
          if (toolCallDelta.function?.arguments) {
            // SECURITY: Limit accumulated arguments size to prevent memory DoS
            if (pending.arguments.length + toolCallDelta.function.arguments.length > 100000) {
              throw new Error(`Tool call arguments too large (${pending.arguments.length + toolCallDelta.function.arguments.length} bytes), maximum is 100KB`);
            }
            pending.arguments += toolCallDelta.function.arguments;
          }
        }
      }

      // Check if stream is done
      if (choice.finish_reason) {
        // Emit all accumulated tool calls
        for (const [, toolCall] of pendingToolCalls) {
          let parsed: Record<string, unknown> = {};
          try {
            // SECURITY: Use safe JSON parsing with prototype pollution protection
            parsed = safeJSONParse<Record<string, unknown>>(toolCall.arguments || '{}', {
              // Match the non-streaming path's limits — the same tool call must
              // not parse non-streamed yet be rejected when streamed.
              maxDepth: 15,
              maxProperties: 500
            });
          } catch (parseError) {
            // Try recovery for malformed JSON
            const recovered = tryRecoverMalformedJson(toolCall.arguments);
            if (recovered) {
              parsed = recovered;
            } else {
              logDebug(`[SECURITY] Failed to parse tool call arguments: ${safeErrorMessage(parseError)}`);
            }
          }

          yield {
            type: 'tool_call',
            toolCall: {
              id: toolCall.id,
              name: toolCall.name,
              arguments: parsed,
            },
          };
        }

        // 'length' = the reply was cut by max_tokens; carry it on the done
        // chunk so the agent can tell a truncated turn from a complete one.
        yield choice.finish_reason === 'length'
          ? { type: 'done', stopReason: 'max_tokens' }
          : { type: 'done' };
      }
    }
  }

  private cachedModelInfo: ProviderModelInfo | null = null;

  /**
   * Fetch model info from OpenAI API
   * Returns context window and token limits from the real API
   */
  async getModelInfo(): Promise<ProviderModelInfo | null> {
    if (this.cachedModelInfo) {
      return this.cachedModelInfo;
    }

    try {
      // Use the OpenAI models API to get real model info
      const modelInfo = await this.client.models.retrieve(this.model);

      if (modelInfo) {
        // OpenAI models API returns context_length or similar field
        // The exact field name may vary by model
        const rawInfo = modelInfo as unknown as Record<string, unknown>;
        const contextWindow =
          rawInfo['context_length'] as number | undefined ??
          rawInfo['context_window'] as number | undefined ??
          rawInfo['max_context_length'] as number | undefined;

        const maxOutputTokens =
          rawInfo['max_output_tokens'] as number | undefined ??
          rawInfo['output_token_limit'] as number | undefined;

        if (contextWindow) {
          this.cachedModelInfo = {
            id: this.model,
            contextWindow,
            maxOutputTokens,
            inputTokenLimit: contextWindow,
            outputTokenLimit: maxOutputTokens,
          };
          return this.cachedModelInfo;
        }
      }
    } catch (error) {
      // Models API may not be available for all models
      // Fall through to return null
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('404') && !message.includes('not found')) {
        // Log unexpected errors but don't fail
        logDebug(`Failed to fetch model info for ${this.model}:`, message);
      }
    }

    return null;
  }
}

function isAnvilwingModel(model?: string): boolean {
  if (!model) return false;
  const normalized = model.toLowerCase();
  return normalized.includes('anvilwing');
}

/**
 * Anvilwing V4 (anvilwing / anvilwing-v4-flash and legacy aliases that
 * forward to V4) accepts a per-request `thinking` toggle. We always force
 * thinking on — the API has no useful non-thinking mode for an agent loop.
 * Sent via extra_body so the OpenAI SDK passes it through unchanged.
 *
 * Budget sizing (probed against the live API, 2026-06-12): thinking tokens
 * COUNT INSIDE max_tokens (max_tokens=16 + budget 32768 → finish_reason
 * 'length' with 16 reasoning tokens and EMPTY content), and over-ceiling
 * budgets are accepted/clamped server-side. So the budget tracks the
 * request's max_tokens with a reserve carved out for the visible reply —
 * a fixed 32768 budget next to the old 4096-token max_tokens let one long
 * thought starve the entire answer.
 */
const THINKING_OUTPUT_RESERVE = 65_536;
function anvilwingExtraBody(model?: string, maxTokens?: number): Record<string, unknown> | undefined {
  if (!isAnvilwingModel(model)) return undefined;
  const cap = typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 4096;
  const budget = Math.max(1024, Math.min(383_999, cap - THINKING_OUTPUT_RESERVE));
  return { thinking: { type: 'enabled', budget_tokens: budget } };
}


/**
 * Validate and sanitize message sequence to ensure tool messages have preceding tool_calls.
 * OpenAI/Anvilwing APIs require: "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
 */
export function sanitizeMessageSequence(messages: ConversationMessage[]): ConversationMessage[] {
  const sanitized: ConversationMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;

    if (message.role === 'assistant' && message.toolCalls?.length) {
      // An assistant turn with tool_calls must be IMMEDIATELY followed by a
      // tool reply for EVERY id. Consume the contiguous tool replies, then
      // backfill a placeholder for any id that never got one — otherwise the
      // request 400s ("assistant tool_calls must be followed by tool messages
      // responding to each tool_call_id"). Reachable when a parallel tool call
      // is interrupted (Esc) or crashes before recording its result, or a
      // session is snapshotted mid-tool-execution and resumed.
      sanitized.push(message);
      const want = new Set(message.toolCalls.map((tc) => tc.id).filter(Boolean));
      let j = i + 1;
      while (j < messages.length && messages[j]!.role === 'tool') {
        const reply = messages[j] as ConversationMessage & { toolCallId?: string };
        if (reply.toolCallId && want.has(reply.toolCallId)) {
          want.delete(reply.toolCallId);
          sanitized.push(reply);
        } else {
          // duplicate or unmatched reply in this run — drop (orphan direction)
          logDebug(`[mapMessages] Skipping orphaned tool message (no preceding tool_call): ${reply.toolCallId?.slice(0, 20) || 'no-id'}`);
        }
        j++;
      }
      for (const orphanedId of want) {
        const call = message.toolCalls.find((tc) => tc.id === orphanedId);
        const toolName = call?.name ?? 'tool';
        sanitized.push({
          role: 'tool',
          name: toolName,
          toolCallId: orphanedId,
          content: `[No result: ${toolName} produced no output — execution was interrupted or did not complete.]`,
        } as ConversationMessage);
      }
      i = j - 1; // skip the tool replies we just consumed
    } else if (message.role === 'tool') {
      // A tool reply NOT preceded by an assistant-with-tool_calls in this pass
      // is orphaned (its tool_call was pruned/compacted away). Drop it.
      const toolCallId = (message as ConversationMessage & { toolCallId?: string }).toolCallId;
      logDebug(`[mapMessages] Skipping orphaned tool message (no preceding tool_call): ${toolCallId?.slice(0, 20) || 'no-id'}`);
    } else {
      // system, user, assistant-without-tool_calls — pass through
      sanitized.push(message);
    }
  }

  return sanitized;
}

function mapMessages(messages: ConversationMessage[], model?: string): ChatCompletionMessageParam[] {
  // CRITICAL: Sanitize message sequence to prevent "tool must follow tool_calls" errors
  const sanitizedMessages = sanitizeMessageSequence(messages);

  const params: ChatCompletionMessageParam[] = [];

  for (const message of sanitizedMessages) {
    switch (message.role) {
      case 'system':
      case 'user': {
        params.push({
          role: message.role,
          content: message.content,
        });
        break;
      }
      case 'assistant': {
        // Replay assistant turns as content + tool_calls ONLY. The old code
        // also set `reasoning_content = message.content` on every replayed
        // turn — an exact echo of the final answer (not real reasoning, which
        // is streamed and discarded). Probed 2026-06-12: anvilwing does
        // NOT reject reasoning_content in input, so this was pure waste —
        // ~2× the assistant-text bytes on EVERY request, compounding across a
        // long multi-hour session's hundreds of replayed turns.
        params.push({
          role: 'assistant',
          content: message.content,
          tool_calls: message.toolCalls?.map((call, index) => ({
            id: call.id || `call_${index}`,
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments ?? {}),
            },
          })),
        });
        break;
      }
      case 'tool': {
        params.push({
          role: 'tool',
          content: message.content,
          tool_call_id: message.toolCallId,
        });
        break;
      }
      default:
        break;
    }
  }

  return params;
}

function mapTool(definition: ProviderToolDefinition): ChatCompletionTool {
  const parameters = (definition.parameters ?? {
    type: 'object',
    properties: {},
  }) as FunctionDefinition['parameters'];

  return {
    type: 'function',
    function: {
      name: definition.name,
      description: definition.description,
      parameters,
      // Enable strict schema validation for more reliable tool calls
      strict: false, // Set to false to allow flexible schemas; true requires additionalProperties: false
    },
  };
}

/**
 * Enforce a hard request size limit to prevent provider 413 errors.
 * Drops the oldest non-system messages until the serialized size is under limit.
 */
function enforceRequestSizeLimit(
  messages: ConversationMessage[],
  limit: number = REQUEST_CHAR_LIMIT,
): { messages: ConversationMessage[]; truncated: boolean } {
  let truncated = false;
  const trimmed = [...messages];
  let size = estimateMessageChars(trimmed);

  while (size > limit && trimmed.length > 1) {
    // Remove the oldest non-system message; if only systems remain, drop the second message
    const removeIdx = trimmed.findIndex(msg => msg.role !== 'system');
    const idx = removeIdx === -1 ? 1 : removeIdx;
    trimmed.splice(idx, 1);
    truncated = true;
    size = estimateMessageChars(trimmed);
  }

  if (truncated) {
    // Insert the notice AFTER the leading system block, not at index 0:
    // unshifting a new first message shifts the whole prompt prefix and
    // destroys provider prefix-cache reuse (the ~99% cache-hit discount the
    // cost model depends on).
    let insertAt = 0;
    while (insertAt < trimmed.length && trimmed[insertAt]?.role === 'system') insertAt++;
    trimmed.splice(insertAt, 0, {
      role: 'system',
      content: '[Context trimmed to fit request size limit. Earlier turns were dropped to avoid provider rejection.]',
    });
    logDebug(`[request-size] trimmed history to ~${limit} chars (oldest-first)`);
  }

  return { messages: trimmed, truncated };
}

function estimateMessageChars(messages: ConversationMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<unknown>) {
        if (typeof part === 'string') {
          total += part.length;
        } else if (part && typeof part === 'object' && 'text' in (part as Record<string, unknown>)) {
          const text = (part as { text?: string }).text ?? '';
          total += typeof text === 'string' ? text.length : String(text).length;
        } else {
          total += JSON.stringify(part ?? '').length;
        }
      }
    } else if (msg.content != null) {
      total += JSON.stringify(msg.content).length;
    }

    const toolCalls = (msg as { toolCalls?: Array<{ name?: string; arguments?: unknown }> }).toolCalls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        total += (call.name?.length ?? 0);
        try {
          total += JSON.stringify(call.arguments ?? {}).length;
        } catch {
          total += 100; // Fallback small cost
        }
      }
    }
  }
  return total;
}

function extractMessageContent(choice: ChatCompletion.Choice): string {
  const message = choice.message;
  const content = extractTextContent(message?.content);

  if (content.trim()) {
    return content.trim();
  }

  const reasoning = extractTextContent((message as { reasoning_content?: unknown })?.reasoning_content);
  if (reasoning.trim()) {
    return reasoning.trim();
  }

  const refusal = message?.refusal;
  if (typeof refusal === 'string' && refusal.trim()) {
    return refusal.trim();
  }

  return '';
}

function isFunctionToolCall(call: ChatCompletionMessageToolCall): call is ChatCompletionMessageFunctionToolCall {
  return call.type === 'function';
}

function isCustomToolCall(call: ChatCompletionMessageToolCall): call is ChatCompletionMessageCustomToolCall {
  return call.type === 'custom';
}

function mapToolCall(call: ChatCompletionMessageToolCall): ToolCallRequest {
  let parsed: Record<string, unknown> = {};
  let rawArgs: string;
  let funcName: string;

  // Handle both standard function calls and custom tool calls
  if (isFunctionToolCall(call)) {
    rawArgs = call.function.arguments ?? '{}';
    funcName = call.function.name ?? call.id ?? 'unknown';
  } else if (isCustomToolCall(call)) {
    rawArgs = call.custom.input ?? '{}';
    funcName = call.custom.name ?? call.id ?? 'unknown';
  } else {
    // Fallback for any future tool call types
    rawArgs = '{}';
    funcName = (call as { id?: string }).id ?? 'unknown';
  }

  try {
    // SECURITY: Validate JSON size before parsing to prevent DoS anomalys
    if (rawArgs.length > 100000) {
      throw new Error(`JSON too large (${rawArgs.length} bytes), maximum is 100KB`);
    }
    
    // SECURITY: Check for potential malicious patterns before parsing
    if (rawArgs.includes('__proto__') || rawArgs.includes('constructor') || rawArgs.includes('prototype')) {
      logDebug(`[security] Suspicious pattern detected in tool call arguments for ${funcName}`);
    }
    
    // SECURITY: Use safe JSON parsing instead of plain JSON.parse
    parsed = safeJSONParse<Record<string, unknown>>(rawArgs, {
      maxDepth: 15,
      maxProperties: 500
    });
  } catch (error) {
    // Try to recover malformed JSON (common with some models)
    const recovered = tryRecoverMalformedJson(rawArgs);
    if (recovered) {
      parsed = recovered;
    } else {
      // SECURITY: Sanitize raw args to prevent token leakage (they could contain API keys in malformed requests)
      const sanitizedArgs = sanitizeErrorMessage(rawArgs.slice(0, 100));
      logDebug(`[tool-call] Failed to parse arguments for ${funcName}: ${sanitizedArgs}...`);
    }
  }

  return {
    id: call.id ?? funcName,
    name: funcName,
    arguments: parsed,
  };
}

/**
 * Try to recover malformed JSON from tool call arguments.
 * Some models return truncated or malformed JSON that can be fixed.
 */
function tryRecoverMalformedJson(raw: string): Record<string, unknown> | null {
  if (!raw || !raw.trim()) {
    return null;
  }

  const attempts = [
    // Try adding missing closing braces/quotes
    `${raw  }"}`,
    `${raw  }}`,
    `${raw  }"` + `}`,
    `${raw  }"}}`,
    `${raw  }}}`,
  ];

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed;
      }
    } catch {
      // Continue to next attempt
    }
  }

  // Try regex extraction as last resort
  try {
    const pairs = raw.matchAll(/"([^"]+)":\s*(?:"([^"]*)"?|(\d+(?:\.\d+)?)|(\btrue\b|\bfalse\b|\bnull\b))/g);
    const result: Record<string, unknown> = {};

    for (const match of pairs) {
      const [, key, strVal, numVal, boolVal] = match;
      if (key) {
        if (strVal !== undefined) {
          result[key] = strVal;
        } else if (numVal) {
          result[key] = numVal.includes('.') ? parseFloat(numVal) : parseInt(numVal, 10);
        } else if (boolVal) {
          result[key] = boolVal === 'true' ? true : boolVal === 'false' ? false : null;
        }
      }
    }

    if (Object.keys(result).length > 0) {
      return result;
    }
  } catch {
    // Regex extraction failed
  }

  return null;
}

/**
 * Normalize OpenAI content parts into plain text.
 * Supports both legacy string content and the newer array-of-parts format.
 */
function extractTextContent(content: unknown): string {
  if (!content) {
    return '';
  }

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object') {
          const { text, content: nestedContent } = part as { text?: unknown; content?: unknown };
          if (typeof text === 'string') return text;
          if (typeof nestedContent === 'string') return nestedContent;
        }
        return '';
      })
      .join('');
  }

  if (content && typeof content === 'object') {
    const { text, content: nestedContent } = content as { text?: unknown; content?: unknown };
    if (typeof text === 'string') return text;
    if (typeof nestedContent === 'string') return nestedContent;
  }

  return '';
}

function mapUsage(usage?: ChatCompletion['usage'] | null): ProviderUsage | null {
  if (!usage) {
    return null;
  }

  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

function assertHasChoices(result: ChatCompletionsResult): asserts result is ChatCompletion {
  if (!('choices' in result)) {
    throw new Error('Streaming responses are not supported in this runtime.');
  }
}
