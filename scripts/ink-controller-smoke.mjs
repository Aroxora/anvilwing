#!/usr/bin/env node
// Phase-6 smoke harness for InkPromptController. Exercises the methods
// interactiveShell.ts actually calls, through the same factory so the
// ANVILWING_INK gating is real. Outcome markers on stderr.

import process from 'node:process';
import { Readable } from 'node:stream';

// Force truecolor so color-dependent scenarios (diff-colors) render
// deterministically — a piped (non-TTY) stdout would otherwise downgrade to
// no color. Set before the controller (and thus chalk/ink) loads.
// FORCE_COLOR=3 alone is insufficient when TERM=linux: chalk's supports-color
// hits the `/linux/i.test(TERM)` branch and returns level 1 before reaching
// the `return min` fallback. COLORTERM=truecolor is checked earlier and wins.
process.env.FORCE_COLOR = process.env.FORCE_COLOR ?? '3';
process.env.COLORTERM = process.env.COLORTERM ?? 'truecolor';

class FakeStdin extends Readable {
  constructor() { super({ read() {} }); this.isTTY = true; this.setRawMode = () => this; this.ref = () => this; this.unref = () => this; }
}
const fakeStdin = new FakeStdin();
process.stdin.on('data', (chunk) => fakeStdin.push(chunk));

// Override BOTH process.stdin and process.stdout to look TTY-shaped so
// Ink's raw-mode requirement is satisfied; the controller refuses to
// start on a non-TTY.
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
Object.defineProperty(process.stdout, 'getColorDepth', { value: () => 24, configurable: true });
Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });

const { createPromptController } = await import('../dist/ui/ink/InkPromptController.js');

const events = [];
const ctrl = await createPromptController(fakeStdin, process.stdout, {
  onSubmit: (text) => {
    events.push({ type: 'submit', text });
    process.stderr.write(`SUBMIT: ${text}\n`);
    // Diagnostic: prompt buffer state at the moment the host's
    // onSubmit fires. The InkPromptController wrapper resets the
    // buffer + drives a rerender BEFORE calling this callback, so
    // the buffer must read as '' here. If a stale value leaks
    // through, the post-submit prompt box still shows the typed
    // text (the 1.1.7 bug).
    process.stderr.write(`BUFFER-AFTER-SUBMIT: ${JSON.stringify(ctrl.getBuffer())}\n`);
    // The double-submit scenario drives a SECOND keystroke sequence after the
    // first submit (to prove the box doesn't accumulate), so it must keep
    // running — it calls finish() itself once done.
    if (process.argv[2] !== 'double-submit') finish();
  },
  onQueue: (text) => { events.push({ type: 'queue', text }); },
  onInterrupt: () => { events.push({ type: 'interrupt' }); process.stderr.write('INTERRUPT\n'); finish(); },
  onCtrlC: (info) => { events.push({ type: 'ctrlc', info }); process.stderr.write(`CTRLC: hadBuffer=${info.hadBuffer}\n`); },
  onToggleAutoContinue: () => { events.push({ type: 'toggle-auto' }); },
  onToggleHITL: () => { events.push({ type: 'toggle-hitl' }); },
  onExit: () => { events.push({ type: 'exit' }); process.exit(0); },
});

ctrl.start();
// Ink mounts asynchronously (dynamic ink/react/App imports + first render).
// Wait for it before driving any event, or a fast finish()/process.exit can
// pre-empt the mount and the first frame never reaches stdout — the
// empty-output flake seen on CPU-contended CI runners.
await ctrl.whenReady();

const scenario = process.argv[2];

if (scenario === 'addEvent-flow') {
  // Drive several addEvent calls through the renderer shim. Wait a tick
  // between each so Ink's reconciler commits one frame per addition —
  // without this Ink may coalesce all four into a single first-mount
  // render of <Static>, which it logs differently than incremental
  // appends. The production CLI never adds events at once anyway.
  await new Promise(r => setImmediate(r));
  ctrl.getRenderer().addEvent('banner', 'WELCOME-LINE');
  await new Promise(r => setTimeout(r, 50));
  ctrl.getRenderer().addEvent('system', 'system-line');
  await new Promise(r => setTimeout(r, 50));
  ctrl.getRenderer().addEvent('response', 'assistant-line');
  await new Promise(r => setTimeout(r, 50));
  ctrl.getRenderer().addEvent('tool', 'tool-line');
  await new Promise(r => setTimeout(r, 100));
}

