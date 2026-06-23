#!/usr/bin/env node
// Drives the REAL built anvilwing binary through a PTY (via the ui-pty
// harness) and prints a JSON digest the jest e2e test asserts on. Kept as
// a subprocess runner so the test doesn't have to import the ESM/native
// pty harness directly. Auth is bypassed with ANVILWING_SKIP_AUTH=1 (a real
// product flag) so the interactive shell renders without credentials; the
// live model round-trip is a separate, key-gated concern.

import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../test/ui-pty/harness.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.resolve(REPO_ROOT, 'dist', 'bin', 'anvilwing.js');

// Seed one saved session on disk (in an isolated ANVILWING_DATA_DIR) so the
// `resume` scenario can drive /resume → menu → select against the REAL binary
// and prove the prior thread is restored + reprinted. Writes the exact
// StoredSession + index.json shapes sessionStore reads.
function seedSessionDir() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ero-e2e-resume-'));
  const sessionsDir = path.join(dataDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const id = 'e2e-resume-session';
  const now = new Date().toISOString();
  const messages = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'remember the secret code BANANA42' },
    { role: 'assistant', content: 'Understood. ACK-RESTORE-7 — the code is stored.' },
  ];
  const summary = {
    id,
    title: 'remember the secret code BANANA42',
    profile: 'anvilwing-code',
    provider: 'anvilwing',
    model: 'anvilwing',
    createdAt: now,
    updatedAt: now,
    messageCount: messages.length,
    workspaceRoot: REPO_ROOT,
  };
  writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify({ ...summary, messages }, null, 2));
  writeFileSync(path.join(sessionsDir, 'index.json'), JSON.stringify({ entries: { [id]: summary } }, null, 2));
  return dataDir;
}

