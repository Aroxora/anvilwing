/**
 * Degeneration / repetition cutoff for streamed model output.
 *
 * An LLM can fall into a repetition loop, emitting the SAME block over and
 * over ("Here's what was upgraded across 3 files… Here's what was upgraded…").
 * Without a guard this burned minutes of one turn (a real run streamed the
 * same summary ~30× over 336s) and committed a wall of duplicates. This detects
 * a CONTIGUOUS repeated tail so the agent loop can stop the stream early and
 * keep just one copy.
 *
 * Pure (no I/O) so it unit-tests directly, per the repo's pure-helper
 * convention (see narrationDedup.ts / markdownRender.ts). Conservative by
 * design: a real, content-bearing unit (≥24 chars, ≥12 alphanumerics) must
 * repeat back-to-back at least `minRepeats` times before it's called a loop —
 * legitimate prose/code effectively never repeats an identical 24+ char span
 * 8× in a row.
 */

export interface RepetitionResult {
  /** The model is repeating the same tail unit back-to-back. */
  looping: boolean;
  /** The repeating unit (the smallest period found), when looping. */
  unit?: string;
  /** How many contiguous copies sit at the end, when looping. */
  repeats?: number;
}

const WINDOW = 12_000;       // only inspect a bounded tail (cheap, called often)
const MIN_UNIT = 24;         // a unit shorter than this is too weak a signal
const MAX_UNIT = 600;        // beyond this it's a genuinely long passage, not a loop
const MIN_ALNUM = 12;        // the unit must carry real content, not whitespace/punctuation
const MIN_DISTINCT = 8;      // ...and real DIVERSITY — a degeneration loop repeats a
                             // sentence/block (many distinct chars), not a single-char
                             // run. A run like "xxxx…" or "----" is runaway padding,
                             // left to the OOM char-limit, not flagged as a loop here.
const MIN_REPEATS = 8;       // contiguous copies required to call it degeneration

function alnumLen(s: string): number {
  return (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

function distinctChars(s: string): number {
  return new Set(s).size;
}

/**
 * Detect a degeneration loop in the TAIL of `text`: the smallest unit (period
 * p in [MIN_UNIT, MAX_UNIT]) whose `MIN_REPEATS`+ identical copies sit
 * contiguously at the very end. Returns the unit and contiguous-copy count.
 */
export function detectRepetitionLoop(text: string, opts: { minRepeats?: number } = {}): RepetitionResult {
  const minRepeats = opts.minRepeats ?? MIN_REPEATS;
  if (!text || text.length < MIN_UNIT * minRepeats) return { looping: false };
  const tail = text.length > WINDOW ? text.slice(-WINDOW) : text;
  const maxP = Math.min(MAX_UNIT, Math.floor(tail.length / minRepeats));
  for (let p = MIN_UNIT; p <= maxP; p++) {
    const unit = tail.slice(tail.length - p);
    if (alnumLen(unit) < MIN_ALNUM) continue;
    if (distinctChars(unit) < MIN_DISTINCT) continue;
    let reps = 1;
    let idx = tail.length - p;
    while (idx - p >= 0 && tail.slice(idx - p, idx) === unit) {
      reps++;
      idx -= p;
    }
    if (reps >= minRepeats) return { looping: true, unit, repeats: reps };
  }
  return { looping: false };
}

/** The marker appended to a trimmed degenerate response. Shared so the agent
 *  (which writes it) and the shell's auto-continue (which reads it to END the
 *  loop instead of re-prompting a looping model) never drift. */
export const REPETITION_MARKER = '[Response stopped: the model began repeating itself.]';

/** True when a turn's text was cut by the degeneration guard. The shell uses
 *  this to terminate auto-continue: re-prompting a model that just looped only
 *  makes it loop again. */
export function wasRepetitionStopped(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(REPETITION_MARKER);
}

/**
 * Trim a detected repetition: keep everything BEFORE the loop plus exactly one
 * copy of the unit, then a marker. `repeats * unit.length` chars sit
 * contiguously at the end (by construction in detectRepetitionLoop), so the
 * head is everything before that run.
 */
export function trimRepetition(text: string, unit: string, repeats: number): string {
  const runLen = unit.length * repeats;
  const head = text.length >= runLen ? text.slice(0, text.length - runLen) : '';
  return `${head}${unit}\n${REPETITION_MARKER}`;
}
