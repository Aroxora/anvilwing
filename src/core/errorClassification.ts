/**
 * Canonical home for provider error classification (audit Rank 5, Phase 1).
 *
 * Behaviour-PRESERVING extraction: each call site's predicate + pattern set is
 * moved here VERBATIM under a site-specific name — NOT merged into a superset.
 * A superset would change which errors each provider retries or falls back on,
 * a behaviour change the audit Do-NOT list forbids ("don't ship a behaviour
 * change dressed as a refactor"). The providers import these and re-export under
 * their existing public names, so importers + tests are untouched. agent.ts's
 * classifier is a THIRD semantics (rate-limit + 5xx folded into "transient") and
 * is deliberately NOT folded in here yet (deferred per the roadmap).
 *
 * test/error-classification.test.ts pins every predicate against a battery of
 * real error shapes captured from the pre-extraction code, so any drift is red.
 */

// ════════════════════════════════════════════════════════════════════════════
// resilientProvider classifiers — LIVE (the fallback path in agentController +
// the retry loop in withProviderResilience). Patterns + logic verbatim.
// ════════════════════════════════════════════════════════════════════════════

export const RESILIENT_RATE_LIMIT_PATTERNS = [
  'rate limit',
  'rate_limit',
  'ratelimit',
  'too many requests',
  '429',
  'quota exceeded',
  'request limit',
  'throttled',
  'overloaded',
  'capacity',
];

export const RESILIENT_TRANSIENT_ERROR_PATTERNS = [
  'timeout',
  'timed out',
  'network',
  'connection',
  'econnrefused',
  'econnreset',
  'enotfound',
  'epipe',
  'econnaborted',
  'ehostunreach',
  'enetunreach',
  'socket',
  'temporarily unavailable',
  '502',
  '503',
  '504',
  'bad gateway',
  'service unavailable',
  'gateway timeout',
  'internal server error',
  '500',
  // Stream and fetch errors
  'premature close',
  'premature end',
  'unexpected end',
  'stream',
  'aborted',
  'fetcherror',
  'fetch error',
  'invalid response body',
  'response body',
  'gunzip',
  'decompress',
  'zlib',
  'content-encoding',
  'chunked encoding',
  'transfer-encoding',
  // SSL/TLS errors
  'ssl',
  'tls',
  'certificate',
  'cert',
  'handshake',
];

export const FALLBACK_ELIGIBLE_PATTERNS = [
  // Quota/billing errors
  'insufficient_quota',
  'quota exceeded',
  'exceeded your current quota',
  'billing',
  'payment required',
  'account suspended',
  'account disabled',
  // API key errors
  'api key expired',
  'api_key_invalid',
  'invalid api key',
  'invalid_api_key',
  'api key not valid',
  // Model availability errors
  'model not found',
  'model_not_found',
  'does not exist',
  'not available',
  'deprecated',
  'access denied',
  'permission denied',
  'unauthorized',
  '401',
  '403',
  '400',
  'invalid_argument',
  // Regional/access restrictions
  'region',
  'not supported in your',
  'country',
  'restricted',
];

/**
 * Check if an error warrants trying a different provider (fallback).
 * These are non-transient errors that won't be fixed by retrying the same provider.
 */
export function isFallbackEligibleError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();

  // Check message for fallback patterns
  if (FALLBACK_ELIGIBLE_PATTERNS.some(pattern => message.includes(pattern))) {
    return true;
  }

  // Check error code/type/reason if present (OpenAI and Google style errors).
  // The TypeScript types here are aspirational — provider SDKs throw errors
  // with `.status` as a number (HTTP code) or `.code`/`.type` as objects, so
  // every lookup must be coerced through String() before .toLowerCase() or
  // the whole error path crashes with `(...).toLowerCase is not a function`.
  // Bug seen in 1.1.7: a Anvilwing error's numeric `.status` killed the
  // submission flow on the first prompt of a fresh session.
  const errorWithCode = error as { code?: unknown; type?: unknown; reason?: unknown; status?: unknown };
  const code = String(errorWithCode.code ?? '').toLowerCase();
  const type = String(errorWithCode.type ?? '').toLowerCase();
  const reason = String(errorWithCode.reason ?? '').toLowerCase();
  const status = String(errorWithCode.status ?? '').toLowerCase();

  // OpenAI style errors
  if (code === 'insufficient_quota' || type === 'insufficient_quota') {
    return true;
  }
  if (code === 'model_not_found' || type === 'model_not_found') {
    return true;
  }
  if (code === 'invalid_api_key' || type === 'invalid_api_key') {
    return true;
  }

  // Google style errors
  if (reason === 'api_key_invalid' || status === 'invalid_argument') {
    return true;
  }
  if (code === '400' || code === '401' || code === '403') {
    return true;
  }

  return false;
}

/**
 * Get a user-friendly description of why fallback is needed
 */
export function getFallbackReason(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown error';
  const message = error.message.toLowerCase();

  if (message.includes('quota') || message.includes('billing')) {
    return 'API quota exceeded or billing issue';
  }
  if (message.includes('expired') || message.includes('api_key_invalid') || message.includes('api key')) {
    return 'API key expired or invalid';
  }
  if (message.includes('model') && (message.includes('not found') || message.includes('not exist'))) {
    return 'Model not available';
  }
  if (message.includes('unauthorized') || message.includes('401') || message.includes('invalid_api_key')) {
    return 'Invalid API key';
  }
  if (message.includes('403') || message.includes('permission') || message.includes('access denied')) {
    return 'Access denied';
  }
  if (message.includes('400') || message.includes('invalid_argument')) {
    return 'Invalid request or API key';
  }
  if (message.includes('region') || message.includes('country') || message.includes('restricted')) {
    return 'Regional restriction';
  }

  return 'Provider error';
}

