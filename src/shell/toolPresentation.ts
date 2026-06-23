/**
 * toolPresentation — pure formatters that turn a tool call + its result into
 * the Claude-Code transcript shape:
 *
 *   ⏺ Read(fibonacci.py)
 *     ⎿  Read 38 lines
 *
 *   ⏺ Bash(python3 fibonacci.py)
 *     ⎿  12586269025
 *
 * Lives under src/shell/ (not src/ui/) so the `ink-only` import guard — which
 * forbids anything under src/ui/ except theme.ts + ink/* — stays green. These
 * functions are pure (no chalk, no I/O) so the shape is unit-testable without a
 * PTY, mirroring editTools.ts which already emits `⏺ Update(path)` / `  ⎿  …`.
 *
 * Two naming conventions reach us: the canonical PascalCase (Read/Bash/Edit)
 * and Anvilwing's snake_case (read_file/execute_bash/write_file). Both normalise
 * to the same display name + primary argument.
 */

/** Bullet that opens every action line (assistant prose + tool calls). */
export const ACTION_BULLET = '⏺';
/** Tree turn that opens every result line, with its two-space lead-in. */
export const RESULT_PREFIX = '  ⎿  ';
/** Indent that aligns result continuation lines under the first result char. */
export const RESULT_CONT = '     ';

const ANSI = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

