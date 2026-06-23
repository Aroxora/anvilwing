/**
 * Rotating "thinking" gerunds for the working spinner — Claude Code parity
 * (see src/ui/CLAUDE_CODE_UX.md §4: "a rotating gerund ('Thinking',
 * 'Synthesizing', 'Forging', 'Puzzling', 'Conjuring', 'Noodling')"). When the
 * agent is working without a specific tool activity, the host parks the
 * canonical generic label on the spinner and the renderer swaps it for a
 * whimsical gerund that rotates over time, instead of a static "Thinking…".
 *
 * Pure module: no side effects, no imports. The renderer rotates by calling
 * pickThinkingVerb(); tests seed the rng for determinism.
 */

export const THINKING_VERBS: readonly string[] = Object.freeze([
  'Thinking',
  'Synthesizing',
  'Forging',
  'Puzzling',
  'Conjuring',
  'Noodling',
  'Pondering',
  'Brewing',
  'Cooking',
  'Churning',
  'Crafting',
  'Computing',
  'Cerebrating',
  'Simmering',
  'Percolating',
  'Ruminating',
  'Wrangling',
  'Tinkering',
  'Marinating',
  'Spelunking',
]);

/**
 * Canonical generic-thinking label. The host sets this (or one of the legacy
 * "Thinking…" / "Thinking..." variants) on the spinner when the agent is busy
 * without a named tool activity; the renderer treats it as a sentinel and shows
 * a rotating gerund instead. Never displayed verbatim while spinning.
 */
export const GENERIC_THINKING_LABEL = 'Thinking';

const GENERIC_VARIANTS = new Set(['Thinking', 'Thinking…', 'Thinking...']);

/** True when `message` is a generic-thinking sentinel (any historical spelling). */
export function isGenericThinking(message: string | null | undefined): boolean {
  return message != null && GENERIC_VARIANTS.has(message.trim());
}

/**
 * Pick a thinking gerund. Pass `exclude` (the current verb) so a rotation
 * always lands on a different word; pass `rng` to make the choice deterministic
 * in tests.
 */
export function pickThinkingVerb(opts: { rng?: () => number; exclude?: string } = {}): string {
  const rng = opts.rng ?? Math.random;
  const pool = opts.exclude ? THINKING_VERBS.filter((v) => v !== opts.exclude) : THINKING_VERBS;
  const list = pool.length ? pool : THINKING_VERBS;
  const idx = Math.abs(Math.floor(rng() * list.length)) % list.length;
  return list[idx]!;
}
