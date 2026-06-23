/**
 * CLAUDE_CODE_UX.md §9 enforcement — "no chrome emoji".
 *
 * The project's UI bet (src/ui/CLAUDE_CODE_UX.md) is that a Anvilwing session is
 * indistinguishable in *shape* from a Claude Code session. §9 explicitly bans
 * chrome emoji (📁 🧠 📝 📖 🔍 🌐 🔧 📌 ⏱ ⚙ ✨ 💾 📄 🗑 …). This is a
 * **source-assertion** test (no PTY / no Ink mount), so unlike the render-level
 * UI suites it runs on CI too — it's the per-iteration guard for the spec.
 *
 * A real regression it catches: `setStatusMessage('🔄 Analyzing request...')`
 * leaked a 🔄 into the spinner line (rendered `· 🔄 Analyzing request…`),
 * violating §9 and §4 (labels are plain gerunds).
 *
 * Allowed (NOT emoji / explicitly sanctioned by the spec, so excluded from the
 * banned set): the welcome/spinner sparkles `✻ ✢ ✳ ✶ ✽` (§4/§7) and the warning
 * glyph `⚠`. The follow-up-queue hourglass `⏳` was de-sanctioned (§10 now
 * matches §9: no chrome emoji) — it is in the banned set.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');

// §9's banned chrome emoji + the 🔄 the spinner once leaked + the common
// status-line offenders. Deliberately omits the asterisk/dingbat sparkles
// ✻ ✢ ✳ ✶ ✽ (the spinner cycle, §4).
const BANNED = [
  '🔄', '🧠', '📁', '📝', '📖', '🔍', '🌐', '🔧', '📌', '⏱', '⚙', '✨', '⏳',
  '💾', '📄', '🗑', '✅', '🚀', '🤔', '💭', '🎯', '📊', '🔥', '👍', '❌', '🎉',
];
const bannedRe = new RegExp(`(${BANNED.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`);

// The live chrome surface: the shell that drives status/activity, the Ink
// components that render the screen, and the shared theme icon map (its banned
// emoji were removed in the F7 minimalism pass — keep them gone). The .md spec
// itself is out of scope.
function chromeFiles(): string[] {
  const inkDir = path.join(REPO_ROOT, 'src/ui/ink');
  const ink = fs.readdirSync(inkDir).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts')).map((f) => path.join(inkDir, f));
  return [
    path.join(REPO_ROOT, 'src/headless/interactiveShell.ts'),
    path.join(REPO_ROOT, 'src/ui/theme.ts'),
    ...ink,
  ];
}

describe('CLAUDE_CODE_UX.md §9 — no chrome emoji (CI-runnable spec guard)', () => {
  test.each(chromeFiles().map((f) => [path.relative(REPO_ROOT, f), f] as const))(
    '%s contains no banned chrome emoji',
    (_rel, file) => {
      const src = fs.readFileSync(file, 'utf8');
      const offenders: string[] = [];
      src.split('\n').forEach((line, i) => {
        const m = line.match(bannedRe);
        if (m) offenders.push(`  L${i + 1}: ${m[1]}  →  ${line.trim().slice(0, 80)}`);
      });
      expect(offenders.join('\n')).toBe('');
    },
  );

  test('ChatStatic separates consecutive ⏺ blocks with one blank line, hugs ⎿ results (§1)', () => {
    // §1: distinct ⏺ paragraphs get one blank line between them; a tool-result
    // (kind 'toolResult', the ⎿ line) hugs the action above it. The render-level
    // proof is in test/ink-controller.test.ts ('chat-spacing'); this is the
    // CI-runnable guard that the spacing logic isn't refactored away.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/ui/ink/ChatStatic.tsx'), 'utf8');
    // §3 extension: a failed tool's `⎿ Error:` line (kind 'error', shaped as a
    // result) hugs its call the same way a toolResult does.
    expect(src).toMatch(/marginTop=\{index > 0 && item\.kind !== 'toolResult' && !\(item\.kind === 'error' && \/\^\\s\*⎿\/\.test\(item\.text\)\) \? 1 : 0\}/);
  });

  test('ChatStatic renders a tool call with the NAME bold and the argument PLAIN (§2/§47)', () => {
    // §47: "The tool name is bold; the argument is plain." The render-level
    // proof (bold closes before the "(") is in test/ink-controller.test.ts; this
    // guards that the tool branch keeps splitting name vs arg at the first "(".
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/ui/ink/ChatStatic.tsx'), 'utf8');
    expect(src).toMatch(/body\.indexOf\('\('\)/);
    expect(src).toMatch(/<Text bold>\{name\}<\/Text>/);
    // The old whole-body-bold path (Action body bold) must be gone.
    expect(src).not.toMatch(/<Action body=\{body\} bold \/>/);
  });

  test('the mode/meta line uses single-space " · " separators, never doubled (§6)', () => {
    // §6: "a single dim line, ` · `-separated". The render-level proof is in
    // test/ink-controller.test.ts; this pins the builder against a refactor that
    // re-pads the separator.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/ui/ink/InkPromptController.ts'), 'utf8');
    expect(src).toMatch(/parts\.join\(' · '\)/);
    expect(src).not.toMatch(/join\('  ·  '\)/);
  });

  test('below-box rows: toggle-modes strip (row 1) then meta line (row 2) (§5/§6)', () => {
    // §5 deviation (user-requested): a persistent 3-mode strip replaces the
    // active-mode-only hint. Strip data is pure (permissionModeStrip); App
    // renders it per-segment so the highlight is a real color, and the meta
    // line moved below the strip — StatusLine keeps only the spinner row.
    const perm = fs.readFileSync(path.join(REPO_ROOT, 'src/core/permissionMode.ts'), 'utf8');
    expect(perm).toMatch(/'⏵ default'/);
    expect(perm).toMatch(/'⏵⏵ accept edits'/);
    expect(perm).toMatch(/'⏸ plan'/);
    expect(perm).toMatch(/'shift\+tab — \? for shortcuts'/);
    expect(perm).toMatch(/'shift\+tab to cycle'/);
    const app = fs.readFileSync(path.join(REPO_ROOT, 'src/ui/ink/App.tsx'), 'utf8');
    expect(app).toMatch(/permissionStrip/);
    expect(app).toMatch(/metaLine/);
    // The hint falls back to the LIVE module state (permissionMode owns the
    // "? for shortcuts" wording, pinned on `perm` above) — a hardcoded literal
    // here would contradict the strip outside default mode.
    expect(app).toMatch(/permissionHint \?\? permissionHintFn\(\)/);
    const statusLine = fs.readFileSync(path.join(REPO_ROOT, 'src/ui/ink/StatusLine.tsx'), 'utf8');
    expect(statusLine).not.toMatch(/modeMessage/);
    const ctrl = fs.readFileSync(path.join(REPO_ROOT, 'src/ui/ink/InkPromptController.ts'), 'utf8');
    expect(ctrl).toMatch(/permissionStrip: permissionModeStrip\(\)/);
    expect(ctrl).toMatch(/metaLine: modeChips/);
  });

  test('spinner/status setters pass plain gerund labels, never an emoji (§4)', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/headless/interactiveShell.ts'), 'utf8');
    const setterRe = /set(?:StatusMessage|ActivityMessage|OverrideStatus|StreamingLabel)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
    const violations: string[] = [];
    for (const m of src.matchAll(setterRe)) {
      if (bannedRe.test(m[2]!)) violations.push(m[2]!);
    }
    expect(violations).toEqual([]);
  });
});
