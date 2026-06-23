import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ProviderId } from './types.js';

export type SecretName =
  | 'ANVILWING_API_KEY'
  | 'TAVILY_API_KEY';

export interface SecretDefinition {
  id: SecretName;
  label: string;
  description: string;
  envVar: SecretName;
  providers: ProviderId[];
}

interface SecretStoreData {
  [key: string]: string | undefined;
}

const SECRET_DEFINITIONS: SecretDefinition[] = [
  {
    id: 'ANVILWING_API_KEY',
    label: 'Anvilwing API Key',
    description: 'Required to run Anvilwing Reasoner or Chat models.',
    envVar: 'ANVILWING_API_KEY',
    providers: ['anvilwing'],
  },
  {
    id: 'TAVILY_API_KEY',
    label: 'Tavily API Key',
    description: 'Required: WebSearch and WebExtract provider. Get yours at https://tavily.com',
    envVar: 'TAVILY_API_KEY',
    providers: [],
  },
];

const envAgiHome = process.env['ANVILWING_HOME'];
const SECRET_DIR = envAgiHome ? resolve(envAgiHome) : join(homedir(), '.anvilwing');
const SECRET_FILE = join(SECRET_DIR, 'secrets.json');

export class MissingSecretError extends Error {
  constructor(public readonly secret: SecretDefinition) {
    super(`${secret.label} is not configured.`);
    this.name = 'MissingSecretError';
  }
}

export function listSecretDefinitions(): SecretDefinition[] {
  return [...SECRET_DEFINITIONS];
}

export function getSecretDefinition(id: SecretName): SecretDefinition | null {
  return SECRET_DEFINITIONS.find((entry) => entry.id === id) ?? null;
}

export function getSecretValue(id: SecretName): string | null {
  const envValue = sanitize(process.env[id]);
  if (envValue) {
    return envValue;
  }

  const store = readSecretStore();
  const storedValue = sanitize(store[id]);
  if (!storedValue) {
    // No API key is baked into the source. A keyless
    // Anvilwing default used to live here; it shipped in the npm `dist/` and
    // git history — a secret inside the design. Credentials are now resolved
    // at runtime by the provider (user key, or an operator proxy).
    return null;
  }

  process.env[id] = storedValue;
  return storedValue;
}

/**
 * Load all stored secrets into process.env at startup.
 * This ensures secrets are available before any provider checks.
 *
 * IMPORTANT: Stored secrets always take precedence over environment variables
 * for provider API keys. This ensures keys set via /secrets are used even if
 * the user has old/stale keys exported in their shell environment.
 */
export function loadAllSecrets(): void {
  const store = readSecretStore();
  for (const definition of SECRET_DEFINITIONS) {
    const storedValue = sanitize(store[definition.id]);
    if (storedValue) {
      // Always use stored value for API keys to ensure /secrets takes precedence
      // over potentially stale environment variables
      process.env[definition.id] = storedValue;
    }
    // No baked-in default (secrets never ship in source). The provider
    // resolves credentials at runtime.
  }
}

export function setSecretValue(id: SecretName, rawValue: string): void {
  const value = sanitize(rawValue);
  if (!value) {
    throw new Error('Secret value cannot be blank.');
  }

  const store = readSecretStore();
  store[id] = value;
  writeSecretStore(store);
  process.env[id] = value;
}

/**
 * Route a raw `/key` argument to the secret it sets, by prefix or explicit
 * provider word. Anvilwing keys are `sk-…`, Tavily keys are `tvly-…`, so a bare
 * key self-identifies; `/key tavily <k>` / `/key anvilwing <k>` force it. Bare
 * keys with no known prefix default to Anvilwing (back-compat — that was the
 * only key `/key` ever set). Returns null for an empty/blank argument.
 */
export function classifyKeyEntry(raw: string): { id: SecretName; value: string } | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  const lead = (parts[0] || '').toLowerCase();
  if (lead === 'tavily' || lead === 'tvly' || lead === 'search') {
    const value = parts.slice(1).join(' ').trim();
    return value ? { id: 'TAVILY_API_KEY', value } : null;
  }
  if (lead === 'anvilwing' || lead === 'ds') {
    const value = parts.slice(1).join(' ').trim();
    return value ? { id: 'ANVILWING_API_KEY', value } : null;
  }
  if (/^tvly-/i.test(trimmed)) return { id: 'TAVILY_API_KEY', value: trimmed };
  return { id: 'ANVILWING_API_KEY', value: trimmed };
}

export function maskSecret(value: string): string {
  if (!value) {
    return '';
  }
  if (value.length <= 4) {
    return '*'.repeat(value.length);
  }
  const suffix = value.slice(-4);
  const prefix = '*'.repeat(Math.max(0, value.length - 4));
  return `${prefix}${suffix}`;
}

export function ensureSecretForProvider(provider: ProviderId): string {
  const definition = findDefinitionForProvider(provider);
  const value = getSecretValue(definition.id);
  if (!value) {
    throw new MissingSecretError(definition);
  }
  process.env[definition.envVar] = value;
  return value;
}

export function getSecretDefinitionForProvider(provider: ProviderId): SecretDefinition | null {
  return SECRET_DEFINITIONS.find((entry) => entry.providers.includes(provider)) ?? null;
}