const SCENARIOS = {
  hi: {
    durationMs: 9000,
    inputs: [
      { delayMs: 3200, data: 'hi' },
      { delayMs: 3800, data: '\r' },
      { delayMs: 8300, data: '\x04' },
    ],
  },
  clear: {
    durationMs: 11000,
    inputs: [
      { delayMs: 3200, data: 'hi' },
      { delayMs: 3800, data: '\r' },
      { delayMs: 6200, data: '/clear' },
      { delayMs: 6800, data: '\r' },
      { delayMs: 10300, data: '\x04' },
    ],
  },
  // Shift+Tab (CSI \x1b[Z) cycles the permission mode. The strip below the
  // input box always shows all three modes; the active one is highlighted
  // (color-only), so the plain-text active-mode proof is the meta row's
  // permission chip: default (no chip) → accept-edits → plan → default.
  'permission-cycle': {
    durationMs: 13000,
    inputs: [
      { delayMs: 3500, data: '\x1b[Z' }, // → acceptEdits
      { delayMs: 6000, data: '\x1b[Z' }, // → plan
      { delayMs: 9000, data: '\x1b[Z' }, // → back to default
      { delayMs: 12500, data: '\x04' },
    ],
  },
  // Ctrl+T (\x14) opens the toggles menu — keyboard access to the below-box
  // settings (auto-continue · confirm actions · debug). Proves the menu
  // renders all three rows with live on/off state.
  toggles: {
    durationMs: 9000,
    inputs: [
      { delayMs: 3500, data: '\x14' }, // Ctrl+T → toggles menu
      { delayMs: 8300, data: '\x04' },
    ],
  },
  // /context: open the usage panel. Proves the inline-panel BLOCK renders
  // (the body was previously invisible — only the header leaked into the
  // chips line) and shows the real 1M window + "% context left".
  context: {
    durationMs: 9000,
    inputs: [
      { delayMs: 3500, data: '/context' },
      { delayMs: 4200, data: '\r' },
      { delayMs: 8300, data: '\x04' },
    ],
  },
  // /diff with no edits yet: proves the command is wired in the real binary
  // and the empty-state message renders (the populated panel reuses the same
  // inline-panel block /context already proves).
  diff: {
    durationMs: 9000,
    inputs: [
      { delayMs: 3500, data: '/diff' },
      { delayMs: 4200, data: '\r' },
      { delayMs: 8300, data: '\x04' },
    ],
  },
  // /rewind with no edits yet: proves the command is wired in the real binary
  // and the empty-state message renders (the actual file revert is covered
  // in-process against the real tracker in test/rewind.test.ts).
  rewind: {
    durationMs: 9000,
    inputs: [
      { delayMs: 3500, data: '/rewind' },
      { delayMs: 4200, data: '\r' },
      { delayMs: 8300, data: '\x04' },
    ],
  },
  // /resume: open the saved-session picker, select the seeded session, and
  // confirm its prior exchange is restored + reprinted on the real screen.
  resume: {
    durationMs: 13000,
    inputs: [
      { delayMs: 3500, data: '/resume' },
      { delayMs: 4200, data: '\r' }, // submit command → menu opens
      { delayMs: 6500, data: '\r' }, // select the (only/top) session
      { delayMs: 12500, data: '\x04' },
    ],
  },
  // /-command palette: type '/' (all commands), refine to '/di' (filters to
  // /diff), Tab to complete to '/diff '. Proves the palette renders with
  // command BODIES (descriptions), filters live, and Tab-completes — the real
  // binary, not just that '/' was typed.
  'slash-palette': {
    durationMs: 9000,
    inputs: [
      { delayMs: 3300, data: '/' },   // palette opens with all commands
      { delayMs: 4300, data: 'di' },  // → '/di' filters to /diff
      { delayMs: 5300, data: '\t' },  // Tab → completes to '/diff '
      { delayMs: 8300, data: '\x04' },
    ],
  },
  // `!cmd` bash mode: `!echo <marker>` + Enter runs the shell command directly
  // (no model round-trip) and renders its output. Proves the leading-bang route.
  'bash-bang': {
    durationMs: 9000,
    inputs: [
      { delayMs: 3300, data: '!echo anvilwing-bash-ok' },
      { delayMs: 4100, data: '\r' },
      { delayMs: 8300, data: '\x04' },
    ],
  },
  // Multi-line input: a line ending in '\' continues onto the next line. Type
  // 'aaa\' + Enter (→ newline, keep editing) + 'bbb'; the box shows two lines
  // ('> aaa' then a continuation 'bbb' with no '>' mark). No submit.
  'multiline-input': {
    durationMs: 9000,
    inputs: [
      { delayMs: 3300, data: 'aaa\\' },
      { delayMs: 4000, data: '\r' },
      { delayMs: 4700, data: 'bbb' },
      { delayMs: 8300, data: '\x04' },
    ],
  },
  // `/` palette Enter runs the HIGHLIGHTED command: '/cont' (palette highlights
  // /context) + Enter → /context runs, proving Enter completes-then-runs the
  // highlight rather than submitting the raw partial.
  'slash-enter-run': {
    durationMs: 9000,
    inputs: [
      { delayMs: 3300, data: '/cont' },
      { delayMs: 4200, data: '\r' },
      { delayMs: 8300, data: '\x04' },
    ],
  },
  // `?` on an empty buffer shows the shortcuts panel (the dim "? for shortcuts"
  // hint must be real). Proves the panel body renders, not that `?` was typed.
  'question-shortcuts': {
    durationMs: 8000,
    inputs: [
      { delayMs: 3300, data: '?' },
      { delayMs: 7300, data: '\x04' },
    ],
  },
  // Multi-line paste: a single chunk with embedded newlines must land WHOLE in
  // the buffer (not submit line 1 and drop the rest).
  'multiline-paste': {
    durationMs: 7000,
    inputs: [
      { delayMs: 3300, data: 'alpha\nbeta\ngamma' },
      { delayMs: 6300, data: '\x04' },
    ],
  },
  // Large paste: a single chunk of >= 6 lines collapses to a compact
  // `[Pasted text #1 +6 lines]` placeholder in the box (Claude Code parity)
  // instead of flooding it with every line.
  'large-paste': {
    durationMs: 7000,
    inputs: [
      { delayMs: 3300, data: 'L0\nL1\nL2\nL3\nL4\nL5' },
      { delayMs: 6300, data: '\x04' },
    ],
  },
  // Forward-delete (Del) removes the char AT the cursor, not to its left.
  'forward-delete': {
    durationMs: 7000,
    inputs: [
      { delayMs: 3300, data: 'abc' },
      { delayMs: 3700, data: '\x1b[D' },
      { delayMs: 3900, data: '\x1b[D' },
      { delayMs: 4200, data: '\x1b[3~' },
      { delayMs: 6300, data: '\x04' },
    ],
  },
  // An inline panel (/help) must dismiss on ANY keypress (the panels say
  // "press any key to dismiss"), and that key is consumed (not typed).
  'panel-dismiss': {
    durationMs: 8000,
    inputs: [
      { delayMs: 3300, data: '/help' },
      { delayMs: 3900, data: '\r' },
      { delayMs: 5200, data: 'z' },
      { delayMs: 7300, data: '\x04' },
    ],
  },
  // Esc interrupts a running turn (the spinner's "esc to interrupt" promise).
  // Forces a busy window via the seam, sends Esc mid-run, expects "Interrupted".
  'esc-interrupt': {
    durationMs: 8000,
    env: { ANVILWING_TEST_FORCE_BUSY_MS: '6000' },
    inputs: [
      { delayMs: 3000, data: '\x1b' }, // Esc during the forced-busy window
      { delayMs: 7300, data: '\x04' },
    ],
  },
  // Esc while a dismissable panel is open DURING a running turn must dismiss the
  // panel AND interrupt — the panel must not swallow the "esc to interrupt"
  // promise. Forces busy from boot, opens /help, then Esc → expects both the
  // panel gone AND "Interrupted".
  'panel-esc-interrupt': {
    durationMs: 12000,
    // Long busy window so the seam still has isProcessing=true when Esc fires,
    // even on a heavily contended host where boot lags several seconds.
    env: { ANVILWING_TEST_FORCE_BUSY_MS: '11000' },
    inputs: [
      { delayMs: 5000, data: '/help' }, // generous boot dwell so the keystrokes land
      { delayMs: 5800, data: '\r' },    // open the panel during the busy window
      { delayMs: 7600, data: '\x1b' },  // Esc: dismiss panel AND fire interrupt
      { delayMs: 11300, data: '\x04' },
    ],
  },
  // LIVE model round-trip (key-gated; the jest test skips without a real
  // ANVILWING_API_KEY): send a prompt and watch the spinner meta's `↑ N tokens`
  // climb while the response streams — the integrated AgentController-event →
  // TurnTokenMeter → StatusLine flow on the real shipped binary.
  'live-tokens': {
    durationMs: 60000,
    inputs: [
      // Neutral topic on purpose: the escape-leak check scans the visible screen
      // for raw control sequences, so the PROMPT must not ask the model to write
      // about ANSI escapes — its prose would then contain "[2J" etc. and
      // false-trip the renderer-leak guard. The streamed token meter is what's
      // under test, not the content.
      { delayMs: 3500, data: 'write one paragraph of about 150 words describing how a river forms, from rainfall in the mountains down to the sea' },
      { delayMs: 4500, data: '\r' },
      { delayMs: 58000, data: '\x04' },
    ],
  },
  // Live follow-up queue under forced busy seam (ANVILWING_TEST_FORCE_BUSY_MS).
  // Types a task, then two follow-ups while the seam keeps isProcessing true.
  // Asserts: input accepted live, no crash, transient queued UI appears (once
  // implemented), old polluting banners absent, clean exit after drain.
  'followup-queue': {
    durationMs: 12000,
    env: { ANVILWING_TEST_FORCE_BUSY_MS: '4500' }, // busy window long enough for 2 follow-ups
    inputs: [
      { delayMs: 2800, data: 'initial task' },
      { delayMs: 3200, data: '\r' },
      { delayMs: 3600, data: 'follow one while busy' },
      { delayMs: 4000, data: '\r' },
      { delayMs: 4400, data: 'follow two while busy' },
      { delayMs: 4800, data: '\r' },
      { delayMs: 11000, data: '\x04' },
    ],
  },
};

