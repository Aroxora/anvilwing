/**
 * Post-write diagnostics — Claude Code surfaces diagnostics on a file the
 * moment it's edited (via its language server) and feeds them back so the
 * agent self-corrects, WITHOUT running the whole test suite per edit. Anvilwing
 * has no persistent LSP, so this runs a fast, file-scoped *syntax* check after
 * each write/edit and returns the errors. Deeper type-checking + the full test
 * suite stay at the ultracode verify-step (see src/config.ts).
 *
 * Fast + reliable per language, no project load:
 *   - .ts/.tsx       → TypeScript syntactic diagnostics (transpileModule)
 *   - .js/.jsx/.mjs/.cjs → `node --check`
 *   - .py            → `python3 -m py_compile`
 *   - .json          → JSON.parse
 *   - anything else  → skipped (clean)
 *
 * A missing checker (e.g. no python3) is treated as "skip", never an error —
 * the diagnostic must never block real work, only inform it.
 */

import { extname } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';

export interface WriteDiagnostic {
  /** false only when the changed file has a real, surfaced syntax error. */
  ok: boolean;
  /** The error text to feed back to the agent (capped), or null when clean/skipped. */
  summary: string | null;
}

const CLEAN: WriteDiagnostic = { ok: true, summary: null };
const MAX_BYTES = 2 * 1024 * 1024; // skip very large files — not worth the latency
const TIMEOUT_MS = 6000;

const JS_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs']);

function runChecker(cmd: string, args: string[]): Promise<{ failed: boolean; out: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ failed: false, out: '', missing: true }); // checker not installed → skip
        return;
      }
      resolve({ failed: Boolean(err), out, missing: false });
    });
  });
}

function cap(text: string, max = 600): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Diagnose a single just-written file. Returns ok=false with a capped error
 * summary only on a genuine syntax error in a supported language.
 */
export async function diagnoseWrittenFile(filePath: string): Promise<WriteDiagnostic> {
  if (!filePath) return CLEAN;
  const ext = extname(filePath).toLowerCase();

  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size > MAX_BYTES) return CLEAN;
  } catch {
    return CLEAN; // file gone / unreadable — nothing to diagnose
  }

  // JSON — parse in-process.
  if (ext === '.json') {
    try {
      JSON.parse(readFileSync(filePath, 'utf8'));
      return CLEAN;
    } catch (e) {
      return { ok: false, summary: cap(`JSON parse error: ${(e as Error).message}`) };
    }
  }

  // TypeScript — syntactic diagnostics via the compiler API (no type-check,
  // no project load, so no false positives from unresolved imports).
  if (ext === '.ts' || ext === '.tsx') {
    try {
      const tsMod = await import('typescript');
      const ts = (tsMod as { default?: typeof import('typescript') }).default ?? (tsMod as unknown as typeof import('typescript'));
      const source = readFileSync(filePath, 'utf8');
      // Only set jsx for .tsx — passing jsx:undefined makes transpileModule
      // emit a spurious "--jsx option" diagnostic (a global option error, not
      // a source error).
      const compilerOptions = ext === '.tsx'
        ? { noEmit: true, jsx: ts.JsxEmit.Preserve }
        : { noEmit: true };
      const result = ts.transpileModule(source, {
        reportDiagnostics: true,
        fileName: filePath,
        compilerOptions,
      });
      // Count only errors tied to the source file (d.file set) — that excludes
      // global/option diagnostics, leaving real syntax errors in the file.
      const syntactic = (result.diagnostics ?? []).filter(
        (d) => d.category === ts.DiagnosticCategory.Error && d.file,
      );
      if (syntactic.length === 0) return CLEAN;
      const msgs = syntactic.slice(0, 5).map((d) => {
        const text = ts.flattenDiagnosticMessageText(d.messageText, '\n');
        if (typeof d.start === 'number' && d.file) {
          const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
          return `${line + 1}:${character + 1} ${text}`;
        }
        return text;
      });
      return { ok: false, summary: cap(msgs.join('; ')) };
    } catch {
      return CLEAN; // typescript unavailable / threw — never block on the diagnostic itself
    }
  }

  // JavaScript family — `node --check` syntax validation.
  if (JS_EXT.has(ext)) {
    const { failed, out, missing } = await runChecker(process.execPath, ['--check', filePath]);
    if (missing || !failed) return CLEAN;
    return { ok: false, summary: cap(out || 'syntax error') };
  }

  // Python — `python3 -m py_compile`.
  if (ext === '.py') {
    const { failed, out, missing } = await runChecker('python3', ['-m', 'py_compile', filePath]);
    if (missing || !failed) return CLEAN;
    return { ok: false, summary: cap(out || 'syntax error') };
  }

  return CLEAN;
}

/** The block appended to a write/edit tool result when diagnostics fail. */
export function formatDiagnosticBlock(d: WriteDiagnostic): string {
  if (d.ok || !d.summary) return '';
  return `\n  ⎿  ⚠ diagnostics: ${d.summary}`;
}
