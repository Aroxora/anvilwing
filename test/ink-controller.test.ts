/**
 * Phase 6 — InkPromptController integration. Proves the Ink-backed
 * controller satisfies the surface that interactiveShell.ts uses, via
 * a real subprocess that mounts the controller through the same
 * `createPromptController` factory production code goes through.
 *
 * Per CLAUDE.md "Tests run real": no mocks for Ink, no stub for the
 * controller. Outcome markers in the harness are surfaced via stderr
 * so the test asserts on real behaviour the production CLI would
 * observe.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'ink-controller-smoke.mjs');
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILT = path.resolve(REPO_ROOT, 'dist', 'ui', 'ink', 'InkPromptController.js');

interface RunResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

async function run(scenario: string, stdinBytes: string = '', dwellMs = 800): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT, scenario], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    if (stdinBytes) {
      setTimeout(() => child.stdin.write(stdinBytes), 200);
    }
    child.on('exit', (code) => resolve({ exitCode: code, stdout, stderr }));
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, dwellMs + 8_000);
    setTimeout(() => { try { child.stdin.end(); } catch { /* noop */ } }, dwellMs);
  });
}

jest.setTimeout(20_000);
// Ink subprocess tests spawn a node child + mount Ink + drive timed keystrokes;
// under CPU contention (CI 2-core, loaded local) the async mount/render can lag
// a fixed dwell. Retry transient timing flakes — a real break fails all attempts.
jest.retryTimes(3);