const name = process.argv[2] || 'hi';
const cfg = SCENARIOS[name];
if (!cfg) { process.stderr.write(`unknown scenario: ${name}\n`); process.exit(2); }

const baseEnv = { ANVILWING_SKIP_AUTH: '1' };
const scenarioEnv = cfg.env || {};
// The resume scenario needs a pre-seeded, isolated session store.
if (name === 'resume') {
  scenarioEnv.ANVILWING_DATA_DIR = seedSessionDir();
}
// live-tokens makes a REAL model call: pull the key from the gitignored .env
// when the environment doesn't already carry one, and isolate the cumulative
// usage store so the run doesn't pollute the user's /usage numbers.
if (name === 'live-tokens') {
  if (!process.env.ANVILWING_API_KEY) {
    try {
      const m = readFileSync(path.join(REPO_ROOT, '.env'), 'utf8').match(/^ANVILWING_API_KEY=(.+)$/m);
      if (m) scenarioEnv.ANVILWING_API_KEY = m[1].trim();
    } catch { /* key-gated: the jest test skips when absent */ }
  }
  scenarioEnv.ANVILWING_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'ero-e2e-live-tokens-'));
}
const r = await runScenario({
  name: `e2e-${name}`,
  cliBin: BIN,
  env: { ...baseEnv, ...scenarioEnv },
  ...cfg,
});