if (scenario === 'mode-toggle') {
  ctrl.setStatusMessage('Working');
  ctrl.toggleAutoContinue();
  ctrl.toggleHITL();
  process.stderr.write(`AUTO: ${ctrl.getAutoMode()}\n`);
  process.stderr.write(`HITL: ${ctrl.getHITLMode()}\n`);
}

if (scenario === 'capture-input') {
  // Set secret mode, capture next submission, verify it resolves with
  // the typed text.
  ctrl.getRenderer().setSecretMode(true);
  const captured = await ctrl.getRenderer().captureInput({ trim: false });
  process.stderr.write(`CAPTURED: ${captured}\n`);
  finish();
}

if (scenario === 'submit-to-history') {
  // The bug: user types "hi", presses Enter, but "hi" never appears in
  // the chat history. The legacy renderer auto-emitted a 'prompt'
  // event from its submit path; the Ink path didn't, so submitted
  // user input was lost from the visible transcript.
  await new Promise(r => setImmediate(r));
  // Drive an Enter through the bridged stdin AFTER seeding the buffer
  // (we set initial via setBuffer) so the onSubmit handler fires.
  ctrl.setBuffer('hello world');
  await new Promise(r => setTimeout(r, 80));
  fakeStdin.push('\r');
  await new Promise(r => setTimeout(r, 250));
}

if (scenario === 'stream-coalesce') {
  // Simulate the agent's message.delta → message.complete sequence.
  // 'thought' events should be filtered from history; 'stream' events
  // should accumulate into a single in-progress message; 'response'
  // commits the final canonical text. The committed history must
  // contain ONE assistant entry with the final text — not one entry
  // per delta.
  await new Promise(r => setImmediate(r));
  ctrl.getRenderer().addEvent('thought', 'this is reasoning the user should NOT see');
  // Fire the deltas synchronously so Ink coalesces them into one frame.
  // The live region grows in place at runtime; here we assert the
  // committed result, not transient frames. The terminal event is the
  // real delta-path shape — response('\n') with the body in the stream
  // buffer — which exercises the streamingText fallback in _commitStreaming.
  ctrl.getRenderer().addEvent('stream', 'Hi');
  ctrl.getRenderer().addEvent('stream', ' there');
  ctrl.getRenderer().addEvent('stream', '!');
  ctrl.getRenderer().addEvent('response', '\n');
  await new Promise(r => setTimeout(r, 100));
}

if (scenario === 'done-sentinel') {
  // An assistant reply ending in the DONE: completion sentinel must render the
  // sentinel as a clean `✓ <summary>` line — never the raw "DONE:" marker.
  await new Promise(r => setImmediate(r));
  ctrl.getRenderer().addEvent('response', 'Fixed the off-by-one in the loop bound.\nDONE: edited src/loop.ts; npm test exited 0');
  await new Promise(r => setTimeout(r, 200));
  finish();
}

if (scenario === 'markdown-render') {
  // Commit an assistant response containing Markdown. ChatStatic must render it
  // to themed ANSI (headings without `##`, bold, a box-drawing table) — never
  // raw `##` / `**` / `|---|`.
  await new Promise(r => setImmediate(r));
  const md = '## Phase One\n\nUse `make data` and **rebuild** it.\n\n| Step | File |\n|------|------|\n| 1 | index.html |\n';
  ctrl.getRenderer().addEvent('response', md);
  await new Promise(r => setTimeout(r, 200));
  finish();
}

if (scenario === 'stream-dup-interleaved') {
  // BUG A repro: on a long turn the model re-streams the SAME body before each
  // of many tool calls. Each tool event flushes the partial via
  // _finalizeStreamingIfAny → _pushAssistant; the interleaved tool entry used
  // to break the last-entry-only dedup so the body stacked once per tool call.
  // After the scan-back + dense-key dedup, the body must render EXACTLY ONCE.
  // Spacing varies per round (the streamed copy drops spaces) to exercise the
  // dense-key comparator too.
  await new Promise(r => setImmediate(r));
  const R = ctrl.getRenderer();
  const spaced = 'Here is what was upgraded across 3 files and 11 vectors';
  const despaced = 'Here is what was upgraded across3 files and11 vectors';
  for (let i = 0; i < 8; i++) {
    R.addEvent('stream', i % 2 === 0 ? despaced : spaced);
    R.addEvent('tool', `⏺ Bash(grep round ${i})`);
    R.addEvent('tool-result', `  ⎿  match ${i}`);
  }
  R.addEvent('response', '\n');
  await new Promise(r => setTimeout(r, 200));
  finish();
}

