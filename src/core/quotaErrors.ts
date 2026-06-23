/**
 * Quota / balance exhaustion handling for the two external services the
 * agent leans on: Tavily (web search) and Anvilwing (the LLM provider).
 *
 * The goal is a single, recognizable user message when a paid quota or
 * monthly free-tier cap is the actual cause of a failure — so the user
 * isn't reading "Tavily API error: 432" or "402 Insufficient Balance"
 * and guessing what to do. The helpers are pure (no I/O, no logging)
 * so they can be exercised from both the web-tools layer and the
 * provider layer without coupling.
 */

export const TAVILY_QUOTA_MESSAGE = [
  'Web search is disabled: the Tavily monthly free-tier quota is exhausted.',
  '  • This automatically re-enables on the 1st of next month (UTC reset).',
  '  • To restore search immediately, top up at https://app.tavily.com/billing',
  '    or set your own key: /key tvly-…',
].join('\n');

export const ANVILWING_QUOTA_MESSAGE = [
  'Anvilwing API is disabled: your account balance is exhausted.',
  '  • Top up your account balance to restore access (it does not auto-reset).',
  '  • Or set a different key: /key sk-…',
].join('\n');

/**
 * Detect a Tavily response that means "you've hit your monthly quota
 * (or rate limit) — nothing else will succeed until you top up or
 * the cycle resets". Tavily uses 432 for usage cap, 433 for plan
 * paused, and 429 for short-window rate limits — all three deserve
 * the same user-facing message because the user's remediation is
 * identical.
 *
 * `bodyText` is the response body, lowercased by the caller (or
 * empty if the body could not be read). It's checked as a defence
 * against Tavily changing status codes — quota-language in the body
 * is sufficient.
 */
export function isTavilyQuotaResponse(status: number, bodyText: string): boolean {
  if (status === 402 || status === 429 || status === 432 || status === 433) {
    return true;
  }
  const text = bodyText.toLowerCase();
  return (
    text.includes('usage limit') ||
    text.includes('monthly limit') ||
    text.includes('plan limit') ||
    text.includes('usage_limit_exceeded') ||
    text.includes('quota')
  );
}

/**
 * Detect a Anvilwing error that means "your account balance is exhausted
 * — top up or wait for a paid plan to refill". Anvilwing returns HTTP 402
 * with `Insufficient Balance` in the body when the prepaid balance hits
 * zero; that is the canonical signal. We also catch the lowercase / spaced
 * variants and an explicit `status === 402` from the OpenAI SDK error
 * shape (numeric `.status`, not a string).
 */
export function isAnvilwingQuotaError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: unknown }).status;
  if (status === 402) return true;
  const message = error.message.toLowerCase();
  if (message.includes('402')) return true;
  if (message.includes('insufficient balance')) return true;
  if (message.includes('insufficient_balance')) return true;
  if (message.includes('balance is not enough')) return true;
  if (message.includes('payment required')) return true;
  return false;
}

/**
 * Build a quota-exhaustion Error for Anvilwing. Centralized so the
 * agent-facing message is identical wherever a 402 is detected.
 */
export function buildAnvilwingQuotaError(): Error {
  const err = new Error(ANVILWING_QUOTA_MESSAGE);
  // Tag it so retry / circuit-breaker layers can treat it as
  // non-transient without re-detecting via message scraping.
  (err as { isQuotaExhausted?: boolean }).isQuotaExhausted = true;
  (err as { provider?: string }).provider = 'anvilwing';
  return err;
}