const screen = r.snapshots.flatMap((s) => s.lines).join('\n');
const uniqLines = [...new Set(r.snapshots.flatMap((s) => s.lines).map((l) => l.trim()).filter(Boolean))];
const postClear = r.snapshots.slice(-10).flatMap((s) => s.lines).join('\n');

// max times any single line repeats inside ONE snapshot frame — >1 for a
// streamed/committed line would mean the live-region duplication bug.
let maxDupInFrame = 0;
for (const s of r.snapshots) {
  const counts = new Map();
  for (const l of s.lines.map((x) => x.trim()).filter((x) => x.length > 2)) {
    counts.set(l, (counts.get(l) || 0) + 1);
  }
  for (const c of counts.values()) if (c > maxDupInFrame) maxDupInFrame = c;
}

// The meta row is the only plain-text witness of the ACTIVE permission mode
// (the strip highlight is color-only): permissionStatusChip adds
// `accept-edits` / `plan` to the `anvilwing · …` line outside default.
const metaRows = r.snapshots.flatMap((s) => s.lines).filter((l) => /anvilwing ·/.test(l));
const postClearMetaRows = r.snapshots.slice(-10).flatMap((s) => s.lines).filter((l) => /anvilwing ·/.test(l));
const planChipRe = /· plan(?: ·|\s*$)/;