if (scenario === 'multi-tool') {
  // Three tool calls, each its own action line + result. The transcript must
  // show THREE `⏺` lines, not one `⏺` with three stacked `⎿` results.
  await new Promise(r => setImmediate(r));
  const R = ctrl.getRenderer();
  R.addEvent('tool', '⏺ Read(file1.ts)');
  R.addEvent('tool-result', '  ⎿  Read 200 lines');
  R.addEvent('tool', '⏺ Read(file2.ts)');
  R.addEvent('tool-result', '  ⎿  Read 350 lines');
  R.addEvent('tool', '⏺ Read(file3.ts)');
  R.addEvent('tool-result', '  ⎿  Read 316 lines');
  await new Promise(r => setTimeout(r, 200));
  finish();
}

if (scenario === 'tap') {
  let tapped = '';
  const off = ctrl.getRenderer().addOutputTap((kind, content) => {
    tapped += `${kind}=${content};`;
  });
  ctrl.getRenderer().addEvent('system', 'one');
  ctrl.getRenderer().addEvent('response', 'two');
  off();
  ctrl.getRenderer().addEvent('system', 'three');
  process.stderr.write(`TAP: ${tapped}\n`);
}

if (scenario === 'menu-select') {
  // Open an interactive menu, move down one with the arrow key, select
  // with Enter. The callback must fire with the highlighted item — the
  // whole flow that was unreachable before the Ink Menu existed.
  await new Promise(r => setImmediate(r));
  ctrl.setMenu(
    [
      { id: 'one', label: 'Option One' },
      { id: 'two', label: 'Option Two' },
      { id: 'three', label: 'Option Three' },
    ],
    { title: 'Pick one' },
    (item) => {
      process.stderr.write(`MENU-SELECTED: ${item ? item.id : 'null'}\n`);
      finish();
    },
  );
  await new Promise(r => setTimeout(r, 200));
  fakeStdin.push('\x1b[B'); // arrow down → Option Two
  await new Promise(r => setTimeout(r, 350));
  fakeStdin.push('\r');     // Enter → select
  await new Promise(r => setTimeout(r, 250));
}

if (scenario === 'todo-render') {
  // A plan (TodoWrite) renders as a colored checklist below the action: done
  // steps faded, the active step (▸) ember-bold, pending lunar.
  await new Promise(r => setImmediate(r));
  const R = ctrl.getRenderer();
  R.addEvent('tool', '⏺ Update Todos');
  R.addEvent('tool-result', '  ⎿  ☒ Explore the codebase\n     ▸ Wiring the controller\n     ☐ Run tests');
  await new Promise(r => setTimeout(r, 250));
  finish();
}

if (scenario === 'user-marker') {
  // Commit a user turn directly (no input buffer) and let it render. The only
  // place a `> ` can come from on this line is the committed user-line styling.
  await new Promise(r => setImmediate(r));
  ctrl.getRenderer().addUserHistoryItem('COMMITTED_USER_LINE');
  await new Promise(r => setTimeout(r, 200));
  finish();
}

