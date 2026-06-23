/**
 * Live key validation for the /connect setup flow. A key counts as "connected"
 * only when it actually WORKS against the provider — not merely when it's
 * non-empty. /connect requires a working active-model (Anvilwing) key AND a
 * working Tavily key, and re-prompts on failure.
 *
 * The checks hit the real provider endpoints (no mock stands
 * in for the thing under test). A clearly-invalid key always resolves ok:false,
 * whether the provider rejects it (401/403) or the network is unreachable.
 */

import type { SecretName } from './secretStore.js';

export interface KeyCheck {
  ok: boolean;
  /** Present when ok is false: a short, user-facing reason. */
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function describeError(err: unknown, aborted: boolean, who: string): string {
  if (aborted) return `timed out reaching ${who}`;
  const msg = err instanceof Error ? err.message : String(err);
  return `could not reach ${who}: ${msg}`;
}

/** Validate a Anvilwing key by listing models (cheap, no token spend). */
export async function validateAnvilwingKey(key: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<KeyCheck> {
  const trimmed = (key || '').trim();
  if (!trimmed) return { ok: false, error: 'empty key' };
  const baseURL = (process.env['ANVILWING_BASE_URL'] || 'https://api.deepseek.com').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseURL}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${trimmed}` },
      signal: controller.signal,
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'key rejected (unauthorized)' };
    return { ok: false, error: `Anvilwing returned HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: describeError(err, controller.signal.aborted, 'Anvilwing') };
  } finally {
    clearTimeout(timer);
  }
}

/** Validate a Tavily key with a minimal search (same endpoint the agent uses). */
export async function validateTavilyKey(key: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<KeyCheck> {
  const trimmed = (key || '').trim();
  if (!trimmed) return { ok: false, error: 'empty key' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: trimmed, query: 'ping', max_results: 1, search_depth: 'basic' }),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'key rejected (unauthorized)' };
    return { ok: false, error: `Tavily returned HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: describeError(err, controller.signal.aborted, 'Tavily') };
  } finally {
    clearTimeout(timer);
  }
}

export interface ProviderKeySpec {
  id: SecretName;
  label: string;
  hint: string;
  placeholder: string;
  validate: (key: string, timeoutMs?: number) => Promise<KeyCheck>;
}

/** Both keys /connect requires to be working before the agent is ready. */
export const REQUIRED_PROVIDERS: ProviderKeySpec[] = [
  { id: 'ANVILWING_API_KEY', label: 'Anvilwing', hint: 'model provider — required', placeholder: 'sk-…', validate: validateAnvilwingKey },
  { id: 'TAVILY_API_KEY', label: 'Tavily', hint: 'web search — required', placeholder: 'tvly-…', validate: validateTavilyKey },
];
