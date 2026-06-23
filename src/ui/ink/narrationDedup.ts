/**
 * Collapse adjacent near-duplicate assistant narration.
 *
 * A provider's streamed tokens and its reassembled `message.complete` are
 * frequently the SAME sentence differing only in punctuation/whitespace (the
 * stream drops the commas the final text has back). Committing both glues a
 * visible duplicate into scrollback:
 *   "…proposing an upgrade planI'll start by exploring … an upgrade plan."
 * These helpers decide when two adjacent assistant texts are the same logical
 * message so the renderer keeps only the richer one.
 *
 * Pure (no Ink/React import) so it unit-tests directly, per the repo's
 * pure-helper convention (see markdownRender.ts).
 */

/** Lowercase, collapse runs of whitespace + punctuation to a single space. */
export function normalizeNarration(s: string): string {
  return (s || '').toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
}

/** Space-and-punctuation-INSENSITIVE key: every non-alphanumeric removed.
 *  The streamed tokens drop the spaces/punctuation the canonical
 *  message.complete keeps ("across 3" streams as "across3", "two places: 1."
 *  as "twoplaces1"), so the space-collapsed normalize above sees them as
 *  DIFFERENT and both copies of the same logical message commit. This key
 *  collapses that difference so dedup catches the streamed-vs-canonical pair
 *  (and a repetition that drifts only in whitespace/punctuation). */
function denseKey(s: string): string {
  return (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function matchesUnder(na: string, nb: string): boolean {
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return long.includes(short) && short.length >= long.length * 0.6;
}

/**
 * True when `a` and `b` are the same logical narration: identical once
 * normalized, OR one is a near-superset of the other (the canonical version
 * adds punctuation/words around the same core). Compared BOTH space-collapsed
 * (normalizeNarration) and space/punctuation-removed (denseKey), because the
 * streamed copy drops the spacing the canonical copy keeps. The 0.6 overlap
 * floor keeps genuinely different adjacent messages — e.g. a response body and
 * a short "Next steps" addendum — from being collapsed.
 */
export function isNearDuplicateNarration(a: string, b: string): boolean {
  if (matchesUnder(normalizeNarration(a), normalizeNarration(b))) return true;
  return matchesUnder(denseKey(a), denseKey(b));
}

/** The richer rendering of two same-logical narrations (prefer the longer —
 *  usually the canonical message.complete that kept its punctuation). */
export function richerNarration(a: string, b: string): string {
  return b.length >= a.length ? b : a;
}
