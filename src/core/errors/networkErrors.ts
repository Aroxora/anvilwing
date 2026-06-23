import type { ProviderId } from '../types.js';

export interface NetworkErrorInfo {
  type: 'network';
  message: string;
  code?: string;
  provider?: ProviderId | string;
  retryable: boolean;
}

/**
 * Heuristically detect network connectivity errors from provider/client failures.
 * Covers DNS, TLS, socket, fetch, and generic "connection error" cases.
 */
export function detectNetworkError(error: unknown): NetworkErrorInfo | null {
  const toStringValue = (value: unknown): string =>
    typeof value === 'string' ? value : value instanceof Error ? value.message : '';

  const code = typeof (error as { code?: unknown })?.code === 'string'
    ? ((error as { code: string }).code || '').toUpperCase()
    : undefined;

  const message = toStringValue(error).toLowerCase();
  const causeCode = typeof (error as { cause?: { code?: string } })?.cause?.code === 'string'
    ? (error as { cause: { code: string } }).cause.code.toUpperCase()
    : undefined;

  const text = `${code ?? ''} ${causeCode ?? ''} ${message}`;

  const NETWORK_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ETIMEDOUT',
    'EPIPE',
  ]);

  const NETWORK_PHRASES = [
    'network error',
    'connection error',
    'failed to fetch',
    'fetch failed',
    'socket hang up',
    'connect ECONNREFUSED',
    'getaddrinfo ENOTFOUND',
    'getaddrinfo EAI_AGAIN',
    'tls handshake timeout',
    'client network socket disconnected',
    'self signed certificate',
    'unexpected end of file',
    'unable to verify the first certificate',
    'network is unreachable',
  ];

  const isNetworkCode = (value?: string): boolean => Boolean(value && NETWORK_CODES.has(value));
  const matchesPhrase = NETWORK_PHRASES.some((phrase) => text.includes(phrase));

  if (!isNetworkCode(code) && !isNetworkCode(causeCode) && !matchesPhrase) {
    return null;
  }

  return {
    type: 'network',
    message: toStringValue(error) || 'Network connectivity issue detected.',
    code: code ?? causeCode,
    retryable: true,
  };
}