export function isResilientRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return RESILIENT_RATE_LIMIT_PATTERNS.some(pattern => message.includes(pattern));
}

export function isResilientTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // Check message
  const message = error.message.toLowerCase();
  if (RESILIENT_TRANSIENT_ERROR_PATTERNS.some(pattern => message.includes(pattern))) {
    return true;
  }

  // Check error name/type (FetchError, AbortError, etc.)
  const errorName = error.name?.toLowerCase() ?? '';
  if (errorName.includes('fetch') || errorName.includes('abort') || errorName.includes('network')) {
    return true;
  }

  // Check error code if present (Node.js style)
  const errorCode = (error as { code?: string }).code?.toLowerCase() ?? '';
  if (errorCode && RESILIENT_TRANSIENT_ERROR_PATTERNS.some(pattern => errorCode.includes(pattern))) {
    return true;
  }

  // Check cause chain for nested errors
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    return isResilientTransientError(cause);
  }

  return false;
}

export function shouldRetryResilient(error: unknown): boolean {
  // Quota/billing/auth/model errors won't be fixed by retrying the SAME provider
  // — retrying just burns the budget (several attempts × exponential backoff =
  // minutes) before the agent can fall back to another model. Short-circuit them
  // to the fallback path. A generic 429 / throttle / overload is NOT
  // fallback-eligible, so genuine transient rate-limits still retry.
  if (isFallbackEligibleError(error)) {
    return false;
  }
  return isResilientRateLimitError(error) || isResilientTransientError(error);
}

// ════════════════════════════════════════════════════════════════════════════
// baseProvider classifiers — kept DISTINCT from the resilient set (e.g. base
// has no enotfound/ssl). Currently consumed only by tests + baseProvider's own
// withRetry default. Patterns + logic verbatim.
// ════════════════════════════════════════════════════════════════════════════

/** Patterns that indicate transient/retryable errors */
export const BASE_TRANSIENT_ERROR_PATTERNS = [
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
  '500',
  '502',
  '503',
  '504',
  'overloaded',
] as const;

/** Check if an error is transient and can be retried */
export function isBaseTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  const errorName = error.name?.toLowerCase() ?? '';
  const errorCode = (error as { code?: string }).code?.toLowerCase() ?? '';
  const allText = `${message} ${errorName} ${errorCode}`;

  return BASE_TRANSIENT_ERROR_PATTERNS.some((pattern) => allText.includes(pattern));
}

/** Check if an error is a rate limit error */
export function isBaseRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();

  // Check for common rate limit indicators
  if (
    message.includes('rate limit') ||
    message.includes('rate_limit') ||
    message.includes('too many requests') ||
    message.includes('429')
  ) {
    return true;
  }

  // Check for status code
  const status = (error as { status?: number }).status;
  return status === 429;
}

/** Check if an error is an authentication error */
export function isAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  const status = (error as { status?: number }).status;

  return (
    status === 401 ||
    status === 403 ||
    message.includes('unauthorized') ||
    message.includes('invalid api key') ||
    message.includes('authentication')
  );
}

// ════════════════════════════════════════════════════════════════════════════
// agent.ts classifiers — a THIRD semantics: isAgentTransientError folds rate
// limits + 5xx + "server error" INTO "transient" (the agent retries all of them
// the same way), unlike the base/resilient split. Kept distinct. Verbatim.
// ════════════════════════════════════════════════════════════════════════════

/** Check if an error is a context overflow error */
export function isContextOverflowError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('context length') ||
    message.includes('token') && (message.includes('limit') || message.includes('exceed') || message.includes('maximum')) ||
    message.includes('too long') ||
    message.includes('too many tokens') ||
    message.includes('max_tokens') ||
    message.includes('context window')
  );
}

/** Check if an error is transient/retryable from the agent loop's perspective
 *  (network issues, rate limits, AND server errors all fold into "transient"). */
export function isAgentTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();

  // Network errors (including streaming-specific termination patterns from undici/node-fetch)
  const networkPatterns = [
    'econnrefused', 'econnreset', 'enotfound', 'etimedout', 'epipe',
    'network error', 'connection error', 'fetch failed', 'socket hang up',
    'network is unreachable', 'connection refused', 'connection reset',
    // Streaming-specific: server closes connection mid-stream
    'premature close', 'premature end', 'unexpected end',
    'aborted', 'fetcherror', 'invalid response body',
  ];
  if (networkPatterns.some(p => message.includes(p))) {
    return true;
  }

  // Rate limit errors
  if (message.includes('rate limit') || message.includes('429') || message.includes('too many requests')) {
    return true;
  }

  // Server errors (5xx)
  if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('504')) {
    return true;
  }

  // Temporary service errors
  if (message.includes('service unavailable') || message.includes('temporarily unavailable') ||
      message.includes('overloaded') || message.includes('server error')) {
    return true;
  }

  return false;
}
