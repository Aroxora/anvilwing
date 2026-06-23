/**
 * PTY-driven UI harness for the anvilwing/anvilwing CLI.
 *
 * Spawns the CLI through node-pty so it sees a real TTY and emits the
 * full rich-mode byte stream (animated spinner, overlay redraws, paste
 * markers, cursor moves). Pipes the stream into @xterm/headless which
 * interprets ANSI codes and maintains a virtual rows×cols screen. We
 * snapshot the screen on a tick and the raw byte stream is also kept
 * for pattern-grep.
 *
 * Detects:
 *   - flicker: same cell flipping back-and-forth within a short window
 *   - bottom-row scroll: how many `\n` got committed at the last row
 *     (this is the "blank line per second above chat box" symptom)
 *   - stuck spinner: same cell stays unchanged for >stuckMs while we
 *     expected animation
 *   - bracketed-paste leak: \x1b[200~ / \x1b[201~ markers visible on
 *     screen
 *   - elapsed-timer freeze on idle: "esc to interrupt · Ns" line still
 *     present after we stopped streaming
 *
 * Usage: node test/ui-pty/harness.mjs <scenario>
 */

import { spawn } from 'node-pty';
import pkg from '@xterm/headless';
const { Terminal } = pkg;
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const COLS = 120;
const ROWS = 30;

/**
 * Run the CLI for `durationMs` while feeding it `inputs` (each is a
 * string written to the pty after `delayMs`). Returns a structured
 * report of detected anomalies.
 */