if (scenario === 'hitl-decision') {
  // The REAL HITL flow: register the decision presenter (as the shell does),
  // fire a decision through the HITL system, and prove the 4 options + the
  // "Enter your own" write-in render as a menu BELOW the prompt, navigable
  // with ↑↓ + Enter — and that the pick flows back to requestDecision().
  await new Promise(r => setImmediate(r));
  const { setDecisionPresenter, getHITL } = await import('../dist/core/hitl.js');
  // Mirror the shell's presentHitlDecision: question + context live INSIDE a
  // bottom-anchored bordered popup (boxed), not scrolled into history.
  setDecisionPresenter((request) => new Promise((resolveChoice) => {
    const items = [
      ...request.options.map((o) => ({ id: o.id, label: o.label, description: o.description })),
      { id: '__custom__', label: 'Enter your own', description: 'Type a custom plan' },
    ];
    const body = [];
    if (request.description) body.push(request.description);
    if (request.context) body.push(request.context);
    ctrl.setMenu(items, {
      question: request.title,
      body: body.length ? body : undefined,
      footer: '↑↓ choose · enter select · esc cancel',
      boxed: true,
      initialIndex: 0,
    }, (sel) => {
      resolveChoice({ optionId: sel ? sel.id : request.options[0].id });
    });
  }));
  const decisionP = getHITL({ autoPause: true, logLevel: 'none' }).requestDecision({
    id: 'smoke-hitl', title: 'Pick a scope', description: 'how broad', context: '',
    options: [
      { id: 'a', label: 'Narrow scope', description: 'one function' },
      { id: 'b', label: 'Medium scope', description: 'the module' },
      { id: 'c', label: 'Broad scope', description: 'all callers' },
      { id: 'd', label: 'Full scope', description: 'the subsystem' },
    ],
    requiresExplicitChoice: true,
  });
  await new Promise(r => setTimeout(r, 200));
  fakeStdin.push('\x1b[B'); // arrow down → Medium scope (b)
  await new Promise(r => setTimeout(r, 350));
  fakeStdin.push('\r');     // Enter → select
  const chosen = await decisionP;
  process.stderr.write(`HITL-CHOSEN: ${chosen}\n`);
  await new Promise(r => setTimeout(r, 120));
  setDecisionPresenter(null);
  finish();
}

