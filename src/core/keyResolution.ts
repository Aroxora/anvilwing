/**
 * Bring-your-own-key resolution. The agent talks to Anvilwing (LLM) and,
 * optionally, Tavily (web search) using keys the user supplies — via the
 * `/key sk-…` / `/key tvly-…` commands or the ANVILWING_API_KEY / TAVILY_API_KEY
 * env vars. No keys ship in this client and there is no
 * sign-in: it's the user's own key or nothing.
 */

import { getSecretValue } from './secretStore.js';

export type KeyMode = 'own' | 'none';

export interface KeyStatus {
  mode: KeyMode;
  ownAnvilwing: boolean;       // the user supplied their own Anvilwing key
  ownTavily: boolean;         // the user supplied their own Tavily key
}

/** Resolve which keys are in effect: the user's own Anvilwing key, or nothing. */
export function resolveKeyMode(): KeyStatus {
  const ownAnvilwing = Boolean(getSecretValue('ANVILWING_API_KEY'));
  const ownTavily = Boolean(getSecretValue('TAVILY_API_KEY'));
  return { mode: ownAnvilwing ? 'own' : 'none', ownAnvilwing, ownTavily };
}

/**
 * The dim welcome/banner line that names the active key source. Returns null
 * in 'none' mode (the welcome already shows key setup).
 */
export function keyModeLine(status: KeyStatus = resolveKeyMode()): string | null {
  if (status.mode === 'own') {
    const tav = status.ownTavily ? 'Tavily ✓' : 'Tavily (shared proxy)';
    return `Using your own keys · Anvilwing ✓ · ${tav}`;
  }
  return null;
}

/**
 * Resolve the Anvilwing endpoint the provider should use: the user's own key
 * hits the API directly. `apiKey` is '' when no key is set (the caller raises
 * the /key hint).
 */
export function resolveAnvilwingEndpoint(): { apiKey: string; baseURL: string } {
  const userKey = (process.env['ANVILWING_API_KEY'] || '').trim();
  if (userKey) {
    return { apiKey: userKey, baseURL: process.env['ANVILWING_BASE_URL'] || 'https://api.deepseek.com' };
  }
  return { apiKey: '', baseURL: '' };
}
