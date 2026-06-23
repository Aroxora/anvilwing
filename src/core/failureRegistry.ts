/**
 * Cross-turn failure registry — remembers tool/test/build error signatures
 * across auto-continue turns so the agent stops re-trying the same dead end.
 *
 * The completion detector is stateless (each turn analyzed alone), so an agent
 * can fix-A-fail, then fix-B-fail, then fix-A-fail again across turns and never
 * notice the loop. This fingerprints each turn's errors by normalized root
 * cause, counts repeats, and — once a signature recurs — injects a "change your
 * approach" nudge into the next auto-continue prompt. Complements the turn
 * governor's stall check (which only catches CONSECUTIVE identical turns).
 *
 * Pure + dependency-free → unit-testable.
 */

export interface RepeatedFailure {
  signature: string;
  count: number;
}

const NUDGE_THRESHOLD = 3;
const MAX_SIGNATURE_LEN = 90;

function normalize(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/['"`][^'"`]*['"`]/g, '…') // collapse quoted identifiers so "x"/"y" map together
    .slice(0, MAX_SIGNATURE_LEN);
}

/** Normalized root-cause signatures present in a turn's output (deduped within the turn). */
export function extractErrorSignatures(output: string): string[] {
  if (!output) return [];
  const out = new Set<string>();
  for (const m of output.matchAll(/error TS(\d{3,5})\b/g)) out.add(`TS${m[1]}`);
  for (const m of output.matchAll(/Cannot find module ['"]([^'"]+)['"]/g)) out.add(`module:${m[1]}`);
  for (const m of output.matchAll(/(?:^|\n)\s*(?:FAIL|✕|✗|●)\s+([^\n]+)/g)) out.add(`fail:${normalize(m[1] ?? '')}`);
  for (const m of output.matchAll(/\b(TypeError|ReferenceError|SyntaxError|RangeError|Error):\s*([^\n]+)/g)) {
    out.add(`${m[1]}:${normalize(m[2] ?? '')}`);
  }
  if (/\b(?:command not found|is not recognized as an internal)/i.test(output)) out.add('command-not-found');
  if (/\bENOENT\b/.test(output)) out.add('ENOENT');
  if (/\bpermission denied\b/i.test(output)) out.add('permission-denied');
  return [...out];
}

export class FailureRegistry {
  private counts = new Map<string, number>();

  reset(): void {
    this.counts.clear();
  }

  /** Record one turn's output; each distinct error signature counts once per turn. */
  trackTurn(output: string): void {
    for (const sig of extractErrorSignatures(output)) {
      this.counts.set(sig, (this.counts.get(sig) ?? 0) + 1);
    }
  }

  /** Signatures that have recurred at least `threshold` times across turns. */
  repeated(threshold = NUDGE_THRESHOLD): RepeatedFailure[] {
    const out: RepeatedFailure[] = [];
    for (const [signature, count] of this.counts) {
      if (count >= threshold) out.push({ signature, count });
    }
    return out.sort((a, b) => b.count - a.count);
  }

  /** A correction nudge to prepend to the next auto-continue when a failure keeps recurring, else null. */
  nudge(threshold = NUDGE_THRESHOLD): string | null {
    const rep = this.repeated(threshold);
    if (!rep.length) return null;
    const list = rep.slice(0, 3).map((r) => `"${r.signature}" (${r.count}×)`).join(', ');
    return `You have hit the same failure repeatedly across turns: ${list}. The current approach is NOT working — do not retry the same edit. Step back, re-read the actual error, and try a genuinely DIFFERENT fix (or run the install/build the error implies), or report what is blocking you.`;
  }
}
