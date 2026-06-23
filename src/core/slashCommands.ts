/**
 * Slash-command autocomplete — the `/` half of Claude Code's typed completion
 * (the `@`-mention half lives in fileMentions.ts and the two share an identical
 * menu UX in Prompt.tsx). Typing `/` at the start of the buffer opens a
 * filterable palette of commands; ↑/↓ move, Tab/Enter accept, Esc dismisses.
 *
 * The catalog is the single source of truth for what the palette offers. It
 * lists only the canonical command names (aliases like /c, /q, /changes are
 * handled by interactiveShell but kept out of the palette to match Claude
 * Code's one-row-per-command surface). A test asserts every entry here is
 * actually handled by interactiveShell.handleSlashCommand so the two can't
 * drift.
 */

export interface SlashCommand {
  command: string; // includes the leading '/'
  description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { command: '/key', description: 'Set your Anvilwing API key' },
  { command: '/clear', description: 'Clear the screen and conversation' },
  { command: '/resume', description: 'Restore a saved conversation' },
  { command: '/context', description: 'Show context-window usage' },
  { command: '/compact', description: 'Compact the conversation to reclaim context' },
  { command: '/cost', description: 'Anvilwing tokens + Tavily searches consumed' },
  { command: '/diff', description: 'Review files changed this run' },
  { command: '/rewind', description: 'Restore files changed this run' },
  { command: '/update', description: 'Update to the latest version' },
  { command: '/keys', description: 'Show keyboard shortcuts' },
  { command: '/bash', description: 'Run a shell command directly' },
  { command: '/help', description: 'Show help' },
  { command: '/exit', description: 'Exit the shell' },
];

/**
 * The command partial being typed at the cursor, or null. A slash command only
 * exists as the FIRST token of the buffer, so the partial is the run of
 * non-whitespace right after a leading `/` with nothing before it. Returns ''
 * for a bare `/`. Once a space is typed (entering args) this returns null and
 * the palette closes.
 */
export function activeSlashPartial(text: string, cursor: number): string | null {
  const m = text.slice(0, Math.max(0, cursor)).match(/^\/(\S*)$/);
  return m ? (m[1] ?? '') : null;
}

/** Commands matching `partial` (name without the `/`), prefix-first then substring. */
export function rankCommandMatches(partial: string, limit = 8): SlashCommand[] {
  const q = partial.toLowerCase();
  if (!q) return SLASH_COMMANDS.slice(0, limit);
  const scored: { c: SlashCommand; score: number }[] = [];
  for (const c of SLASH_COMMANDS) {
    const name = c.command.slice(1).toLowerCase();
    let score = -1;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    if (score >= 0) scored.push({ c, score });
  }
  scored.sort((a, b) => a.score - b.score || a.c.command.length - b.c.command.length);
  return scored.slice(0, limit).map((s) => s.c);
}

/**
 * Replace the active `/<partial>` first token with `<command> ` (trailing space
 * so an arg can follow, and so the partial no longer matches — closing the
 * palette). Mirrors applyMentionCompletion.
 */
export function applySlashCompletion(text: string, cursor: number, command: string): { text: string; cursor: number } {
  if (activeSlashPartial(text, cursor) === null) return { text, cursor };
  const insert = `${command} `;
  return { text: insert + text.slice(cursor), cursor: insert.length };
}
