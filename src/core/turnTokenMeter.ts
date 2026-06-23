/**
 * Turn-scoped output-token meter for the spinner's `↑ N tokens` meta.
 *
 * baseline = sum of provider-exact completion tokens for requests already
 * finished this turn. While a request streams, current() adds a live
 * estimate (ceil(streamedChars / 4)); the usage event replaces the estimate
 * with the exact count, so the resting value is always provider-exact (the
 * number may correct slightly at request end — by design). A turn can span
 * multiple model requests (tool loops); reset only on a new user turn.
 */
export class TurnTokenMeter {
  private baseline = 0;
  private streamedChars = 0;

  reset(): void {
    this.baseline = 0;
    this.streamedChars = 0;
  }

  addStreamedChars(count: number): void {
    if (Number.isFinite(count) && count > 0) {
      this.streamedChars += count;
    }
  }

  recordExactOutput(outputTokens: number): void {
    // Only replace the live estimate when a real exact count arrived; a
    // missing/0/NaN completion_tokens (lax OpenAI-compatible proxies) must
    // not silently discard the accumulated estimate.
    if (Number.isFinite(outputTokens) && outputTokens > 0) {
      this.baseline += outputTokens;
      this.streamedChars = 0;
    }
  }

  current(): number {
    return this.baseline + Math.ceil(this.streamedChars / 4);
  }
}