if (scenario === 'menu-cancel') {
  await new Promise(r => setImmediate(r));
  ctrl.setMenu(
    [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    { title: 'Pick' },
    (item) => {
      process.stderr.write(`MENU-SELECTED: ${item ? item.id : 'null'}\n`);
      finish();
    },
  );
  await new Promise(r => setTimeout(r, 150));
  fakeStdin.push('\x03'); // Ctrl+C → cancel (null)
  await new Promise(r => setTimeout(r, 200));
}

if (scenario === 'permission-cycle') {
  // Drive Shift+Tab (CSI \x1b[Z) through the REAL controller + Prompt and
  // assert the permission mode cycles AND the App renders the matching hint
  // line. Same module the runtime reads, so MODE markers are the source of
  // truth; the rendered stdout proves the hint reached the screen.
  const { getPermissionMode } = await import('../dist/core/permissionMode.js');
  // Generous settle + dwells: under heavy parallel test load Ink's async
  // mount + render throttle can lag, so give each keypress room to be
  // processed and rendered before sampling the mode / capturing the frame.
  await new Promise(r => setTimeout(r, 600));
  process.stderr.write(`MODE: ${getPermissionMode()}\n`); // default
  fakeStdin.push('\x1b[Z');
  await new Promise(r => setTimeout(r, 500));
  process.stderr.write(`MODE: ${getPermissionMode()}\n`); // acceptEdits
  fakeStdin.push('\x1b[Z');
  await new Promise(r => setTimeout(r, 500));
  process.stderr.write(`MODE: ${getPermissionMode()}\n`); // plan
  fakeStdin.push('\x1b[Z');
  await new Promise(r => setTimeout(r, 500));
  process.stderr.write(`MODE: ${getPermissionMode()}\n`); // default
  await new Promise(r => setTimeout(r, 150));
  finish();
}

if (scenario === 'spinner-meta') {
  // Drive setMetaStatus through the REAL controller while spinning and let
  // the real App/StatusLine render: ↑ tokens on the spinner row, context %
  // on the below-box meta line. Then inject malformed usage payloads
  // (NaN/zero-limit — what a lax OpenAI-compatible proxy produces); the
  // chips must hold their last good values, never render 'NaN'.
  await new Promise(r => setImmediate(r));
  ctrl.setStreaming(true);
  ctrl.setStatusMessage('Working');
  ctrl.setMetaStatus({ outputTokens: 1234, contextTokens: 50000, tokenLimit: 100000 });
  await new Promise(r => setTimeout(r, 400));
  // The exact failure shape: a proxy omits/garbles prompt_tokens, so the
  // shell forwards NaN contextTokens against the model's REAL window. Each
  // malformed payload gets its own render window so a corrupted chip would
  // actually reach a captured frame.
  ctrl.setMetaStatus({ outputTokens: NaN, contextTokens: NaN, tokenLimit: 100000 });
  await new Promise(r => setTimeout(r, 400));
  ctrl.setMetaStatus({ contextTokens: 5000, tokenLimit: 0 });
  await new Promise(r => setTimeout(r, 400));
  finish();
}

if (scenario === 'diff-colors') {
  // A write/edit tool-result carries a line-numbered diff; ChatStatic should
  // color additions green and removals red. Truecolor is forced above so the
  // RGB escapes appear deterministically in captured stdout.
  await new Promise(r => setImmediate(r));
  const r = ctrl.getRenderer();
  r.addEvent('tool', '⏺ Write(fib.py)');
  r.addEvent('tool-result', '  ⎿  Created fib.py with 2 additions\n       1 +   import sys\n       2    def main():\n       3 -   removed_old_line');
  await new Promise(r => setTimeout(r, 400));
  finish();
}

if (scenario === 'chat-spacing') {
  // §1: one blank line separates consecutive ⏺ blocks; a tool-result (⎿) hugs
  // the ⏺ action above it. Each addEvent commits as its own <Static> write, so
  // the marginTop=1 separator shows up as one extra blank row in the bytes
  // emitted just before a ⏺ item, vs none before the ⎿ result. The test
  // measures that gap difference (robust to the live-region's absolute size).
  await new Promise(r => setImmediate(r));
  const r = ctrl.getRenderer();
  r.addEvent('response', 'first assistant turn');
  r.addEvent('tool', '⏺ Read(foo.ts)');
  r.addEvent('tool-result', '  ⎿  Read 10 lines');
  r.addEvent('response', 'second assistant turn');
  await new Promise(r2 => setTimeout(r2, 400));
  finish();
}

if (scenario === 'queue-render') {
  // Live follow-up queue, driven through getRenderer() — the EXACT surface
  // interactiveShell.ts uses. These methods live on the controller; if the
  // shim stops proxying them the call throws "is not a function" and the
  // shell crashes (the real bug this guards). Asserts the transient
  // "⏳ Queued (N)" region renders on the real Ink output.
  await new Promise(r => setImmediate(r));
  const r = ctrl.getRenderer();
  r.setFollowUpQueueMode(true);
  r.setQueuedPrompts(['follow one while busy', 'follow two while busy']);
  await new Promise(r2 => setTimeout(r2, 200));
  process.stderr.write(`QUEUE-OK: ${typeof r.setQueuedPrompts === 'function'}\n`);
  finish();
}

if (scenario === 'double-submit') {
  // Type a message, submit, type a second message — via REAL keystrokes
  // (fakeStdin), not setBuffer. The Prompt owns its buffer in a ref that the
  // host's `initial` prop can't reset for typed input (initial stays '' the
  // whole time), so the only thing that clears it is the Prompt self-clearing
  // on submit. Without that, the box accumulates ("alphabravo") and every
  // subsequent line piles on. Asserts on the rendered frame.
  await new Promise(r => setImmediate(r));
  fakeStdin.push('alpha');
  await new Promise(r => setTimeout(r, 120));
  fakeStdin.push('\r');
  await new Promise(r => setTimeout(r, 150));
  fakeStdin.push('bravo');
  await new Promise(r => setTimeout(r, 200));
  // At this instant the box must read "bravo", never "alphabravo".
  process.stderr.write(`SUBMIT-DOUBLE: done\n`);
  await new Promise(r => setTimeout(r, 80));
  finish();
}

function finish() {
  ctrl.stop();
  // Give Ink's final unmount render a tick to flush to the piped stdout
  // before exit — process.exit can otherwise pre-empt the throttled write.
  setTimeout(() => process.exit(0), 30);
}

// Drive submit when stdin closes for the addEvent / mode-toggle / tap
// scenarios that don't need user input.
if (!['capture-input', 'permission-cycle', 'spinner-meta', 'diff-colors', 'queue-render', 'double-submit', 'chat-spacing'].includes(scenario)) {
  setTimeout(() => {
    fakeStdin.push('\r');
  }, 300);
}
