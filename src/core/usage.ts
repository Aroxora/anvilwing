/**
 * Local usage meter — counts what THIS install consumed: Anvilwing tokens
 * (input + output) and Tavily searches. Persisted across sessions in
 * ~/.anvilwing/usage.json (or $ANVILWING_HOME), plus a per-session tally.
 *
 * This is the per-install half of the picture. The FREE POOL totals and
 * account-wide *remaining* are operator/backend numbers (the hosted Tavily
 * account's 1,000/mo + 5,000 one-time bonus, and the operator's hosted Anvilwing
 * budget) — the portal aggregates every install's usage against them. The quota
 * constants below are exported so the backend + portal share one definition.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Tavily free allotment (the operator's hosted Tavily account). Shared by the
// portal/backend so "how much free is left" is computed against one source.
export const TAVILY_MONTHLY_FREE = 1000;
export const TAVILY_ONE_TIME_BONUS = 5000;

export interface UsageTotals {
  anvilwingInputTokens: number;
  anvilwingOutputTokens: number;
  tavilySearches: number;
}

const ZERO: UsageTotals = { anvilwingInputTokens: 0, anvilwingOutputTokens: 0, tavilySearches: 0 };

// Per-session tally (resets each launch); cumulative lives on disk.
const session: UsageTotals = { ...ZERO };

function usageFile(): string {
  const home = process.env['ANVILWING_HOME'] ? resolve(process.env['ANVILWING_HOME']) : join(homedir(), '.anvilwing');
  return join(home, 'usage.json');
}

function readCumulative(): UsageTotals {
  const file = usageFile();
  if (!existsSync(file)) return { ...ZERO };
  try {
    const p = JSON.parse(readFileSync(file, 'utf8'));
    if (p && typeof p === 'object') {
      return {
        anvilwingInputTokens: num(p.anvilwingInputTokens),
        anvilwingOutputTokens: num(p.anvilwingOutputTokens),
        tavilySearches: num(p.tavilySearches),
      };
    }
  } catch { /* corrupt → treat as zero */ }
  return { ...ZERO };
}

function writeCumulative(data: UsageTotals): void {
  const file = usageFile();
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** Record a Anvilwing turn's token usage (input/prompt + output/completion). */
export function recordAnvilwingUsage(inputTokens: unknown, outputTokens: unknown): void {
  const i = num(inputTokens);
  const o = num(outputTokens);
  if (i === 0 && o === 0) return;
  session.anvilwingInputTokens += i;
  session.anvilwingOutputTokens += o;
  const cum = readCumulative();
  cum.anvilwingInputTokens += i;
  cum.anvilwingOutputTokens += o;
  writeCumulative(cum);
}

/** Record one Tavily web search. */
export function recordTavilySearch(): void {
  session.tavilySearches += 1;
  const cum = readCumulative();
  cum.tavilySearches += 1;
  writeCumulative(cum);
}

/** Usage so far — this session and all-time (persisted). */
export function getUsage(): { session: UsageTotals; cumulative: UsageTotals } {
  return { session: { ...session }, cumulative: readCumulative() };
}
