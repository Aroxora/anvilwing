import { sleep } from './asyncUtils.js';

export interface ErrorDetails {
  message: string;
  code?: string;
  context?: Record<string, unknown>;
  stack?: string;
  timestamp: string;
}

const RETRYABLE_KEYWORDS = [
  'timeout',
  'network',
  'rate limit',
  'too many requests',
  'service unavailable',
];

function deriveErrorCode(error: Error): string | undefined {
  if (error.name && error.name !== 'Error') {
    return error.name.toUpperCase();
  }

  const normalized = error.message
    .trim()
    .replace(/[^\w]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

  return normalized || undefined;
}

export function createErrorDetails(
  error: unknown,
  context?: Record<string, unknown>
): ErrorDetails {
  const timestamp = new Date().toISOString();

  if (error instanceof Error) {
    return {
      message: error.message,
      code: deriveErrorCode(error),
      context,
      stack: error.stack,
      timestamp,
    };
  }

  return {
    message: String(error),
    context,
    timestamp,
  };
}

export function formatErrorForLogging(
  error: unknown,
  context?: Record<string, unknown>
): string {
  const details = createErrorDetails(error, context);
  const parts = [`Error: ${details.message}`];

  if (context) {
    parts.push(`Context: ${JSON.stringify(context)}`);
  }

  parts.push(`Stack: ${details.stack ?? '(not available)'}`);
  parts.push(`Timestamp: ${details.timestamp}`);

  return parts.join('\n');
}

export function isRetryableError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'retryable' in (error as Record<string, unknown>)) {
    const retryableFlag = (error as { retryable?: unknown }).retryable;
    if (typeof retryableFlag === 'boolean') {
      return retryableFlag;
    }
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';

  if (!message) {
    return false;
  }

  const normalized = message.toLowerCase();
  return RETRYABLE_KEYWORDS.some(keyword => normalized.includes(keyword));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 100
): Promise<T> {
  let attempts = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableError(error) || attempts >= maxRetries) {
        throw error;
      }

      attempts += 1;
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }
}