/** Last path segment, tolerant of both `/` and `\` separators. */
export function baseName(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** Display a path relative to cwd when it lives under it, else its basename. */
export function shortPath(p: string, cwd?: string): string {
  if (!p) return '';
  if (cwd && p.startsWith(cwd)) {
    const rel = p.slice(cwd.length).replace(/^[\\/]+/, '');
    if (rel) return rel;
  }
  return baseName(p);
}

/** A host+trimmed-path label for a URL, e.g. `apnews.com/hub/donald-trump`. */
function urlLabel(u: string): string {
  const noScheme = u.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
  return noScheme.length > 48 ? `${noScheme.slice(0, 47)}…` : noScheme;
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * The `Read N lines` summary for a read result. The read tool emits one of two
 * headers (src/tools/fileTools.ts): `File: x (38 lines)` for a whole file, and
 * `File: x (lines 5-45 of 200)` for a windowed read. The windowed form must
 * report the size of the window actually read — 41 lines — not the file total
 * and not the header-inclusive output height. Claude Code reports lines
 * returned; the previous `(\d+) lines` regex missed the ranged form entirely
 * and fell back to counting every output line (header + blank + numbered),
 * over-reporting by two. `read_files` (plural) opens with its own
 * `Read N files in parallel` header — surface the file count for that.
 */
function readSummary(text: string): string {
  const multi = text.match(/^Read (\d+) files? in parallel/);
  if (multi) {
    const n = Number(multi[1]);
    return `Read ${n} file${n === 1 ? '' : 's'}`;
  }
  const range = text.match(/\(lines\s+(\d+)-(\d+)\s+of\s+\d+\)/);
  if (range) {
    const n = Number(range[2]) - Number(range[1]) + 1;
    return `Read ${n} line${n === 1 ? '' : 's'}`;
  }
  const whole = text.match(/\((\d+)\s+lines?\)/);
  const lines = whole ? Number(whole[1]) : text.split('\n').length;
  return `Read ${lines} line${lines === 1 ? '' : 's'}`;
}

/** Checkbox glyphs for the TodoWrite render. `☒`/`☐` match Claude Code; the
 *  active step gets a distinct `▸` so the user can see WHERE the plan is — the
 *  one thing a flat ☐/☒ list can't show. ChatStatic colors by these glyphs. */
const TODO_DONE = '☒';
const TODO_OPEN = '☐';
const TODO_ACTIVE = '▸';

/**
 * Render a list of todos as the checklist body that follows `⏺ Update Todos`:
 * one line per task, the first carrying the `⎿` turn. Completed use `☒`,
 * pending `☐`, the in-progress step `▸` with its gerund `activeForm` ("Wiring
 * the controller") so the plan reads as live. Returns null when the input isn't
 * a usable todo array so callers can fall back.
 */
export function renderTodoChecklist(todos: unknown): string | null {
  if (!Array.isArray(todos) || todos.length === 0) return null;
  const lines: string[] = [];
  for (const item of todos) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const content = str(rec['content'] ?? rec['step'] ?? rec['title']).trim();
    if (!content) continue;
    const status = str(rec['status']).toLowerCase();
    const isDone = status === 'completed' || status === 'complete' || status === 'done';
    const isActive = status === 'in_progress' || status === 'in-progress' || status === 'active' || status === 'doing';
    const glyph = isDone ? TODO_DONE : isActive ? TODO_ACTIVE : TODO_OPEN;
    const label = isActive ? (str(rec['activeForm']).trim() || content) : content;
    lines.push(`${glyph} ${label}`);
  }
  if (lines.length === 0) return null;
  return lines
    .map((line, i) => (i === 0 ? `${RESULT_PREFIX}${line}` : `${RESULT_CONT}${line}`))
    .join('\n');
}

type Args = Record<string, unknown> | undefined;

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function firstUrl(args: Args): string {
  const a = args ?? {};
  const urls = a['urls'];
  if (Array.isArray(urls)) {
    const u = urls.find((x) => typeof x === 'string');
    if (u) return urls.length > 1 ? `${urlLabel(u)} (+${urls.length - 1})` : urlLabel(u);
  }
  if (typeof a['url'] === 'string') return urlLabel(a['url'] as string);
  return '…';
}

/**
 * Normalise a raw tool name to (displayName, kind). `kind` drives both the
 * argument we surface and the result summary.
 */
function classify(name: string): { display: string; kind: string } {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  if (n.includes('multiedit')) return { display: 'Update', kind: 'edit' };
  if (n.includes('edit') || n.includes('strreplace') || n.includes('applypatch')) return { display: 'Update', kind: 'edit' };
  if (n.includes('writefile') || n === 'write' || n.includes('createfile')) return { display: 'Write', kind: 'write' };
  if (n.includes('readfile') || n === 'read' || n.includes('catfile')) return { display: 'Read', kind: 'read' };
  if (n.includes('bash') || n.includes('executebash') || n.includes('shell') || n.includes('runcommand') || n === 'run' || n.includes('terminal')) return { display: 'Bash', kind: 'bash' };
  if (n.includes('websearch') || n === 'helia' || n.includes('search') && n.includes('web')) return { display: 'Web Search', kind: 'websearch' };
  if (n.includes('webfetch') || n.includes('webextract') || n === 'fetch') return { display: 'Fetch', kind: 'fetch' };
  if (n.includes('grep') || n.includes('ripgrep')) return { display: 'Search', kind: 'grep' };
  if (n.includes('glob') || n.includes('listfiles') || n.includes('findfiles')) return { display: 'Search', kind: 'glob' };
  if (n.includes('search')) return { display: 'Search', kind: 'grep' };
  if (n === 'todoread' || (n.includes('todo') && n.includes('read'))) return { display: 'Read Todos', kind: 'todoread' };
  if (n.includes('todo')) return { display: 'Update Todos', kind: 'todo' };
  if (n.includes('task') || n.includes('agent') || n.includes('spawn')) return { display: 'Task', kind: 'task' };
  if (n.includes('skill')) return { display: 'Skill', kind: 'skill' };
  if (n.includes('memory')) return { display: 'Memory', kind: 'memory' };
  if (n.includes('notebook')) return { display: 'Notebook', kind: 'notebook' };
  // Fall back: keep the model's name but drop snake_case underscores.
  const pretty = name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { display: pretty, kind: 'other' };
}

/** The single most salient argument, already trimmed for display. */
function primaryArg(kind: string, args: Args, cwd?: string): string {
  const a = args ?? {};
  switch (kind) {
    case 'bash':
      return truncate(str(a['command'] ?? a['cmd'] ?? a['script']), 72);
    case 'websearch':
      return a['query'] ? `"${truncate(str(a['query']), 60)}"` : '';
    case 'fetch':
      return firstUrl(args);
    case 'grep':
      return a['pattern'] ? `pattern: "${truncate(str(a['pattern']), 48)}"` : truncate(str(a['query']), 48);
    case 'glob':
      return truncate(str(a['pattern'] ?? a['path'] ?? a['glob']), 48);
    case 'todo':
    case 'todoread':
      return '';
    case 'task':
      return truncate(str(a['description'] ?? a['prompt'] ?? a['task']), 60);
    case 'skill':
      return truncate(str(a['name'] ?? a['skill']), 40);
    case 'read':
    case 'write':
    case 'edit': {
      const p = str(a['file_path'] ?? a['path'] ?? a['filename']);
      return p ? shortPath(p, cwd) : '';
    }
    default: {
      const p = str(a['file_path'] ?? a['path']);
      if (p) return shortPath(p, cwd);
      if (a['query']) return `"${truncate(str(a['query']), 48)}"`;
      if (a['pattern']) return truncate(str(a['pattern']), 48);
      if (a['command']) return truncate(str(a['command']), 60);
      if (a['url']) return urlLabel(str(a['url']));
      return '';
    }
  }
}

/** `⏺ Read(fibonacci.py)` — the one-line action header for a tool call. */
export function formatToolCall(name: string, args: Args, cwd?: string): string {
  const { display, kind } = classify(name);
  const arg = primaryArg(kind, args, cwd);
  return `${ACTION_BULLET} ${display}${arg ? `(${arg})` : ''}`;
}

/** The dim, present-tense label shown next to the working spinner. */
export function toolActivityLabel(name: string, args: Args, cwd?: string): string {
  const { display, kind } = classify(name);
  const arg = primaryArg(kind, args, cwd);
  switch (kind) {
    case 'bash': return arg ? `Running ${arg}` : 'Running command';
    case 'read': return arg ? `Reading ${arg}` : 'Reading file';
    case 'write': return arg ? `Writing ${arg}` : 'Writing file';
    case 'edit': return arg ? `Editing ${arg}` : 'Editing file';
    case 'websearch': return 'Searching the web';
    case 'fetch': return `Fetching ${arg}`;
    case 'grep':
    case 'glob': return 'Searching';
    case 'task': return 'Running subagent';
    case 'todo': return 'Updating todos';
    case 'todoread': return 'Reading todos';
    default: return `${display}…`;
  }
}

/** Drop the decorative noise the bash tool wraps failures in. */
function cleanBashResult(result: string): string {
  return result
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (/^═+/.test(t)) return false;                       // ═══ FAILED ═══
      if (/^Failed checks:/i.test(t)) return false;
      if (/^Suggested actions:/i.test(t)) return false;
      if (/^Command execution:/i.test(t)) return false;
      if (/^Command:\s/i.test(t)) return false;
      if (/^Output:\s*$/i.test(t)) return false;
      if (/^[✗→]/.test(t)) return false;                     // bullet checks/suggestions
      if (/^Command (failed|succeeded)/i.test(t)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build the dim `  ⎿  …` result block for a completed tool. Returns a single
 * multi-line string (continuation lines pre-indented) ready to emit as one
 * `tool-result` event. Long output collapses to a head with an overflow note,
 * exactly like Claude Code's `… +N lines (ctrl+o to expand)`.
 */
export function formatToolResult(
  name: string,
  result: string,
  args: Args,
  opts: { maxLines?: number } = {},
): string {
  const maxLines = opts.maxLines ?? 5;
  const { display, kind } = classify(name);
  const clean = stripAnsi(result ?? '').replace(/\s+$/, '');

  // Some tools (editTools: Create/Update/MultiEdit) already return a
  // Claude-style block whose first line is the `⏺ Name(arg)` header. The shell
  // emits that header itself at tool.start, so drop the duplicate first line
  // and keep the `⎿` summary + diff body verbatim.
  if (clean.startsWith(ACTION_BULLET)) {
    const nl = clean.indexOf('\n');
    const rest = nl >= 0 ? clean.slice(nl + 1).replace(/^\n+/, '') : '';
    return rest || `${RESULT_PREFIX}done`;
  }

  const text = clean.trim();

  // Concise one-line summaries where the result has a known shape.
  if (kind === 'read') {
    return `${RESULT_PREFIX}${readSummary(text)}`;
  }
  if (kind === 'write') {
    const p = primaryArg('write', args);
    return `${RESULT_PREFIX}Wrote ${p || 'file'}`;
  }
  if (kind === 'edit') {
    const p = primaryArg('edit', args);
    return `${RESULT_PREFIX}Updated ${p || 'file'}`;
  }
  if (kind === 'todo') {
    // Prefer the structured todos carried on the call; fall back to a summary
    // when the parameters didn't reach us (older event path).
    const checklist = renderTodoChecklist((args ?? {})['todos']);
    return checklist ?? `${RESULT_PREFIX}Todos updated`;
  }
  if (kind === 'todoread') {
    if (!text || /^no todos/i.test(text)) return `${RESULT_PREFIX}No todos`;
    try {
      const arr = JSON.parse(text) as unknown[];
      const checklist = renderTodoChecklist(arr);
      if (checklist) return checklist;
    } catch { /* fall through to generic */ }
    return `${RESULT_PREFIX}todos`;
  }

  const body = kind === 'bash' ? cleanBashResult(text) : text;
  if (!body) {
    return `${RESULT_PREFIX}${kind === 'bash' ? '(no output)' : `${display} complete`}`;
  }

  const allLines = body.split('\n');
  const shown = allLines.slice(0, maxLines);
  const out: string[] = shown.map((line, i) =>
    i === 0 ? `${RESULT_PREFIX}${line}` : `${RESULT_CONT}${line}`,
  );
  const overflow = allLines.length - shown.length;
  if (overflow > 0) {
    out.push(`${RESULT_CONT}… +${overflow} line${overflow === 1 ? '' : 's'} (ctrl+o to expand)`);
  }
  return out.join('\n');
}

/** Format a tool error as a red `  ⎿  Error: …` line. */
export function formatToolError(error: string): string {
  const clean = stripAnsi(error ?? '').trim().split('\n')[0] || 'failed';
  const msg = clean.replace(/^Error:\s*/i, '');
  return `${RESULT_PREFIX}Error: ${truncate(msg, 160)}`;
}
