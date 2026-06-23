/**
 * Turn governor — a bounded, stall-aware spine for the auto-continue loop.
 *
 * The auto-continue loop (interactiveShell processPrompt → processPrompt
 * recursion) was UNBOUNDED: an agent that couldn't satisfy the completion
 * heuristic ran forever, re-trying dead ends with no escalation. This caps the
 * turns per user request and detects a stall (the same observable work
 * repeating with no new progress), so the loop yields to the user WITH state
 * instead of thrashing for hours. It also derives the next continuation from
 * the agent's live TODO plan (which the loop previously ignored).
 *
 * Pure + dependency-free so it's unit-testable; the shell instantiates one per
 * user request, resets on a fresh prompt, calls recordTurn() each auto-continue,
 * and breaks on check().stop.
 */

const DEFAULT_MAX_AUTO_TURNS = 25;
const STALL_WINDOW = 3;

export interface TurnMetrics {
  /** tools invoked during the turn */
  toolsUsed: string[];
  /** files written/edited during the turn */
  filesModified: string[];
  /** failing test/build signal in the turn output, or null */
  failingSignal: string | null;
}

export interface GovernorVerdict {
  stop: boolean;
  reason: 'limit' | 'stall' | null;
  turn: number;
}

/** Stable signature of a turn's observable work — the same signature repeating means no progress.
 *
 * PROGRESS-based, not tool-identity-based: every read-only turn (no files
 * modified, no failing signal) collapses to one 'noop' fingerprint. The old
 * tool-identity fingerprint let a re-verify loop that ALTERNATES Read and
 * Bash run all 25 turns ('read||' ≠ 'bash||' never matched), burning ~22
 * full-context model calls per missed completion. Turns that DID modify
 * files keep exact matching so legitimate multi-file work never false-stalls. */
export function fingerprintTurn(m: TurnMetrics): string {
  const files = [...(m.filesModified ?? [])].sort().join(',');
  const failing = m.failingSignal ?? '';
  if (!files && !failing) return 'noop||';
  const tools = [...(m.toolsUsed ?? [])].map((t) => t.toLowerCase()).sort().join(',');
  return `${tools}|${files}|${failing}`;
}

function maxFromEnv(): number | null {
  const raw = process.env['ANVILWING_MAX_AUTO_TURNS'];
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export class TurnGovernor {
  private turn = 0;
  private fps: string[] = [];
  private readonly max: number;
  private readonly stallWindow: number;

  constructor(opts: { maxAutoTurns?: number; stallWindow?: number } = {}) {
    this.max = opts.maxAutoTurns ?? maxFromEnv() ?? DEFAULT_MAX_AUTO_TURNS;
    this.stallWindow = Math.max(2, opts.stallWindow ?? STALL_WINDOW);
  }

  /** A new user request starts a fresh turn budget. */
  reset(): void {
    this.turn = 0;
    this.fps = [];
  }

  /** Record one completed auto-continue turn. */
  recordTurn(m: TurnMetrics): void {
    this.turn += 1;
    this.fps.push(fingerprintTurn(m));
    if (this.fps.length > this.stallWindow) this.fps.shift();
  }

  /** Whether the auto-continue loop should stop now, and why. */
  check(): GovernorVerdict {
    if (this.turn >= this.max) {
      return { stop: true, reason: 'limit', turn: this.turn };
    }
    // Stall: the last `stallWindow` turns did the exact same observable work
    // (same tools, files, failing signal) — the agent is repeating itself with
    // no new progress (including doing nothing at all), so stop rather than
    // burn turns up to the limit.
    if (
      this.fps.length >= this.stallWindow &&
      this.fps.every((f) => f === this.fps[0])
    ) {
      return { stop: true, reason: 'stall', turn: this.turn };
    }
    return { stop: false, reason: null, turn: this.turn };
  }

  get turnCount(): number {
    return this.turn;
  }

  get maxTurns(): number {
    return this.max;
  }
}

// ── Plan-aware continuation: drive the stop/continue decision from the live
//    TODO plan the agent already maintains, instead of a text heuristic. ──

export interface TodoLike {
  content?: string;
  status?: string;
  activeForm?: string;
}

/** Todos still to do (pending or in-progress). */
export function pendingTodos(todos: ReadonlyArray<TodoLike> | null | undefined): TodoLike[] {
  return (todos ?? []).filter((t) => t && (t.status === 'pending' || t.status === 'in_progress'));
}

/**
 * The next auto-continue prompt derived from the plan — the in-progress item
 * (or first pending). Prefixed IMPORTANT: so the loop treats it as an
 * auto-continue (not a fresh user request) and the no-docs guard holds.
 * Returns null when the plan has no pending work.
 */
export function nextTodoPrompt(todos: ReadonlyArray<TodoLike> | null | undefined): string | null {
  const p = pendingTodos(todos);
  if (!p.length) return null;
  const next = p.find((t) => t.status === 'in_progress') ?? p[0];
  const content = (next?.content ?? '').trim();
  if (!content) return null;
  return `IMPORTANT: Do NOT create docs/markdown/summaries. Continue the plan — the next task is: ${content}. Complete it, then update the todo list (mark it completed and the next one in_progress).`;
}
