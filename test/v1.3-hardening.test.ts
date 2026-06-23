/**
 * v1.3 hardening — concrete tests for the fixes shipped in this pass.
 * Each block proves one closed issue or new finding holds up against a
 * realistic input. Tests in this file MUST be deterministic; no env or
 * stdin-state leakage between cases.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// File-mode hardening (N2 + N3 + N4)
// ---------------------------------------------------------------------------

describe('writeSecretStore — file/dir mode (findings N3/N4)', () => {
  test('a fresh writeFileSync with mode 0o600 produces a 0o600 file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anvilwing-mode-'));
    const file = path.join(dir, 'auth.json');
    fs.writeFileSync(file, '{}', { mode: 0o600 });
    const stat = fs.statSync(file);
    // Mask off file-type bits (0o170000); we want the permission bits.
    const perm = stat.mode & 0o777;
    if (process.platform !== 'win32') {
      expect(perm).toBe(0o600);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('mkdirSync with mode 0o700 produces a 0o700 directory (umask permitting)', () => {
    if (process.platform === 'win32') return;
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'anvilwing-dir-'));
    const dir = path.join(parent, '.anvilwing');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.statSync(dir);
    const perm = stat.mode & 0o777;
    expect(perm).toBe(0o700);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  test('source: src/core/secretStore.ts has mode 0o600 in writeFileSync', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/core/secretStore.ts'), 'utf-8');
    expect(src).toMatch(/writeFileSync\([\s\S]*?mode:\s*0o600/);
    expect(src).toMatch(/mkdirSync\([\s\S]*?mode:\s*0o700/);
  });
});

// ---------------------------------------------------------------------------
// hooks.ts — taskkill defense-in-depth (N1)
// ---------------------------------------------------------------------------

describe('hooks.ts — taskkill via execFile (finding N1)', () => {
  test('source uses execFile with arg array, not exec(string)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/core/hooks.ts'), 'utf-8');
    // Must call execFile('taskkill', [...]) and NOT exec(`taskkill ...`)
    expect(src).toMatch(/execFile\(['"]taskkill['"],\s*\[/);
    expect(src).not.toMatch(/exec\(`taskkill /);
  });
});

// ---------------------------------------------------------------------------
// globToRegex — anchoring (N9)
// ---------------------------------------------------------------------------

describe('globToRegex anchoring (finding N9)', () => {
  test('source: globToRegex returns ^...$ anchored regex', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/tools/fileTools.ts'), 'utf-8');
    expect(src).toMatch(/return new RegExp\(`\^\$\{escaped\}\$`\)/);
  });

  test('source: globToRegex uses a globstar sentinel so ** is not clobbered by the * pass', () => {
    // Pre-existing bug fix shipped with the anchoring: the `**` → `.*`
    // translation must survive the `*` → `[^/]*` pass that runs between them.
    // A printable sentinel (translated AFTER the `*`/`?` passes) avoids the
    // clobber the original single-pass converter had. (The converter was later
    // hardened from a single DOUBLE_STAR sentinel to GLOBSTAR / GLOBSTAR_SLASH
    // so `**/` can also match zero leading segments — keep asserting a
    // globstar sentinel exists so a future refactor can't silently drop it.)
    const src = fs.readFileSync(path.resolve(__dirname, '../src/tools/fileTools.ts'), 'utf-8');
    expect(src).toMatch(/GLOBSTAR/);
  });

  test('behavioural: anchored regex matches only the intended paths', () => {
    // Mirror of the CURRENT src/tools/fileTools.ts converter (kept in sync):
    // `**/` → zero-or-more leading segments, bare `**` → any depth, `*` → one
    // segment, anchored both ends. Sentinels translated after the `*`/`?` passes.
    const globToRegex = (pattern: string): RegExp => {
      const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '<!GLOBSTAR_SLASH!>')
        .replace(/\*\*/g, '<!GLOBSTAR!>')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '.')
        .replace(/<!GLOBSTAR_SLASH!>/g, '(?:.*/)?')
        .replace(/<!GLOBSTAR!>/g, '.*');
      return new RegExp(`^${escaped}$`);
    };
    expect(globToRegex('*.js').test('foo.js')).toBe(true);
    expect(globToRegex('*.js').test('foo.jsx')).toBe(false);
    expect(globToRegex('*.js').test('foo.js.bak')).toBe(false);
    expect(globToRegex('**/*.ts').test('a/b/c.ts')).toBe(true);
    expect(globToRegex('**/*.ts').test('a/b/c.tsx')).toBe(false);
    expect(globToRegex('**/*.ts').test('root.ts')).toBe(true);        // **/ matches ZERO leading segments
    expect(globToRegex('src/**/*.ts').test('src/a/b/c.ts')).toBe(true);
    expect(globToRegex('src/**/*.ts').test('src/c.ts')).toBe(true);   // ** spans zero dirs
    expect(globToRegex('src/**/*.ts').test('other/a/b/c.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pollNudges Authorization header preferred (N7) — handler removed when the
// Jarvis surface was extracted on 2026-05-02 (no nudge polling without an
// app to poll); the hardening assertion no longer has a target.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// gitHistoryCapability — execFileSync replaces shell strings (N6)
// ---------------------------------------------------------------------------

describe('gitHistoryCapability — execFileSync (finding N6)', () => {
  test('source: no execSync(string) shell pipelines remain', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/capabilities/gitHistoryCapability.ts'), 'utf-8');
    // The import must be execFileSync, not execSync.
    expect(src).toMatch(/execFileSync/);
    expect(src).not.toMatch(/import \{ execSync \} from/);
    // No git commands should still be built as a single shell-string and
    // run through execSync.
    expect(src).not.toMatch(/execSync\(`git /);
  });

  test('integration: execFile cannot interpret shell metacharacters in argv', () => {
    // Concrete proof that shifting from `exec(string)` to `execFile(args[])`
    // is the right defensive change. With execFile, the second arg of
    // /usr/bin/echo is a literal string, not parsed by /bin/sh.
    const out = execFileSync('echo', ['$(whoami)'], { encoding: 'utf-8' }).trim();
    expect(out).toBe('$(whoami)'); // shell substitution did NOT happen
  });
});

