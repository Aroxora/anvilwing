/**
 * Auto post-write diagnostics — Claude Code surfaces diagnostics on a file the
 * moment it's edited and feeds them back so the agent self-corrects, without
 * running the whole suite per edit. Anvilwing runs a fast, file-scoped syntax
 * check after each write/edit (src/core/postWriteDiagnostics.ts) wired into the
 * ToolRuntime.execute chokepoint.
 *
 * Tests run REAL checks on REAL temp files (no mocks): a syntax error must be
 * caught (ok=false + message), a clean file must pass (ok=true), and an
 * unsupported extension must be skipped. Source assertions lock the wiring.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { diagnoseWrittenFile, formatDiagnosticBlock } from '../src/core/postWriteDiagnostics.js';

const RUNTIME_SRC = readFileSync(resolve(__dirname, '..', 'src', 'core', 'toolRuntime.ts'), 'utf8');

function pythonAvailable(): boolean {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

describe('post-write diagnostics — real syntax checks on real files', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'anvilwing-diag-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  const write = (name: string, body: string): string => {
    const fp = join(dir, name);
    writeFileSync(fp, body);
    return fp;
  };

  it('flags a TypeScript syntax error with a line:col message', async () => {
    const d = await diagnoseWrittenFile(write('bad.ts', 'export function f(a, b { return a+b }'));
    expect(d.ok).toBe(false);
    expect(d.summary).toMatch(/expected/i);
  });

  it('passes clean TypeScript (no false positive from unresolved imports)', async () => {
    // Imports a module that doesn't exist — must NOT flag (syntax-only, no type/resolve check).
    const d = await diagnoseWrittenFile(write('ok.ts', "import { x } from './nowhere';\nexport const y: number = x + 1;\n"));
    expect(d.ok).toBe(true);
    expect(d.summary).toBeNull();
  });

  it('handles TSX (jsx) without spurious option errors', async () => {
    const d = await diagnoseWrittenFile(write('ok.tsx', 'export const C = () => <div>hi</div>;\n'));
    expect(d.ok).toBe(true);
  });

  it('flags a JavaScript syntax error via node --check', async () => {
    const d = await diagnoseWrittenFile(write('bad.js', 'function f( { return 1 }'));
    expect(d.ok).toBe(false);
    expect(d.summary).toBeTruthy();
  });

  it('passes clean JavaScript', async () => {
    const d = await diagnoseWrittenFile(write('ok.js', 'function f(){ return 1; }\n'));
    expect(d.ok).toBe(true);
  });

  it('flags invalid JSON', async () => {
    const d = await diagnoseWrittenFile(write('bad.json', '{ "a": 1, }extra'));
    expect(d.ok).toBe(false);
    expect(d.summary).toMatch(/JSON/i);
  });

  it('passes valid JSON', async () => {
    const d = await diagnoseWrittenFile(write('ok.json', '{ "a": 1 }'));
    expect(d.ok).toBe(true);
  });

  it('skips unsupported extensions (no false alarms on prose)', async () => {
    const d = await diagnoseWrittenFile(write('notes.txt', 'this ( is not ] balanced { code'));
    expect(d.ok).toBe(true);
    expect(d.summary).toBeNull();
  });

  it('skips a missing file gracefully', async () => {
    const d = await diagnoseWrittenFile(join(dir, 'does-not-exist.ts'));
    expect(d.ok).toBe(true);
  });

  (pythonAvailable() ? it : it.skip)('flags a Python syntax error via py_compile', async () => {
    const d = await diagnoseWrittenFile(write('bad.py', 'def f(:\n  return 1\n'));
    expect(d.ok).toBe(false);
  });

  it('formatDiagnosticBlock renders a warning only on failure', () => {
    expect(formatDiagnosticBlock({ ok: true, summary: null })).toBe('');
    expect(formatDiagnosticBlock({ ok: false, summary: "1:1 ';' expected." })).toMatch(/⚠ diagnostics/);
  });
});

describe('post-write diagnostics — wired into the ToolRuntime chokepoint', () => {
  it('ToolRuntime runs diagnostics after a successful edit/write (not under test env)', () => {
    expect(RUNTIME_SRC).toMatch(/import \{ diagnoseWrittenFile, formatDiagnosticBlock \}/);
    expect(RUNTIME_SRC).toMatch(/isEditTool\(call\.name\)/);
    expect(RUNTIME_SRC).toMatch(/diagnoseWrittenFile\(fp\)/);
    expect(RUNTIME_SRC).toMatch(/formatDiagnosticBlock\(diag\)/);
    // Skipped under test so the suite stays fast/deterministic.
    expect(RUNTIME_SRC).toMatch(/NODE_ENV'\]\s*!==\s*'test'/);
  });
});