function readSecretStore(): SecretStoreData {
  if (!existsSync(SECRET_FILE)) {
    return {};
  }

  try {
    const content = readFileSync(SECRET_FILE, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      return parsed as SecretStoreData;
    }
  } catch {
    return {};
  }
  return {};
}

function writeSecretStore(store: SecretStoreData): void {
  const directory = dirname(SECRET_FILE);
  // Same posture as auth.ts: 0o700 on the dir, 0o600 on the file. The
  // payload contains Anvilwing / Tavily / etc. API keys; on shared boxes
  // anything looser leaves them readable to other local users.
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(store, null, 2);
  // Atomic write: stage to a tmp file then rename. Without this, two
  // concurrent CLIs writing the secret store at the same moment can
  // produce a half-written file that subsequent reads parse as `{}`.
  const tmp = `${SECRET_FILE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${payload}
`, { mode: 0o600 });
  renameSync(tmp, SECRET_FILE);
}

function findDefinitionForProvider(provider: ProviderId): SecretDefinition {
  const definition = getSecretDefinitionForProvider(provider);
  if (!definition) {
    throw new Error(`No secret configuration for provider "${provider}".`);
  }
  return definition;
}

function sanitize(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

// ============================================================================
// Secret Sanitization for Error Messages
// ============================================================================

/**
 * Known API key patterns to detect and sanitize in error messages.
 * These patterns match common API key formats from various providers.
 */
const API_KEY_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9_.-]{20,}/gi,
  /x-api-key['":\s]+[A-Za-z0-9_.-]{20,}/gi,
  /[?&](?:key|api_key|apiKey|api-key|token|access_token)=([A-Za-z0-9_.-]{16,})/gi,
  // `sk-…` covers OpenAI/Anvilwing/Anthropic. Was hex-only (`[a-f0-9]`), which
  // matched a Anvilwing key but LEAKED an OpenAI base62 key (sk-AbC…) or an
  // sk-proj-/sk-ant- key found in a user's file/config/log.
  /sk-[A-Za-z0-9_-]{20,}/gi,
  /tvly-[A-Za-z0-9_-]{16,}/gi, // Tavily
  // JWT (header.payload.signature, base64url) — `eyJ` is the b64 of `{"`. Bare
  // JWTs (not in a Bearer/key=value form) previously leaked whole.
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(?:api[_-]?key|token|secret|password|credential)['"]?\s*[:=]\s*['"]?([A-Za-z0-9_.-]{20,})['"]?/gi,
];

/**
 * Sanitize error messages to remove potential API keys and secrets.
 * This prevents accidental token leakage in logs, error reports, and console output.
 *
 * @param message - The error message or string to sanitize
 * @returns The sanitized string with secrets replaced by [REDACTED]
 */
export function sanitizeErrorMessage(message: string): string {
  if (!message || typeof message !== 'string') {
    return message;
  }

  let sanitized = message;

  // Apply all API key patterns
  for (const pattern of API_KEY_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, (match) => {
      // For patterns with capture groups, try to preserve context
      if (match.includes('=') || match.includes(':')) {
        const separator = match.includes('=') ? '=' : ':';
        const parts = match.split(separator);
        if (parts.length === 2) {
          return `${parts[0]}${separator}[REDACTED]`;
        }
      }
      return '[REDACTED]';
    });
  }

  // Additionally sanitize any env var values that are currently loaded
  sanitized = sanitizeAgainstLoadedSecrets(sanitized);

  return sanitized;
}

/**
 * Sanitize a string against currently loaded secret values.
 * This catches any secrets that might not match the pattern-based detection.
 */
function sanitizeAgainstLoadedSecrets(message: string): string {
  const secretNames: SecretName[] = [
    'ANVILWING_API_KEY',
    'TAVILY_API_KEY',
  ];

  let sanitized = message;

  for (const name of secretNames) {
    const value = process.env[name];
    if (value && value.length >= 4) {
      // Only sanitize if the value appears in the message
      // Use a case-sensitive exact match to avoid false positives
      if (sanitized.includes(value)) {
        sanitized = sanitized.split(value).join('[REDACTED]');
      }

      // Also sanitize partial matches (first 8 chars + last 4 chars pattern)
      if (value.length >= 12) {
        const partialPattern = `${value.substring(0, 8)}...${value.substring(value.length - 4)}`;
        if (sanitized.includes(partialPattern)) {
          sanitized = sanitized.split(partialPattern).join('[REDACTED_PARTIAL]');
        }
      }
    }
  }

  return sanitized;
}

/**
 * Sanitize an Error object's message and stack trace.
 * Returns a new error message string with secrets removed.
 */
export function sanitizeError(error: Error): string {
  const message = sanitizeErrorMessage(error.message);
  const stack = error.stack ? sanitizeErrorMessage(error.stack) : '';

  if (stack && stack !== message) {
    return `${message}\n${stack}`;
  }
  return message;
}

/**
 * Create a safe error message from an unknown error value.
 * Ensures no secrets are leaked regardless of error type.
 */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return sanitizeErrorMessage(error.message);
  }
  if (typeof error === 'string') {
    return sanitizeErrorMessage(error);
  }
  return 'Unknown error occurred';
}
