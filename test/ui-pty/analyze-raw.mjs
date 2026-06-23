/**
 * Pattern-scan the captured raw byte streams from the harness
 * artifacts. Surfaces things the screen-snapshot detector can miss:
 *   - excessive cursor-hide/show cycles per second (flicker symptom)
 *   - `\x1b[J` (erase to end of screen) bursts
 *   - bare \n bursts at terminal-bottom (scroll-into-history symptom)
 *   - bracketed paste markers committed to the stream
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = resolve(__dirname, 'artifacts');

const ESC = '\x1b';
const PATTERNS = [
  { name: 'cursor-hide-cycle', re: /\x1b\[\?25l/g },
  { name: 'cursor-show-cycle', re: /\x1b\[\?25h/g },
  { name: 'erase-to-end-of-screen', re: /\x1b\[J/g },
  { name: 'erase-line', re: /\x1b\[2?K/g },
  { name: 'cursor-up', re: /\x1b\[\d+A/g },
  { name: 'cursor-down', re: /\x1b\[\d+B/g },
  { name: 'bracketed-paste-start', re: /\x1b\[200~/g },
  { name: 'bracketed-paste-end', re: /\x1b\[201~/g },
  { name: 'bare-newline-no-cr', re: /[^\r]\n/g },
];

function scan(name, bytes) {
  const counts = {};
  for (const { name: pname, re } of PATTERNS) {
    const m = bytes.match(re);
    counts[pname] = m ? m.length : 0;
  }
  // Anomaly thresholds — these are heuristics tuned to the typical
  // rich-mode write rate. Adjust as scenarios grow.
  const flags = [];
  if (counts['cursor-hide-cycle'] !== counts['cursor-show-cycle']) {
    flags.push(`MISMATCHED hide/show: ${counts['cursor-hide-cycle']} vs ${counts['cursor-show-cycle']} — last cursor state may be wrong`);
  }
  if (counts['bracketed-paste-start'] > 0 || counts['bracketed-paste-end'] > 0) {
    // Markers in the *stream* are normal (the renderer enables paste
    // mode) but they should never reach the user's screen. We only
    // flag if there's a stray odd count.
    const startN = counts['bracketed-paste-start'];
    const endN = counts['bracketed-paste-end'];
    if (Math.abs(startN - endN) > 1) {
      flags.push(`paste markers asymmetric: start=${startN} end=${endN}`);
    }
  }
  if (counts['erase-to-end-of-screen'] > 80) {
    flags.push(`HIGH \\x1b[J usage: ${counts['erase-to-end-of-screen']} (flicker symptom)`);
  }
  if (counts['cursor-up'] / Math.max(1, counts['cursor-down']) > 3) {
    flags.push(`asymmetric cursor moves: up=${counts['cursor-up']} down=${counts['cursor-down']}`);
  }
  return { name, bytes: bytes.length, counts, flags };
}

const files = readdirSync(ARTIFACTS).filter((f) => f.endsWith('.report.json'));
let bugCount = 0;
for (const f of files) {
  const reportPath = resolve(ARTIFACTS, f);
  const reportName = f.replace(/\.report\.json$/, '');
  const rawPath = resolve(ARTIFACTS, `${reportName}.raw.txt`);
  let raw = '';
  try {
    raw = readFileSync(rawPath, 'binary');
  } catch {
    // Some scenarios don't save raw; we'll need to add that to harness
    // if we want richer pattern detection. Skip for now.
    continue;
  }
  const out = scan(reportName, raw);
  console.log(`\n━━━ ${out.name} (${out.bytes} bytes) ━━━`);
  for (const [k, v] of Object.entries(out.counts)) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
  if (out.flags.length > 0) {
    console.log(`  FLAGS:`);
    for (const flag of out.flags) {
      console.log(`    ⚠ ${flag}`);
      bugCount++;
    }
  }
}

console.log(`\nFlags total: ${bugCount}`);
process.exit(bugCount > 0 ? 1 : 0);