const base = {
  scenario: name,
  // Committed user turns carry the `> ` marker (Claude Code parity); the input
  // box also prefixes `> `. Either form proves the input echoed.
  sawHi: r.snapshots.some((s) => s.lines.some((l) => l.trim() === 'hi' || l.trim() === '> hi')),
  escapeLeakOnScreen: /\[2J|\[1J|\[200~|\[201~|\[\?25[lh]/.test(screen),
  postClearHasBanner: /anvilwing/i.test(postClear),
  sawAcceptEdits: metaRows.some((l) => /\baccept-edits\b/.test(l)),
  sawPlanMode: metaRows.some((l) => planChipRe.test(l)),
  endsAtDefault: /\? for shortcuts/.test(postClear)
    && !postClearMetaRows.some((l) => /\baccept-edits\b/.test(l) || planChipRe.test(l)),
  maxDupInFrame,
  findingKinds: (r.findings || []).map((f) => f.kind),
  uniqLineCount: uniqLines.length,
  sampleLines: uniqLines.slice(0, 40),
};

if (name === 'permission-cycle') {
  // The persistent strip: one row with all three mode labels.
  base.stripShowsAllModes = r.snapshots.some((s) => s.lines.some((l) =>
    l.includes('⏵ default') && l.includes('⏵⏵ accept edits') && l.includes('⏸ plan')));
  // Non-default modes swap the trailing hint to "shift+tab to cycle".
  base.sawCycleHint = /shift\+tab to cycle/.test(screen);
  // Positional: BOTH below-box rows sit under the input box's bottom border ╰
  // (the bottom-most ╰ on screen), strip first, meta line under it.
  base.rowsBelowBox = r.snapshots.some((s) => {
    let bottom = -1;
    s.lines.forEach((l, i) => { if (l.includes('╰')) bottom = i; });
    if (bottom < 0) return false;
    const stripIdx = s.lines.findIndex((l, i) => i > bottom && l.includes('⏵ default'));
    const metaIdx = s.lines.findIndex((l, i) =>
      i > bottom && /anvilwing ·/.test(l) && /context left|auto/.test(l));
    return stripIdx > bottom && metaIdx > stripIdx;
  });
}

if (name === 'diff') {
  base.sawNoChanges = /No file changes in the last run/.test(screen);
}

if (name === 'rewind') {
  base.sawNothingToRewind = /Nothing to rewind/.test(screen);
}

if (name === 'toggles') {
  base.sawTogglesTitle = /Toggles —/.test(screen);
  base.sawAutoToggle = /Auto-continue/.test(screen);
  base.sawConfirmToggle = /Confirm actions/.test(screen);
  base.sawDebugToggle = /Debug output/.test(screen);
  // The on/off state must render (the menu is useless without it).
  base.sawToggleState = /Auto-continue\s+(on|off)/.test(screen);
}

if (name === 'context') {
  base.sawContextHeader = /Context/.test(screen);
  base.sawWindowTokens = /1,048,576/.test(screen); // anvilwing real 1M (2^20) window
  base.sawContextLeft = /% context left/.test(screen);
  // Body lines (Window/Free) only appear if the inline-panel block renders —
  // this is the assertion that would have caught the invisible-body bug.
  base.sawContextBody = /Window/.test(screen) && /Free/.test(screen);
}

if (name === 'resume') {
  base.sawResumeMenu = /Resume a conversation/i.test(screen);
  base.sawResumedNote = /Resumed "/.test(screen);
  // ACK-RESTORE-7 lives ONLY in the saved assistant message, so seeing it
  // proves the restored history was reprinted — not just the menu title.
  base.sawRestoredAssistant = /ACK-RESTORE-7/.test(screen);
}

if (name === 'slash-palette') {
  // A command name in the palette (header-ish) …
  base.sawSlashCmd = /\/diff\b/.test(screen);
  // … AND a description BODY line — proves the menu block rendered, not just a
  // header (the invisible-body failure mode the panel memory warns about).
  base.sawSlashDesc = /Clear the screen|Review files changed/.test(screen);
  // After Tab, '/di' completed to '/diff ' in the input row.
  base.sawSlashCompleted = r.snapshots.some((s) => s.lines.some((l) => /^\s*│?\s*>\s*\/diff\b/.test(l)));
}

if (name === 'bash-bang') {
  base.sawBashOutput = /anvilwing-bash-ok/.test(screen);          // echo ran, output rendered
  base.sawBashCmdLine = /\$ echo anvilwing-bash-ok/.test(screen); // the `$ cmd` echo line
}

if (name === 'multiline-input') {
  // First line keeps the '> ' mark …
  base.sawFirstLine = r.snapshots.some((s) => s.lines.some((l) => />\s*aaa\b/.test(l)));
  // … and a continuation line carries 'bbb' with NO '>' mark (multi-line render).
  base.sawContinuationLine = r.snapshots.some((s) => s.lines.some((l) => /bbb/.test(l) && !l.includes('>')));
}

if (name === 'slash-enter-run') {
  // Enter on the '/cont' partial completed-and-ran /context (panel rendered).
  base.sawContextRan = /% context left|Window|Free|Context/.test(screen);
}

if (name === 'question-shortcuts') {
  // A body row of the shortcuts panel (not just that the command was handled).
  base.sawShortcutsBody = /Shift\+Tab|move cursor|reverse-i-search|Ctrl\+/i.test(screen);
  // `?` must NOT have been inserted as text into the input box.
  base.questionNotTyped = !r.snapshots.some((s) => s.lines.some((l) => /^\s*│?\s*>\s*\?/.test(l)));
}

if (name === 'multiline-paste') {
  base.pasteAllLines = ['alpha', 'beta', 'gamma'].every((w) => r.snapshots.some((s) => s.lines.some((l) => l.includes(w))));
  base.pasteNotSubmitted = !/Analyzing request/.test(screen); // stayed in the buffer, not sent to the model
}

if (name === 'large-paste') {
  // The compact placeholder is shown in the box …
  base.sawPlaceholder = /\[Pasted text #1 \+6 lines\]/.test(screen);
  // … and the raw pasted lines do NOT flood the input box (no '> L0' row etc.).
  base.rawLinesNotInBox = !r.snapshots.some((s) =>
    s.lines.some((l) => /^\s*│?\s*>\s*L0\b/.test(l)),
  );
  // It stayed in the buffer, not submitted to the model.
  base.pasteNotSubmitted = !/Analyzing request/.test(screen);
}

if (name === 'forward-delete') {
  base.fwdDelCorrect = r.snapshots.some((s) => s.lines.some((l) => />\s*ac\b/.test(l)));   // 'b' removed forward
  base.fwdDelNotBackspace = !r.snapshots.some((s) => s.lines.some((l) => />\s*bc\b/.test(l))); // would be 'bc' if it backspaced
}

if (name === 'panel-dismiss') {
  // Timing-robust (no fixed windows): the panel appears at some point, and is
  // gone by the final frames after the keypress. Detect the panel by its
  // unique "(press any key to dismiss)" header — NOT "/key sk-", which also
  // appears in the BYO welcome box and the slash palette.
  const hasPanel = (s) => s.lines.some((l) => /press any key to dismiss/i.test(l));
  base.panelShown = r.snapshots.some(hasPanel);
  base.panelDismissed = base.panelShown && !r.snapshots.slice(-4).some(hasPanel);
  base.dismissKeyConsumed = !r.snapshots.some((s) => s.lines.some((l) => />\s*z/.test(l)));
}

if (name === 'live-tokens') {
  // Ordered per-frame readings of the spinner meta's `↑ N tokens` (fmtTokens
  // renders 999 → "999", 1234 → "1.2k").
  const readings = [];
  for (const s of r.snapshots) {
    for (const l of s.lines) {
      const m = l.match(/↑ ([\d.]+)(k?) tokens/);
      if (m) { readings.push(Math.round(parseFloat(m[1]) * (m[2] ? 1000 : 1))); break; }
    }
  }
  base.tokenReadings = readings.slice(0, 300);
  base.sawTokenMeter = readings.some((n) => n > 0);
  base.tokenIncreased = readings.some((n, i) => i > 0 && n > readings[i - 1]);
}

if (name === 'esc-interrupt') {
  base.sawWasBusy = /TEST BUSY/.test(screen);     // a turn was actually running
  base.sawInterrupted = /Interrupted/.test(screen); // Esc fired handleInterrupt
}

if (name === 'panel-esc-interrupt') {
  const hasPanel = (s) => s.lines.some((l) => /press any key to dismiss/i.test(l));
  base.panelShown = r.snapshots.some(hasPanel);
  base.panelDismissed = base.panelShown && !r.snapshots.slice(-4).some(hasPanel);
  base.sawWasBusy = /TEST BUSY/.test(screen);       // a turn was actually running
  base.sawInterrupted = /Interrupted/.test(screen); // Esc during the panel ALSO interrupted
}

if (name === 'followup-queue') {
  base.sawFollowOne = r.snapshots.some((s) => s.lines.some((l) => /follow one while busy/i.test(l)));
  base.sawFollowTwo = r.snapshots.some((s) => s.lines.some((l) => /follow two while busy/i.test(l)));
  base.sawOldQueuedBanner = /Queued.*pending|⏳.*Queued.*pending/i.test(screen);
  // The actual shipped graceful surface
  base.sawTransientQueued = r.snapshots.some((s) =>
    s.lines.some((l) => /(?:⏳ )?Queued \(\d+\)/i.test(l))
  );
  // During the forced busy seam window we should see both the TEST marker and the queue UI
  base.sawBusyWithQueue = r.snapshots.some((s) =>
    s.lines.some((l) => /TEST BUSY/i.test(l)) &&
    s.lines.some((l) => /(?:⏳ )?Queued \(\d+\)/i.test(l))
  );
}

process.stdout.write('E2E_RESULT ' + JSON.stringify(base) + '\n');
process.exit(0);
