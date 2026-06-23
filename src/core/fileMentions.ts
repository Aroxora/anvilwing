/**
 * @-file mentions — like Claude Code, an `@path` in a prompt pulls that file's
 * content into the message the agent receives, so it can answer about a file
 * without a separate Read round-trip. This is the content-expansion half;
 * the typed autocomplete UI is layered on top separately.
 *
 * The user's VISIBLE prompt stays `@path` (committed to chat history as typed);
 * only the agent-bound copy is expanded — interactiveShell expands
 * `sanitizedPrompt` before `controller.send`.
 */

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { isAbsolute, resolve, join, relative } from 'node:path';

// Cap per file so a huge file can't blow the context; mentions over this are
// skipped (the agent can still Read them on demand).
const MAX_FILE_BYTES = 100 * 1024;
// A directory @-mention inlines its listing, not file contents — capped so a
// huge dir can't flood the prompt.
const MAX_DIR_ENTRIES = 200;

// `@token` only when the @ is at the start or right after whitespace — so
// `user@example.com` is NOT treated as a mention. The path runs until the next
// whitespace or @. Trailing sentence punctuation is trimmed off the path.
const MENTION = /(^|\s)@([^\s@]+)/g;

export interface FileMentionResult {
  /** The prompt to send to the agent (original + appended file blocks). */
  prompt: string;
  /** Mention paths that resolved to a readable file and were inlined. */
  included: string[];
}

function trimTrailingPunct(p: string): string {
  return p.replace(/[.,;:!?)\]}'"]+$/, '');
}

/**
 * Expand `@path` mentions in `prompt` by appending each referenced file's
 * content. Mentions that don't resolve to a readable, in-limit file are left
 * untouched (and not included). Returns the original prompt unchanged when
 * there are no resolvable mentions.
 */
export function expandFileMentions(prompt: string, workingDir: string): FileMentionResult {
  if (!prompt || !prompt.includes('@')) return { prompt, included: [] };

  const seen = new Set<string>();
  const blocks: string[] = [];
  const included: string[] = [];

  MENTION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION.exec(prompt)) !== null) {
    const ref = trimTrailingPunct(m[2] ?? '');
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);

    const abs = isAbsolute(ref) ? ref : resolve(workingDir, ref);
    try {
      const st = statSync(abs);
      if (st.isDirectory()) {
        // A directory mention inlines a bounded LISTING (Claude Code parity) —
        // the file/subdir names so the agent knows what's there, not the
        // contents. Heavy/vcs/dot dirs are dropped; entries are capped.
        let names: string[];
        try {
          names = readdirSync(abs, { withFileTypes: true })
            .filter((e) => !(e.isDirectory() && (IGNORE_DIRS.has(e.name) || e.name.startsWith('.'))))
            .slice(0, MAX_DIR_ENTRIES)
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .sort();
        } catch { continue; }
        const listing = names.length ? names.join('\n') : '(empty directory)';
        blocks.push(`@${ref} (directory listing):\n\`\`\`\n${listing}\n\`\`\``);
        included.push(ref);
        continue;
      }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const content = readFileSync(abs, 'utf8');
      blocks.push(`@${ref}:\n\`\`\`\n${content}\n\`\`\``);
      included.push(ref);
    } catch {
      // Not a readable file/dir — leave the @token in place, include nothing.
    }
  }

  if (blocks.length === 0) return { prompt, included: [] };
  return { prompt: `${prompt}\n\n--- Referenced files ---\n${blocks.join('\n\n')}`, included };
}

// ── @-mention autocomplete (the typing layer) ────────────────────────────────

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'coverage', 'build', '.next', '.cache', '.anvilwing', '.turbo', 'out',
]);

/**
 * List workspace files as repo-relative paths for @-mention completion. A
 * bounded recursive walk (not a glob engine): skips heavy/vcs/build dirs and
 * dot-directories, caps total files and depth so a giant tree can't stall the
 * prompt. New files appear on the next rebuild of this list.
 */
export function listWorkspaceFiles(workingDir: string, limit = 4000, maxDepth = 8): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= limit || depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        // Offer the directory itself as a completion candidate (trailing '/')
        // so `@src/` is mentionable, then recurse for its files.
        out.push(`${relative(workingDir, full)}/`);
        walk(full, depth + 1);
      } else if (e.isFile()) {
        out.push(relative(workingDir, full));
      }
    }
  };
  walk(workingDir, 0);
  return out;
}

/** The `@<partial>` immediately before the cursor, or null if none. '' = bare `@`. */
export function activeMentionPartial(text: string, cursor: number): string | null {
  const m = text.slice(0, Math.max(0, cursor)).match(/(?:^|\s)@([^\s@]*)$/);
  return m ? (m[1] ?? '') : null;
}

/** Files matching `partial`, ranked: basename-prefix < basename-substring < path-substring. */
export function rankFileMatches(partial: string, files: string[], limit = 8): string[] {
  const q = partial.toLowerCase();
  if (!q) return files.slice(0, limit);
  const scored: { f: string; score: number }[] = [];
  for (const f of files) {
    const lf = f.toLowerCase();
    const base = lf.slice(lf.lastIndexOf('/') + 1);
    let score = -1;
    if (base.startsWith(q)) score = 0;
    else if (base.includes(q)) score = 1;
    else if (lf.includes(q)) score = 2;
    if (score >= 0) scored.push({ f, score });
  }
  scored.sort((a, b) => a.score - b.score || a.f.length - b.f.length || (a.f < b.f ? -1 : 1));
  return scored.slice(0, limit).map((s) => s.f);
}

/** Replace the active `@<partial>` (ending at cursor) with `@path ` (trailing space). */
export function applyMentionCompletion(text: string, cursor: number, path: string): { text: string; cursor: number } {
  const upto = text.slice(0, cursor);
  const m = upto.match(/(?:^|\s)@([^\s@]*)$/);
  if (!m) return { text, cursor };
  const atIdx = cursor - (m[1] ?? '').length - 1; // index of '@'
  const before = text.slice(0, atIdx);
  const insert = `@${path} `;
  return { text: before + insert + text.slice(cursor), cursor: (before + insert).length };
}
