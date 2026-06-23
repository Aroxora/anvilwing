/**
 * The dim transcript note shown when the context manager auto-compacts the
 * conversation (Claude Code parity). Pure + emoji-free so it's unit-testable
 * and conforms to UX §9.
 */

export interface CompactionInfo {
  removed: number;
  freedTokens: number;
  summarized: boolean;
  percentage: number;
}

export function formatCompactionNote(info: CompactionInfo): string {
  const action = info.summarized ? 'summarized' : 'pruned';
  const msgs = `${info.removed} message${info.removed === 1 ? '' : 's'}`;
  const freed = info.freedTokens > 0 ? `, freed ~${info.freedTokens.toLocaleString('en-US')} tokens` : '';
  const pct = info.percentage > 0 ? ` · ${info.percentage}% context used` : '';
  return `Compacted context — ${action} ${msgs}${freed}${pct}`;
}