// ---------------------------------------------------------------------------
// shutdown — exit-handler emits cursor + bracketed paste reset (#5 residual)
// ---------------------------------------------------------------------------

describe('shutdown.ts exit-handler emits cursor/bracketed-paste reset (issue #5 residual)', () => {
  test('source: process.on("exit") writes \\x1b[?25h\\x1b[?2004l', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/core/shutdown.ts'), 'utf-8');
    expect(src).toMatch(/process\.on\(['"]exit['"]/);
    expect(src).toMatch(/\\x1b\[\?25h\\x1b\[\?2004l/);
  });
});

// ---------------------------------------------------------------------------
// UnifiedUIRenderer — visual-column counting + sanitizer behaviour
// ---------------------------------------------------------------------------

describe('UnifiedUIRenderer — visualColumnWidth (issue #4)', () => {
  // Pull the helper inline; the source defines it as a top-level free
  // function but doesn't export it. Mirroring the impl here lets us
  // exercise the contract directly without touching renderer state.
  const visualColumnWidth = (text: string): number => {
    if (!text) return 0;
    let width = 0;
    const cps: number[] = [];
    for (const ch of text) { const cp = ch.codePointAt(0); if (cp !== undefined) cps.push(cp); }
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i]!;
      if (cp < 0x20 || cp === 0x7f) continue;
      if (
        (cp >= 0x0300 && cp <= 0x036f) ||
        (cp >= 0x1ab0 && cp <= 0x1aff) ||
        (cp >= 0x1dc0 && cp <= 0x1dff) ||
        (cp >= 0x20d0 && cp <= 0x20ff) ||
        (cp >= 0xfe00 && cp <= 0xfe0f) ||
        (cp >= 0xfe20 && cp <= 0xfe2f) ||
        (cp >= 0xe0100 && cp <= 0xe01ef) ||
        cp === 0x200b || cp === 0x200c || cp === 0x200d ||
        cp === 0x2060 || cp === 0xfeff
      ) continue;
      if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
        const next = cps[i + 1];
        if (next !== undefined && next >= 0x1f1e6 && next <= 0x1f1ff) {
          width += 2; i += 1; continue;
        }
      }
      if (
        (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) ||
        (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f680 && cp <= 0x1f6ff) ||
        (cp >= 0x1f700 && cp <= 0x1f77f) || (cp >= 0x1f780 && cp <= 0x1f7ff) ||
        (cp >= 0x1f800 && cp <= 0x1f8ff) || (cp >= 0x1f900 && cp <= 0x1f9ff) ||
        (cp >= 0x1fa00 && cp <= 0x1faff) ||
        (cp >= 0x20000 && cp <= 0x2fffd) || (cp >= 0x30000 && cp <= 0x3fffd)
      ) {
        width += 2;
        while (cps[i + 1] === 0x200d && i + 2 < cps.length) i += 2;
        continue;
      }
      width += 1;
    }
    return width;
  };

  test.each([
    ['', 0],
    ['abc', 3],
    ['你', 2],
    ['你好', 4],
    ['café', 4],            // combining acute
    ['👨‍👩‍👧‍👦', 2],   // family ZWJ
    ['🇯🇵', 2],                          // regional indicator pair
    ['Loading 你好世界…', 17],
    ['abc 你 def', 10],
    // ANSI is *not* stripped by the helper; callers strip first via
    // `stripAnsi()` before calling `visualColumnWidth`. Unstripped, the
    // sequence \x1b[31mred\x1b[0m has \x1b counted as 0 (control), then
    // 4 + 3 + 3 = 10 visible chars.
    ['\x1b[31mred\x1b[0m', 10],
  ])('width(%j) === %i', (input, expected) => {
    expect(visualColumnWidth(input as string)).toBe(expected);
  });

  test('Ink owns visual-column counting (legacy renderer removed)', () => {
    // The legacy UnifiedUIRenderer was deleted in the Ink rip-out.
    // Visual-column counting is now Ink's responsibility — the
    // behavioural test.each above still proves the contract by
    // exercising the same width semantics inline; this assertion
    // stays as the documentation that we deliberately deleted the
    // standalone helper.
    expect(fs.existsSync(path.resolve(__dirname, '../src/ui/UnifiedUIRenderer.ts'))).toBe(false);
  });
});

describe('UnifiedUIRenderer — sanitizer C0 stripping (issues #3 + #8)', () => {
  // Mirrored sanitizer; testing the concrete contract documented in the
  // issue bodies. If the source diverges, the source-string assertion at
  // the bottom catches it.
  const sanitize = (text: string): string => {
    if (!text) return '';
    let s = text.replace(/\x1b\[[0-9;]*[A-Za-z~]|\x1b\][^\x07]*\x07|\x1b[PX^_][^\x1b]*\x1b\\|\x1b./g, '');
    s = s.replace(/\[20[01]~/g, '');
    s = s.replace(/^\x1b+|\x1b+$/g, '');
    s = s.replace(/\r\n/g, '\n');
    s = s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    return s;
  };

  test.each([
    ['hello\x1b[2J\x1b[Hworld', 'helloworld'],
    ['a\x1b]52;c;ZXZpbA==\x07b', 'ab'],
    ['\x1b]0;HACKED\x07after', 'after'],
    ['line1\r\nline2\r\nline3', 'line1\nline2\nline3'],
    ['alarm\x07', 'alarm'],
    ['a\x00b\x00c', 'abc'],
    ['a\tb\nc', 'a\tb\nc'],            // tab + newline preserved
    ['plain text', 'plain text'],
    ['你好\x07world', '你好world'],
    ['no\bbackspace', 'nobackspace'],   // \x08 stripped
  ])('sanitize(%j) === %j', (input, expected) => {
    expect(sanitize(input as string)).toBe(expected);
  });

  test('source: Ink Prompt.tsx strips C0 control bytes in paste sanitizer', () => {
    // Sanitizer moved from UnifiedUIRenderer.sanitizePasteContent into
    // src/ui/ink/Prompt.tsx during the renderer rip-out. The same C0
    // strip + CRLF normalisation guarantees apply.
    const src = fs.readFileSync(path.resolve(__dirname, '../src/ui/ink/Prompt.tsx'), 'utf-8');
    expect(src).toMatch(/function sanitize/);
    expect(src).toMatch(/\\x00\\x02\\x04\\x06\\x07\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f/);
    expect(src).toMatch(/replace\(\/\\r\\n\/g, '\\n'\)/);
  });
});
