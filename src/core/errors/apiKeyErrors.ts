import type { ProviderId } from '../types.js';
import {
  MissingSecretError,
  type SecretDefinition,
  getSecretDefinitionForProvider,
} from '../secretStore.js';

export type ApiKeyErrorType = 'missing' | 'invalid';

export interface ApiKeyErrorInfo {
  type: ApiKeyErrorType;
  provider: ProviderId | null;
  secret?: SecretDefinition | null;
  message?: string;
}

export function detectApiKeyError(error: unknown, provider?: ProviderId | null): ApiKeyErrorInfo | null {
  if (error instanceof MissingSecretError) {
    const primaryProvider = error.secret.providers[0] ?? null;
    return {
      type: 'missing',
      provider: provider ?? primaryProvider,
      secret: error.secret,
      message: error.message,
    };
  }

  if (isUnauthorizedError(error)) {
    const labelProvider = provider ?? extractProviderFromError(error);
    const secret = labelProvider ? getSecretDefinitionForProvider(labelProvider) : null;
    return {
      type: 'invalid',
      provider: labelProvider,
      secret,
      message: extractErrorMessage(error),
    };
  }

  return null;
}

function isUnauthorizedError(error: unknown): boolean {
  const status = extractStatus(error);
  if (status === 401 || status === 403) {
    return true;
  }

  const payload = extractStructuredError(error);
  if (payload) {
    // Check type and code fields
    const normalizedType = normalize(payload.type) || normalize(payload.code);
    if (normalizedType && containsAuthKeyword(normalizedType)) {
      return true;
    }
    // Check status field (e.g., "PERMISSION_DENIED")
    if (payload.status && containsAuthKeyword(normalize(payload.status))) {
      return true;
    }
    // Check reason field (e.g., "forbidden")
    if (payload.reason && containsAuthKeyword(normalize(payload.reason))) {
      return true;
    }
    // Check message field
    if (payload.message && containsAuthKeyword(normalize(payload.message))) {
      return true;
    }
  }

  const message = normalize(extractErrorMessage(error));
  if (!message) {
    return false;
  }
  return containsAuthKeyword(message);
}

function extractStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const directStatus = (error as { status?: number }).status;
  if (typeof directStatus === 'number') {
    return directStatus;
  }

  const response = (error as { response?: { status?: number } }).response;
  if (response && typeof response.status === 'number') {
    return response.status;
  }

  return null;
}

function extractStructuredError(error: unknown): { type?: string; code?: string; message?: string; status?: string; reason?: string } | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  // Handle nested error.error structure (common in Google/Gemini errors)
  if ('error' in error) {
    const candidate = (error as { error?: unknown }).error;
    if (candidate && typeof candidate === 'object') {
      const structured = candidate as { type?: string; code?: string | number; message?: string; status?: string; reason?: string; errors?: Array<{ reason?: string }> };
      // Extract reason from nested errors array (Gemini format)
      let reason = structured.reason;
      if (!reason && structured.errors && Array.isArray(structured.errors) && structured.errors[0]?.reason) {
        reason = structured.errors[0].reason;
      }
      return {
        type: structured.type,
        code: typeof structured.code === 'number' ? String(structured.code) : structured.code,
        message: structured.message,
        status: structured.status,
        reason,
      };
    }
  }

  // Handle direct status/reason on error object
  const directError = error as { status?: string; reason?: string; code?: string | number; message?: string };
  if (directError.status || directError.reason || directError.code) {
    return {
      status: directError.status,
      reason: directError.reason,
      code: typeof directError.code === 'number' ? String(directError.code) : directError.code,
      message: directError.message,
    };
  }

  return null;
}

function extractProviderFromError(error: unknown): ProviderId | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const provider = (error as { provider?: ProviderId }).provider;
  if (typeof provider === 'string' && provider.trim()) {
    return provider.trim();
  }

  return null;
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message ?? '';
  }

  if (error && typeof error === 'object') {
    const payload = extractStructuredError(error);
    if (payload?.message) {
      return payload.message;
    }
    if ('message' in error && typeof (error as { message?: unknown }).message === 'string') {
      return (error as { message: string }).message;
    }
  }

  return '';
}

function containsAuthKeyword(value: string | null): boolean {
  if (!value) {
    return false;
  }
  return (
    value.includes('api key') ||
    value.includes('apikey') ||
    value.includes('api-key') ||
    value.includes('authentication') ||
    value.includes('unauthorized') ||
    value.includes('permission_denied') ||
    value.includes('permission denied') ||
    value.includes('forbidden') ||
    value.includes('invalid_api_key') ||
    value.includes('invalid api key') ||
    value.includes('access_denied') ||
    value.includes('access denied') ||
    value.includes('not authorized') ||
    value.includes('credentials') ||
    value.includes('entitlement') ||
    value.includes('subscription')
  );
}

function normalize(value?: unknown): string | null {
  if (!value || typeof value !== 'string') {
    return null;
  }
  return value.toLowerCase();
}