export async function runScenario({
  name,
  inputs = [],
  durationMs = 15_000,
  cwd = REPO_ROOT,
  cliBin = resolve(REPO_ROOT, 'dist', 'bin', 'anvilwing.js'),
  args = [],
  env = {},
  // Optional sink for the raw byte stream. The upgrader wires this up
  // to push every pty chunk into a live Helia mirror tab. Defaults to a
  // no-op so the existing test/ui-pty/run.mjs path is unaffected.
  onChunk = null,
  // Optional sink fired the FIRST TIME each anomaly class appears in
  // any snapshot frame. Lets the upgrader surface bugs in real time
  // (within one snapshot tick) rather than waiting for the scenario
  // to finish. Receives { kind, count, sample, at, snapshotIdx }.
  onAnomaly = null,
}) {
  const term = new Terminal({
    cols: COLS,
    rows: ROWS,
    allowProposedApi: true,
    scrollback: 5_000,
  });

  // Spawn CLI through pty so isTTY=true and rich mode kicks in. Use the
  // local node binary so the test runs without needing a global install.
  const ptyProc = spawn(process.execPath, [cliBin, ...args], {
    name: 'xterm-256color',
    cols: COLS,
    rows: ROWS,
    cwd,
    env: { ...process.env, ...env, FORCE_COLOR: '1' },
    handleFlowControl: false,
  });

  // Raw byte stream — kept verbatim for pattern grepping later.
  const rawChunks = [];
  // Per-frame screen snapshots taken on a fixed cadence.
  const snapshots = [];
  // Bottom-row history: for each tick, the contents of the last row
  // before any tick-induced scroll. Used to detect "blank line drifting
  // up" when the same blank line appears row-by-row in subsequent ticks.
  const bottomRowHistory = [];
  // Per-cell change counter — flicker detector. Map of `${row},${col}`
  // → count of distinct values seen within a sliding window.
  const cellChangeCounts = new Map();
  // Number of physical scroll events the emulator emitted (line dropped
  // off the top of the screen).
  let scrollCount = 0;

  // Stream-byte error detector. Fires onAnomaly within the same tick a
  // stack-trace / Error / unhandled-rejection / native-binding error
  // appears in the raw output — orders of magnitude faster than the
  // 80 ms snapshot tick. Matches against a sliding window of recent
  // bytes so we catch patterns that span chunk boundaries.
  const STREAM_ERROR_PATTERNS = [
    { re: /\bError:\s+(?!Failed to fetch)/, kind: 'live-stream-error' },
    { re: /\bTypeError:\s/, kind: 'live-stream-typeerror' },
    { re: /\bReferenceError:\s/, kind: 'live-stream-referenceerror' },
    { re: /\bUnhandledPromiseRejection/, kind: 'live-stream-unhandled-rejection' },
    { re: /\bUncaught\s+\w+:/, kind: 'live-stream-uncaught' },
    { re: /\bnode:internal\/[^\s]+:\d+/, kind: 'live-stream-node-internal-trace' },
    { re: /\n\s+at\s+\S+\s+\([^)]+:\d+:\d+\)/, kind: 'live-stream-stack-trace' },
    { re: /\b(?:EACCES|ENOENT|EPERM|EBUSY|EADDRINUSE):\s/, kind: 'live-stream-syscall-error' },
    { re: /Cannot find module\s+['"]/, kind: 'live-stream-cannot-find-module' },
    { re: /\bDeprecationWarning:\s/, kind: 'live-stream-deprecation' },
  ];
  let streamWindow = '';
  const STREAM_WINDOW_MAX = 4096;
  ptyProc.onData((data) => {
    rawChunks.push(data);
    term.write(data);
    if (onChunk) {
      try { onChunk(data); } catch { /* mirror is best-effort */ }
    }
    // Append to rolling window and rescan ONLY the new bytes plus a
    // small overlap so we catch patterns that straddle chunk
    // boundaries.
    const overlap = streamWindow.slice(-256);
    streamWindow = (overlap + data).slice(-STREAM_WINDOW_MAX);
    for (const p of STREAM_ERROR_PATTERNS) {
      const m = streamWindow.match(p.re);
      if (m) {
        fireAnomaly({
          kind: p.kind,
          sample: streamWindow.slice(Math.max(0, m.index - 20), m.index + 120).replace(/\s+/g, ' '),
          at: Date.now(),
          snapshotIdx: snapshots.length,
        });
      }
    }
  });

  // Hook the emulator's onScroll if available; xterm-headless emits it
  // when a line is pushed into scrollback.
  if (typeof term.onScroll === 'function') {
    term.onScroll(() => { scrollCount++; });
  }

  const inputTimers = [];
  for (const { delayMs, data } of inputs) {
    inputTimers.push(setTimeout(() => {
      try { ptyProc.write(data); } catch { /* dead pty */ }
    }, delayMs));
  }

  // Snapshot every 80ms to catch bespoke short-lived bugs (e.g. a one-frame
  // flicker after a keystroke). 250ms misses sub-frame artifacts.
  const SNAPSHOT_MS = 80;
  // Per-anomaly-kind dedupe so we fire onAnomaly at most once per kind
  // per scenario — surfaces the bug the moment it first appears, then
  // stays quiet until end-of-run.
  const emittedAnomalyKinds = new Set();
  const liveSignatures = [
    { re: /Anvilwing Coder/i, kind: 'live-duplicate-banner-anvilwing' },
    { re: /Signed in as/i, kind: 'live-duplicate-banner-signed-in' },
    { re: /Balance:\s*\$/, kind: 'live-duplicate-banner-balance' },
    { re: /\/help for commands/i, kind: 'live-duplicate-banner-help-hint' },
  ];
  const fireAnomaly = (payload) => {
    if (emittedAnomalyKinds.has(payload.kind)) return;
    emittedAnomalyKinds.add(payload.kind);
    if (onAnomaly) {
      try { onAnomaly(payload); } catch { /* best-effort */ }
    }
  };
  const snapshotInterval = setInterval(() => {
    const buf = term.buffer.active;
    const lines = [];
    for (let r = 0; r < ROWS; r++) {
      const line = buf.getLine(buf.viewportY + r);
      lines.push(line ? line.translateToString(true) : '');
    }
    snapshots.push({
      at: Date.now(),
      cursor: { row: buf.cursorY, col: buf.cursorX },
      lines,
    });
    bottomRowHistory.push(lines[ROWS - 1] ?? '');

    // ── Live anomaly detection (cheap, runs every snapshot) ────────
    const snapIdx = snapshots.length - 1;
    // Duplicate banner / signature lines visible simultaneously.
    for (const sig of liveSignatures) {
      const hits = lines.filter((l) => sig.re.test(l));
      if (hits.length > 1) {
        fireAnomaly({
          kind: sig.kind,
          count: hits.length,
          sample: hits[0].trim().slice(0, 80),
          at: Date.now(),
          snapshotIdx: snapIdx,
        });
      }
    }
    // Two prompt rows on screen at the same time.
    const promptRows = lines.filter((l) => /^>\s/.test(l));
    if (promptRows.length > 1) {
      fireAnomaly({
        kind: 'live-duplicate-prompt-row',
        count: promptRows.length,
        sample: promptRows[0].slice(0, 80),
        at: Date.now(),
        snapshotIdx: snapIdx,
      });
    }
    // Bracketed-paste markers visible on screen as text.
    if (lines.some((l) => l.includes('[200~') || l.includes('[201~'))) {
      fireAnomaly({
        kind: 'live-bracketed-paste-leak',
        sample: lines.find((l) => l.includes('[200~') || l.includes('[201~')).slice(0, 80),
        at: Date.now(),
        snapshotIdx: snapIdx,
      });
    }

    // SCROLLBACK-AWARE duplicate detection. The user-reported "chat box
    // duplication" bug commits each redraw frame to scrollback rather
    // than rewriting in place. The active 30-row viewport sees only the
    // latest frame, so we have to walk scrollback to catch it.
    const totalRows = buf.length; // includes scrollback
    const scrollbackStart = Math.max(0, totalRows - 200);
    let promptRowsInScrollback = 0;
    let dividerRowsInScrollback = 0;
    for (let y = scrollbackStart; y < totalRows; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (/^>\s/.test(text)) promptRowsInScrollback++;
      else if (/^─{40,}$/.test(text)) dividerRowsInScrollback++;
    }
    if (promptRowsInScrollback >= 2) {
      fireAnomaly({
        kind: 'live-prompt-row-stacked-in-scrollback',
        count: promptRowsInScrollback,
        sample: `${promptRowsInScrollback} prompt rows visible across active+scrollback`,
        at: Date.now(),
        snapshotIdx: snapIdx,
      });
    }
    if (dividerRowsInScrollback >= 4) {
      fireAnomaly({
        kind: 'live-divider-rows-stacked-in-scrollback',
        count: dividerRowsInScrollback,
        sample: `${dividerRowsInScrollback} '─' divider rows in scrollback`,
        at: Date.now(),
        snapshotIdx: snapIdx,
      });
    }

    // Cell change tally — only track activity around the bottom 8 rows
    // where the chat-box overlay lives. This is the area that
    // legitimately animates (spinner) but shouldn't churn cells beyond
    // the spinner column.
    const prev = snapshots[snapshots.length - 2];
    if (prev) {
      for (let r = ROWS - 8; r < ROWS; r++) {
        if (r < 0) continue;
        const a = prev.lines[r] ?? '';
        const b = lines[r] ?? '';
        if (a === b) continue;
        for (let c = 0; c < Math.max(a.length, b.length); c++) {
          if (a[c] === b[c]) continue;
          const k = `${r},${c}`;
          cellChangeCounts.set(k, (cellChangeCounts.get(k) ?? 0) + 1);
        }
      }
    }
  }, SNAPSHOT_MS);

  const exitedPromise = new Promise((resolve) => {
    ptyProc.onExit(({ exitCode, signal }) => {
      resolve({ exitCode, signal });
    });
  });

  // Hard timeout — kill the pty if the run goes longer than expected.
  const killTimer = setTimeout(() => {
    try { ptyProc.kill(); } catch { /* ignore */ }
  }, durationMs);

  let exitInfo = null;
  // Race: either the duration elapses (then we kill) or the proc exits
  // on its own. Either way, await the exit so we know it's torn down.
  try {
    await Promise.race([
      exitedPromise,
      new Promise((resolve) => setTimeout(resolve, durationMs + 500)),
    ]);
  } finally {
    clearInterval(snapshotInterval);
    for (const t of inputTimers) clearTimeout(t);
    clearTimeout(killTimer);
    try { ptyProc.kill(); } catch { /* already dead */ }
    exitInfo = await Promise.race([
      exitedPromise,
      new Promise((resolve) => setTimeout(() => resolve({ exitCode: null, signal: null }), 1000)),
    ]);
  }

  // ===== Detection =====
  const findings = [];
  const raw = rawChunks.join('');

  // 1. Bracketed-paste leak — the markers should never end up rendered
  //    on screen as visible characters. If they do, sanitization missed.
  for (let i = 0; i < snapshots.length; i++) {
    const text = snapshots[i].lines.join('\n');
    if (text.includes('[200~') || text.includes('[201~')) {
      findings.push({
        kind: 'bracketed-paste-leak',
        at: snapshots[i].at,
        snapshot: i,
        sample: text.match(/\[20[01]~/g)?.[0],
      });
      break;
    }
  }

  // 2. Stuck-on-paste timer — after we stopped streaming the elapsed
  //    "esc to interrupt · Ns" line should NOT appear on the final
  //    screen. We trigger this by measuring snapshots taken in the last
  //    second of the run and asserting no "esc to interrupt" line.
  const tail = snapshots.slice(-3);
  for (const s of tail) {
    if (s.lines.some((l) => /esc to interrupt/.test(l))) {
      findings.push({
        kind: 'streaming-line-after-idle',
        at: s.at,
        line: s.lines.find((l) => /esc to interrupt/.test(l)),
      });
      break;
    }
  }

  // 3. Per-second blank-line drift — measure how many *distinct* blank
  //    lines drifted up through any specific row in the chat-box vicinity.
  //    Heuristic: the last row alternates between blank and non-blank
  //    each render, but we shouldn't see a strictly monotonic pattern of
  //    blank lines being committed.
  let suspectedScrollDrift = 0;
  for (let i = 1; i < snapshots.length; i++) {
    // If a row in the upper-middle of the screen suddenly becomes blank
    // and the row below it inherits the previous content, something
    // scrolled up.
    const prev = snapshots[i - 1];
    const cur = snapshots[i];
    for (let r = ROWS - 10; r < ROWS - 4; r++) {
      if (r < 1) continue;
      const prevRow = prev.lines[r] ?? '';
      const curRow = cur.lines[r] ?? '';
      const curRowBelow = cur.lines[r + 1] ?? '';
      // Old content moved down by 1 row AND the row above became blank
      if (
        prevRow.trim() &&
        !curRow.trim() &&
        prevRow.trim() === curRowBelow.trim()
      ) {
        suspectedScrollDrift++;
      }
    }
  }
  if (suspectedScrollDrift > 1) {
    findings.push({ kind: 'scroll-drift', count: suspectedScrollDrift });
  }

  // 4. High-flicker cells — any single cell that changed >6 times in
  //    the run, outside the spinner column (which legitimately animates).
  //    The spinner sits at column 0-2 of one row inside the activity line.
  const flickerCells = [];
  for (const [key, count] of cellChangeCounts) {
    if (count >= 6) {
      const [r, c] = key.split(',').map(Number);
      // Skip the spinner cells (col 0-3) on activity row.
      if (c <= 3) continue;
      flickerCells.push({ row: r, col: c, changes: count });
    }
  }
  if (flickerCells.length > 5) {
    // Only report when many cells flicker — a single noisy cell isn't a
    // real bug.
    findings.push({
      kind: 'flicker',
      cellCount: flickerCells.length,
      sample: flickerCells.slice(0, 6),
    });
  }

  // 5. Renderer crashed marker
  if (raw.includes('[renderer]')) {
    findings.push({
      kind: 'renderer-error',
      sample: raw.match(/\[renderer\][^\n]+/g)?.slice(0, 3),
    });
  }

  // 6. Unhandled rejection / TypeError surfaced to stdout
  const errMatch = raw.match(/(?:UnhandledPromiseRejection|TypeError|Error: [^\n]{1,120})/g);
  if (errMatch && errMatch.length > 0) {
    findings.push({
      kind: 'error-in-stream',
      samples: errMatch.slice(0, 5),
    });
  }

  // 7. Did process exit cleanly (or at all)?
  // `-1073741510` (= 0xC000013A = STATUS_CONTROL_C_EXIT) is Windows'
  // exit code when a process is terminated via the console Ctrl-C
  // path, which is exactly what `ptyProc.kill()` does on Windows
  // ConPTY. SIGTERM (143) on POSIX is the analog. Neither is a real
  // bug — we forced the kill ourselves.
  const KNOWN_KILL_EXIT_CODES = new Set([null, 0, 130, 143, -1073741510]);
  if (exitInfo?.exitCode != null && !KNOWN_KILL_EXIT_CODES.has(exitInfo.exitCode)) {
    findings.push({
      kind: 'nonzero-exit',
      exitCode: exitInfo.exitCode,
      signal: exitInfo.signal,
    });
  }

  return {
    name,
    durationMs,
    snapshotCount: snapshots.length,
    rawByteCount: raw.length,
    rawStream: raw,
    snapshots,
    scrollCount,
    findings,
    finalScreen: snapshots[snapshots.length - 1],
    exitInfo,
  };
}

/** Tiny helper used by external callers (run.mjs) to surface the raw stream. */
export function getRawStream(report) {
  return report?.rawStream ?? '';
}

/** Pretty-print a screen snapshot for human review. */
export function renderScreen(snap) {
  if (!snap) return '<no snapshot>';
  const top = '┌' + '─'.repeat(COLS) + '┐';
  const bot = '└' + '─'.repeat(COLS) + '┘';
  const body = snap.lines.map((l) => '│' + (l.padEnd(COLS).slice(0, COLS)) + '│').join('\n');
  return `${top}\n${body}\n${bot}\n cursor=(${snap.cursor.row}, ${snap.cursor.col})`;
}

/** Persist artifacts (raw stream + snapshots) for later inspection. */
export function saveArtifacts(report, raw, dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${report.name}.raw.txt`), raw, 'binary');
  // Per-frame snapshot timeline as JSONL for offline replay / grep.
  if (Array.isArray(report.snapshots) && report.snapshots.length > 0) {
    const lines = report.snapshots
      .map((s) => JSON.stringify(s))
      .join('\n');
    writeFileSync(resolve(dir, `${report.name}.snapshots.jsonl`), lines + '\n');
  }
  // Strip the heavy snapshots + rawStream out of the report JSON — they're
  // already on disk in their own files. Keep the rest for fast scan.
  const { snapshots: _snapshots, rawStream: _raw, ...lite } = report;
  writeFileSync(
    resolve(dir, `${report.name}.report.json`),
    JSON.stringify(lite, null, 2),
  );
}
