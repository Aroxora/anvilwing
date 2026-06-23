/**
 * Run all PTY UI scenarios and print a consolidated report.
 *
 *   node test/ui-pty/run.mjs
 *
 * To run only one scenario:
 *
 *   node test/ui-pty/run.mjs idle-launch
 */

import { runScenario, renderScreen, getRawStream } from './harness.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = resolve(__dirname, 'artifacts');

const ESC = '\x1b';

// Suppress node-pty's `AttachConsole failed` worker stderr — it's a
// known harmless Windows ConPTY issue when running outside a real
// console host. The actual pty data flow still works.
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  if (s.includes('AttachConsole failed') || s.includes('conpty_console_list_agent.js')) {
    return true;
  }
  return origStderrWrite(chunk, ...rest);
};

const SCENARIOS = [
  {
    name: 'idle-launch',
    description: 'Launch CLI, sit idle for 6s, exit. Catches stuck spinner / leftover overlay artifacts.',
    durationMs: 6000,
    inputs: [
      // After 4s, send Ctrl+D to quit cleanly (handles "buffer empty" path).
      { delayMs: 4000, data: '\x04' },
    ],
  },
  {
    name: 'paste-trailing-newline',
    description: 'Paste "test prompt\\n" rapidly — should NOT auto-submit (post-paste enter guard).',
    durationMs: 5000,
    inputs: [
      // Wait for prompt to settle, then "paste" content that ends in \n.
      // node-pty doesn't bracket-paste-wrap us by default, so this hits
      // the plain-paste / emit-buffered path. The trailing "\n" should
      // be eaten by the trailing-newline strip + the post-paste guard.
      { delayMs: 1500, data: 'paste content here\r\n' },
      { delayMs: 4500, data: '\x04' }, // Ctrl+D quit
    ],
  },
  {
    name: 'escape-during-streaming',
    description: 'Submit a slash command that does nothing dangerous, then press Esc; ensure spinner clears.',
    durationMs: 8000,
    inputs: [
      // Type a non-existent slash command + Enter, then Esc to abort.
      // /help is safe + idempotent on the renderer.
      { delayMs: 1500, data: '/help\r' },
      { delayMs: 3500, data: '\x1b' }, // Esc
      { delayMs: 7000, data: '\x04' },
    ],
  },
  {
    name: 'long-input-no-submit',
    description: 'Type a long line (no Enter) — verify scroll-drift / per-second blank lines do NOT happen during pure idle.',
    durationMs: 6500,
    inputs: [
      { delayMs: 1500, data: 'this is a longer line of input that we do not submit because we want to verify the chat box renders stably while the user is composing' },
      { delayMs: 6000, data: '\x04' },
    ],
  },
  {
    name: 'rapid-toggle-spam',
    description: 'Hammer Alt+G / Alt+V / Alt+D toggles — flicker / corruption check.',
    durationMs: 5000,
    inputs: [
      // ESC + letter is the "Option sends Meta" form the renderer detects.
      { delayMs: 1200, data: `${ESC}g${ESC}g${ESC}v${ESC}v${ESC}d${ESC}d` },
      { delayMs: 4500, data: '\x04' },
    ],
  },
  {
    name: 'help-then-clear',
    description: 'Submit /help, then /clear, then quit. Exercises inline-panel + full-screen clear paths.',
    durationMs: 7000,
    inputs: [
      // The body and the \r MUST be sent separately. A single multi-char
      // chunk gets routed through the emit-level paste buffer, which
      // strips a single trailing \n/\r — that's the post-paste enter
      // guard doing its job. Real keyboard input arrives one keystroke
      // at a time, so we replicate that here.
      { delayMs: 1500, data: '/help' },
      { delayMs: 1800, data: '\r' },
      { delayMs: 4000, data: '/clear' },
      { delayMs: 4300, data: '\r' },
      { delayMs: 6500, data: '\x04' },
    ],
  },
  {
    name: 'bash-streaming-output',
    description: 'Run /bash that emits a line every ~500ms — closest local analog to the per-second blank-line flicker bug from long video gen tools. Should NOT cause scroll-drift findings.',
    durationMs: 11000,
    inputs: [
      // Body and Enter need a gap larger than the emit-paste idle window
      // (30ms) PLUS the post-paste enter guard (120ms) so the \r is
      // treated as a fresh keypress, not a tail of the paste burst.
      // 250ms is comfortably above both.
      { delayMs: 1500, data: '/bash for i in 1 2 3 4 5 6; do echo "tick $i"; sleep 0.5; done' },
      // Try `\r` first, then `\n` as a fallback. ConPTY/git-bash mintty
      // can translate line endings differently. The redundant ones are
      // harmless on a buffer that's already empty after submit.
      { delayMs: 2200, data: '\r' },
      { delayMs: 2400, data: '\n' },
      { delayMs: 10500, data: '\x04' },
    ],
  },
];

function fmt(report) {
  const lines = [];
  lines.push('');
  lines.push(`━━━ ${report.name} ━━━`);
  lines.push(`  duration:   ${report.durationMs}ms`);
  lines.push(`  snapshots:  ${report.snapshotCount}`);
  lines.push(`  raw bytes:  ${report.rawByteCount}`);
  lines.push(`  scrolls:    ${report.scrollCount}`);
  lines.push(`  exit:       code=${report.exitInfo?.exitCode ?? 'n/a'} signal=${report.exitInfo?.signal ?? 'n/a'}`);
  if (report.findings.length === 0) {
    lines.push(`  findings:   none ✓`);
  } else {
    lines.push(`  findings:   ${report.findings.length} ⚠`);
    for (const f of report.findings) {
      lines.push(`    - ${f.kind}: ${JSON.stringify(f).slice(0, 240)}`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const onlyName = process.argv[2];
  const targets = onlyName
    ? SCENARIOS.filter((s) => s.name === onlyName)
    : SCENARIOS;

  if (targets.length === 0) {
    console.error(`No scenario matches '${onlyName}'. Available: ${SCENARIOS.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }

  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  console.log(`Running ${targets.length} PTY scenario(s)...`);
  let bugCount = 0;
  for (const s of targets) {
    let report;
    try {
      report = await runScenario(s);
    } catch (err) {
      console.error(`✗ ${s.name}: harness crashed`, err);
      bugCount++;
      continue;
    }
    bugCount += report.findings.length;
    console.log(fmt(report));
    if (report.finalScreen) {
      writeFileSync(
        resolve(ARTIFACTS_DIR, `${s.name}.final-screen.txt`),
        renderScreen(report.finalScreen),
      );
    }
    if (report.rawStream != null) {
      // Persist the raw byte stream too so analyze-raw.mjs can
      // pattern-scan for cursor-hide/show cycles, erase bursts, etc.
      writeFileSync(
        resolve(ARTIFACTS_DIR, `${s.name}.raw.txt`),
        report.rawStream,
        'binary',
      );
    }
    writeFileSync(
      resolve(ARTIFACTS_DIR, `${s.name}.report.json`),
      JSON.stringify({ ...report, rawStream: undefined }, null, 2),
    );
  }

  console.log('');
  console.log(`Total findings across ${targets.length} scenarios: ${bugCount}`);
  process.exit(bugCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('harness error:', e);
  process.exit(2);
});