describe('InkPromptController — Phase 6 integration', () => {
  beforeAll(() => {
    if (!fs.existsSync(BUILT)) {
      throw new Error(`dist artifact missing: ${BUILT}\nRun: npx tsc -p tsconfig.json`);
    }
  });

  test('addEvent → ChatStatic flow committed via the renderer shim', async () => {
    const r = await run('addEvent-flow');
    // The harness prints HISTORY-COUNT for diagnostic; the more
    // important assertion is that the rendered frame contains the
    // history items (proving the shim wrote them through to Ink).
    expect(r.stdout).toContain('WELCOME-LINE');
    expect(r.stdout).toContain('system-line');
    expect(r.stdout).toContain('assistant-line');
    expect(r.stdout).toContain('tool-line');
  });

  test('mode toggles update controller state without throwing', async () => {
    const r = await run('mode-toggle');
    expect(r.stderr).toContain('AUTO: off');
    expect(r.stderr).toContain('HITL: on');
  });

  test('each tool call renders its own ⏺ action line — results never stack under one', async () => {
    const r = await run('multi-tool');
    const clean = r.stdout.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    expect((clean.match(/⏺ Read/g) ?? []).length).toBe(3);
    expect((clean.match(/⎿/g) ?? []).length).toBe(3);
    expect(clean).toContain('file1.ts');
    expect(clean).toContain('file2.ts');
    expect(clean).toContain('file3.ts');
  });

  test('a re-streamed body interleaved with tool calls renders ONCE, not once per tool (BUG A)', async () => {
    // The model re-streams the same narration before each of 8 tool calls; each
    // tool event flushes the partial via _finalizeStreamingIfAny. Before the
    // scan-back dedup, the interleaved tool entry broke the last-entry-only
    // collapse and the body stacked 8× (the real bug stacked ~30×). The body
    // must now appear exactly once while all 8 tool rounds still render.
    const r = await run('stream-dup-interleaved', '', 1500);
    const clean = r.stdout.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    expect((clean.match(/Here is what was upgraded/g) ?? []).length).toBe(1);
    expect((clean.match(/Bash\(grep round/g) ?? []).length).toBe(8);
  });

  test('the DONE: completion sentinel renders as a clean ✓ summary, never raw "DONE:"', async () => {
    const r = await run('done-sentinel');
    const clean = r.stdout.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    expect(clean).toContain('Fixed the off-by-one'); // the real narration survives
    expect(clean).toContain('✓ edited src/loop.ts; npm test exited 0'); // styled summary
    expect(clean).not.toMatch(/DONE:/); // the machine marker never leaks
  });

  test('assistant Markdown renders to themed ANSI (headings, bold, table) — no raw markers', async () => {
    const r = await run('markdown-render');
    const clean = r.stdout.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    // Content preserved.
    expect(clean).toContain('Phase One');
    expect(clean).toContain('make data');
    expect(clean).toContain('index.html');
    // No raw Markdown markers leaked into the transcript.
    expect(clean).not.toMatch(/##/);
    expect(clean).not.toContain('**');
    expect(clean).not.toMatch(/\|---/);
    // Table rendered as box drawing; heading is bold; inline code is ice-cyan.
    expect(clean).toMatch(/[│─┼┌┐└┘├┤]/);
    expect(r.stdout).toMatch(/\x1b\[1m/);
    expect(r.stdout).toMatch(/38;2;100;210;255/);
  });

  test('user submission lands in chat history (the bug 1.1.0/1/2 missed)', async () => {
    // The legacy renderer auto-emitted 'prompt' events on submit; the
    // Ink path wasn't doing that, so user input vanished from the
    // visible transcript. Asserting on the actual rendered stdout is
    // the test that should have caught this before the first ship.
    const r = await run('submit-to-history');
    const stripped = r.stdout
      .replace(/\x1b\[\??[0-9;]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b./g, '');
    expect(stripped).toContain('hello world');
    // The harness fires SUBMIT on the host callback after history was
    // updated. If history wasn't updated, "hello world" wouldn't be
    // in the rendered frame at all (the prompt buffer clears on
    // submit, so it can't be the buffer rendering still).
    expect(r.stderr).toContain('SUBMIT: hello world');
  });

  test('a committed user turn carries the `> ` marker (Claude Code parity)', async () => {
    // Drives addUserHistoryItem directly (NOT the input buffer), so the only
    // place `> ` can come from is the committed user-line rendering — the input
    // box prompt prefix never holds this text. Fail-before: the committed line
    // was bare text with no marker.
    const r = await run('user-marker');
    const stripped = r.stdout
      .replace(/\x1b\[\??[0-9;]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b./g, '');
    expect(stripped).toMatch(/> COMMITTED_USER_LINE/);
  });

  test('prompt buffer clears after submit (the 1.1.7 bug)', async () => {
    // Bug shipped in 1.1.7: after submit, the bordered prompt box
    // still showed the typed text. Cause was the Prompt component's
    // ref-state not syncing when the host cleared `initial`. Fixed
    // by adding a useEffect that resets stateRef when `initial`
    // diverges from what's already in the ref. The harness logs the
    // buffer state at the moment the host's onSubmit fires —
    // BUFFER-AFTER-SUBMIT must be the empty string.
    const r = await run('submit-to-history');
    expect(r.stderr).toContain('BUFFER-AFTER-SUBMIT: ""');
    expect(r.stderr).not.toMatch(/BUFFER-AFTER-SUBMIT: "hello world"/);
  });

  test('typed input does NOT accumulate in the box across submits (helloworld bug)', async () => {
    // The 1.1.7 useEffect only clears the box when the host's `initial` prop
    // CHANGES to '' — but for TYPED input `initial` stays '' the whole time
    // (typed keystrokes live in the Prompt's own ref, never in the host
    // buffer). So that fix never fired for the common case: the box kept the
    // submitted text and the next line appended ("alpha" + "bravo" =
    // "alphabravo"). Verified against the real binary. The fix is the Prompt
    // self-clearing its ref on submit. This drives REAL keystrokes (not
    // setBuffer) so it exercises that exact path.
    const r = await run('double-submit', '', 1200);
    expect(r.stderr).toContain('SUBMIT-DOUBLE: done');
    const stripped = r.stdout
      .replace(/\x1b\[\??[0-9;]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b./g, '');
    // Both messages were typed; neither may have merged in the input box.
    expect(stripped).toContain('alpha');
    expect(stripped).toContain('bravo');
    expect(stripped).not.toContain('alphabravo');
  });

  test('streaming deltas coalesce; thoughts filtered; final response commits once', async () => {
    const r = await run('stream-coalesce');
    // The reasoning text MUST NOT appear in the rendered frame —
    // before the fix this leaked as a chat bubble above the answer.
    expect(r.stdout).not.toContain('this is reasoning the user should NOT see');
    // The committed final must appear (rendered as the assistant
    // bubble after 'response' arrives).
    expect(r.stdout).toContain('Hi there!');
    // None of the partial streaming chunks should appear as their
    // own ChatItem — coalescing means the running text grows in
    // place. We can't directly assert on history shape from outside
    // the process, but we CAN assert the canonical line shape: the
    // word "Hi" should not appear on its own line followed by
    // " there" on a new line. We strip ANSI then check.
    const stripped = r.stdout
      .replace(/\x1b\[\??[0-9;]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b./g, '');
    // The bug pattern we're guarding against: each token on its own line.
    expect(stripped).not.toMatch(/^Hi$/m);
    expect(stripped).not.toMatch(/^ there$/m);
    expect(stripped).not.toMatch(/^!$/m);
  });

  test('interactive menu: arrow + Enter fires the selection callback (unreachable pre-Ink-menu)', async () => {
    const r = await run('menu-select');
    // Enter fires the callback with a real selected item id — the flow that
    // was impossible before the Ink menu. Which item lands depends on
    // keystroke timing on slow CI runners, so accept any valid selection.
    // (We assert on the callback, not on a captured menu frame: Ink's
    // log-update overwrites the menu the instant it closes, so the title
    // frame is racy to capture across environments.)
    expect(r.stderr).toMatch(/MENU-SELECTED: (one|two|three)\b/);
  });

  test('HITL decision renders as an in-app menu and the pick flows back through requestDecision', async () => {
    // The real flow: setDecisionPresenter → getHITL().requestDecision → the
    // options render as a menu below the prompt (Ink), ↑↓+Enter selects, and
    // the chosen id resolves the requestDecision() promise. Which option lands
    // depends on keystroke timing on slow runners, so accept any valid id —
    // the point is the decision resolved through the in-app menu, not the
    // screen-clearing raw-mode fallback.
    const r = await run('hitl-decision', '', 1200);
    expect(r.stderr).toMatch(/HITL-CHOSEN: [abcd]\b/);
    // Bottom-anchored compact Q&A popup (Claude Code / opencode): the question
    // and a rounded border render together — not a bare list under a scrolled
    // question. The question text and at least one round-border glyph appear.
    expect(r.stdout).toContain('Pick a scope');
    expect(r.stdout).toMatch(/[╭╮╰╯─]/);
  });

  test('production presentHitlDecision wires the boxed popup (source guard)', () => {
    const shell = fs.readFileSync(
      path.resolve(REPO_ROOT, 'src', 'headless', 'interactiveShell.ts'),
      'utf8',
    );
    // The question goes INTO the popup (question:/boxed:true), not addEvent'd
    // into scrollback above a bare menu.
    expect(shell).toMatch(/question: request\.title/);
    expect(shell).toMatch(/boxed: true/);
  });

  test('interactive menu: Ctrl+C cancels with a null selection', async () => {
    const r = await run('menu-cancel');
    expect(r.stderr).toContain('MENU-SELECTED: null');
  });

  test('Shift+Tab cycles the permission mode and moves the strip highlight', async () => {
    // Drives real CSI \x1b[Z bytes through the real Prompt → controller →
    // permissionMode → App strip path (no PTY needed). The full-binary PTY
    // variant lives in test/e2e-permission-mode.test.ts (skips where a PTY
    // can't fork). MODE markers are the cycle source of truth; the rendered
    // stdout proves the strip + highlight reached the screen. The harness
    // forces truecolor, so the active label carries the ember escape
    // (#ff9f43 → 38;2;255;159;67) — the highlight is real, not a joined string.
    const r = await run('permission-cycle', '', 1600);
    const modes = r.stderr.split('\n').filter((l) => l.startsWith('MODE: ')).map((l) => l.slice(6));
    expect(modes).toEqual(['default', 'acceptEdits', 'plan', 'default']);
    // The highlight landed on each mode label in turn.
    expect(r.stdout).toContain('38;2;255;159;67m⏵ default');
    expect(r.stdout).toContain('38;2;255;159;67m⏵⏵ accept edits');
    expect(r.stdout).toContain('38;2;255;159;67m⏸ plan');
    const stripped = r.stdout
      .replace(/\x1b\[\??[0-9;]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b./g, '');
    // All three labels render in one strip row.
    expect(stripped).toMatch(/⏵ default · ⏵⏵ accept edits · ⏸ plan · /);
    // The trailing hint swaps with the mode.
    expect(stripped).toContain('shift+tab — ? for shortcuts');
    expect(stripped).toContain('shift+tab to cycle');
    // Shift+Tab must not leak as visible text (the escape is consumed).
    expect(stripped).not.toContain('[Z');
  });

  test('setMetaStatus renders ↑ tokens on the spinner row and context % on the meta line; NaN payloads never corrupt them', async () => {
    // The behavioural half the source-regex tripwires in
    // test/turn-token-meter.test.ts can't see: a REAL controller call to
    // setMetaStatus({outputTokens, contextTokens, tokenLimit}) must reach the
    // rendered frame via buildTree → StatusLine / formatModeChips. The
    // scenario then injects NaN / zero-limit payloads (lax OpenAI-compatible
    // proxies); the chips must hold their last good values.
    const r = await run('spinner-meta', '', 1400);
    const stripped = r.stdout
      .replace(/\x1b\[\??[0-9;]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b./g, '');
    expect(stripped).toContain('↑ 1.2k tokens');     // spinner row: 1234 → 1.2k
    expect(stripped).toContain('50% context left');  // meta line: 50k/100k used → 50% left
    expect(stripped).not.toContain('NaN');
  });

  test('write/edit tool results render a COLORED diff (green additions, red removals)', async () => {
    // The diff lines from src/tools/diffUtils.ts are colorized in ChatStatic:
    // additions emerald (#28c840 → 38;2;40;200;64), removals ruby (#ff4d3d →
    // 38;2;255;77;61). The smoke harness forces truecolor so the RGB escapes
    // are deterministic. This is the "colored diff after each write/edit"
    // feature — verified on the real rendered output, not a mock.
    const r = await run('diff-colors', '', 1400);
    expect(r.stdout).toMatch(/38;2;40;200;64/);  // emerald — additions
    expect(r.stdout).toMatch(/38;2;255;77;61/);  // ruby — removals
  });

  test('a plan (TodoWrite) renders as a colored checklist — active step ember-bold', async () => {
    // The plan and its updates must read at a glance in Ink: completed steps
    // fade, the in-progress step (▸, shown with its gerund) is ember-bold,
    // pending stay lunar. Verified on the real rendered frame (truecolor).
    const r = await run('todo-render', '', 1200);
    const stripped = r.stdout
      .replace(/\x1b\[\??[0-9;]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b./g, '');
    expect(stripped).toContain('☒ Explore the codebase');
    expect(stripped).toContain('▸ Wiring the controller');  // active, gerund
    expect(stripped).toContain('☐ Run tests');
    expect(r.stdout).toMatch(/38;2;255;159;67/);  // ember on the active line
  });

  test('a tool call renders the NAME bold and the argument PLAIN (§2/§47)', async () => {
    // §47: "The tool name is bold; the argument is plain." The diff-colors
    // scenario emits `⏺ Write(fib.py)`; on the real Ink frame the bold-off
    // (\x1b[22m) must fall right after the name and before the "(" — i.e. the
    // argument is outside the bold run. Before the fix the whole body was bold.
    const r = await run('diff-colors', '', 1400);
    // bold opens (after the lunar colour), wraps exactly "Write", then closes
    // before the "(fib.py)" argument.
    expect(r.stdout).toContain('\x1b[1mWrite\x1b[22m(fib.py)');
    // The old whole-body-bold shape (bold-off only after the ")") must be gone.
    expect(r.stdout).not.toMatch(/\x1b\[1mWrite\(fib\.py\)\x1b\[22m/);
  });

  test('the mode/meta line uses single-space " · " separators (§6)', async () => {
    // §6 mandates a single " · "-separated dim line. The smoke harness renders
    // `anvilwing · auto`; assert no doubled separator survives.
    const r = await run('diff-colors', '', 1400);
    const stripped = r.stdout
      .replace(/\x1b\[\??[0-9;]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b./g, '');
    expect(stripped).toMatch(/anvilwing · /);
    expect(stripped).not.toMatch(/ {2}· {2}/); // no "  ·  " anywhere in the chrome
  });

  test('live follow-up queue renders "Queued (N)" via getRenderer() (the path that crashed)', async () => {
    // Regression guard for the shipped crash: interactiveShell drives the
    // queue through promptController.getRenderer() (the InkRendererShim), but
    // setFollowUpQueueMode/setQueuedPrompts/addUserHistoryItem lived only on
    // the controller — so the call threw "is not a function" → unhandled
    // rejection → process.exit(1) the moment a prompt was submitted while the
    // agent was busy. This drives the SAME shim surface and asserts the
    // transient queue region renders, deterministically, in every environment.
    const r = await run('queue-render', '', 1200);
    expect(r.stderr).toContain('QUEUE-OK: true');
    const stripped = r.stdout
      .replace(/\x1b\[\??[0-9;]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b./g, '');
    expect(stripped).toContain('Queued (2)'); // dim text, no glyph (§9)
    expect(stripped).toContain('follow one while busy');
  });

  test('ChatItem ids carry a monotonic suffix so same-ms appends do not collide', () => {
    // Date.now()-only ids collided in the synchronous /resume replay → duplicate
    // React keys in <Static>. Each history-append site now appends this.idSeq++.
    const controllerSrc = fs.readFileSync(
      path.resolve(REPO_ROOT, 'src/ui/ink/InkPromptController.ts'),
      'utf8',
    );
    expect(controllerSrc).toMatch(/private idSeq = 0/);
    // The previously-collision-prone bare ids are gone.
    expect(controllerSrc).not.toMatch(/id: `u-\$\{Date\.now\(\)\}-q`/);
    expect(controllerSrc).not.toMatch(/id: `r-\$\{Date\.now\(\)\}`/);
    expect(controllerSrc).not.toMatch(/id: `u-\$\{Date\.now\(\)\}`/);
  });

  test('renderer shim exposes the follow-up queue methods interactiveShell calls', async () => {
    // Source-level guard: interactiveShell.ts calls these on getRenderer().
    // If a refactor drops the proxy, the shell crashes at runtime — catch it
    // at build/CI time. (Behavioural coverage above; this pins the surface.)
    const controllerSrc = fs.readFileSync(
      path.resolve(REPO_ROOT, 'src/ui/ink/InkPromptController.ts'),
      'utf8',
    );
    expect(controllerSrc).toMatch(/class InkRendererShim[\s\S]*setFollowUpQueueMode\([^)]*\)\s*:\s*void\s*\{[\s\S]*?this\.owner\.setFollowUpQueueMode/);
    expect(controllerSrc).toMatch(/setQueuedPrompts\([^)]*\)\s*:\s*void\s*\{\s*this\.owner\.setQueuedPrompts/);
    expect(controllerSrc).toMatch(/addUserHistoryItem\([^)]*\)\s*:\s*void\s*\{\s*this\.owner\.addUserHistoryItem/);
  });

  test('consecutive ⏺ blocks get one blank line; a ⎿ result hugs its action (§1)', async () => {
    // CLAUDE_CODE_UX.md §1: distinct ⏺ paragraphs are separated by one blank
    // line, but a tool-result (⎿) sits directly under the ⏺ it belongs to. The
    // bug: ChatStatic rendered every item flush, so an assistant turn, a tool
    // call, and the next assistant turn ran together with no separation. The
    // fix is a marginTop on the Static item box, skipped for toolResults.
    // Verified on the real Ink frame: each commit's leading blank row is the
    // marginTop separator (the live-region size below is constant, so counting
    // blanks immediately above each committed line isolates the margin).
    const r = await run('chat-spacing', '', 1200);
    const lines = r.stdout
      .replace(/\x1b\[\??[0-9;]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b./g, '')
      .split('\n');
    const blanksAbove = (needle: string): number => {
      const i = lines.findIndex((l) => l.includes(needle));
      expect(i).toBeGreaterThanOrEqual(0);
      let n = 0;
      for (let k = i - 1; k >= 0 && lines[k].trim() === ''; k--) n++;
      return n;
    };
    // A ⏺ block that follows another block gets exactly one blank-line separator.
    expect(blanksAbove('Read(foo.ts)')).toBe(1);        // assistant ⏺ → tool ⏺
    expect(blanksAbove('second assistant turn')).toBe(1); // ⎿ result → assistant ⏺
    // The ⎿ tool-result hugs the ⏺ action above it — no separator.
    expect(blanksAbove('Read 10 lines')).toBe(0);
  });

  test('addOutputTap fires for events while attached, stops on dispose', async () => {
    const r = await run('tap');
    // Both pre-detach events must fire.
    expect(r.stderr).toMatch(/TAP:\s*system=one;response=two;/);
    // The third event happens AFTER the tap is detached, so it must
    // NOT appear in the captured tap output.
    expect(r.stderr).not.toContain('three');
  });
});
