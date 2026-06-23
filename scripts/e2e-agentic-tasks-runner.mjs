#!/usr/bin/env node
// Broader real-binary / real-model behavioural proofs beyond "create a file":
// EDIT an existing file (X→Y), RUN a shell command and use its output, and a
// 2-STEP task. Each runs the REAL built binary against the REAL model in a
// sandboxed temp workdir and asserts on the real disk. Prints a TASK_RESULT
// JSON digest the jest test asserts on. Subprocess pattern (clean node process,
// not the jest worker) — a direct pty.spawn from the worker stalls the model
// round-trip.
//
// Usage: node scripts/e2e-agentic-tasks-runner.mjs <edit|bash|twostep>
// Key: ANVILWING_API_KEY env or the gitignored .env (BYO). No key → prints
// TASK_RESULT {"skipped":"no-key"} and exits 0.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = resolve(REPO, 'dist', 'bin', 'anvilwing.js');
const require = createRequire(import.meta.url);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b[()][AB0]/g, '');

function resolveKey() {
  if (process.env.ANVILWING_API_KEY) return process.env.ANVILWING_API_KEY;
  try { return (readFileSync(join(REPO, '.env'), 'utf8').match(/^ANVILWING_API_KEY=(.+)$/m) || [])[1]?.trim() || null; }
  catch { return null; }
}

const scenario = process.argv[2] || 'edit';
const KEY = resolveKey();
if (!KEY) { console.log('TASK_RESULT ' + JSON.stringify({ skipped: 'no-key' })); process.exit(0); }

const work = mkdtempSync(join(tmpdir(), 'tw-task-'));
const data = mkdtempSync(join(tmpdir(), 'tw-task-data-'));
const read = (f) => { try { return readFileSync(join(work, f), 'utf8'); } catch { return ''; } };

// Each scenario: prepares the sandbox, gives the task prompt, and supplies a
// `done()` predicate polled against the real disk plus a `digest()` of results.
const SCENARIOS = {
  edit: {
    setup: () => writeFileSync(join(work, 'target.txt'), 'config:\n  value: OLD_VALUE_ALPHA\n  keep: this_line\n'),
    task: 'Edit the file target.txt in the current directory: change OLD_VALUE_ALPHA to NEW_VALUE_BETA. Change nothing else. Then stop.',
    done: () => read('target.txt').includes('NEW_VALUE_BETA'),
    digest: () => {
      const t = read('target.txt');
      return {
        changed: t.includes('NEW_VALUE_BETA'),
        oldGone: !t.includes('OLD_VALUE_ALPHA'),
        keptOtherLine: t.includes('keep: this_line'), // a surgical edit, not a clobber
      };
    },
  },
  bash: {
    setup: () => {},
    task: 'Run the shell command `echo TWK-BASH-MARKER-9` and write its exact stdout to a new file named out.txt in the current directory. Then stop.',
    done: () => read('out.txt').includes('TWK-BASH-MARKER-9'),
    digest: () => ({ outFileHasCommandOutput: read('out.txt').includes('TWK-BASH-MARKER-9') }),
  },
  twostep: {
    setup: () => {},
    task: 'Do two things in order: (1) create a file a.txt in the current directory containing exactly the single word hello. (2) Then create a file b.txt containing the UPPERCASE of a.txt\'s content (so b.txt holds HELLO). Then stop.',
    done: () => read('a.txt').includes('hello') && read('b.txt').includes('HELLO'),
    digest: () => ({
      step1Ok: read('a.txt').trim() === 'hello',
      step2Ok: read('b.txt').trim() === 'HELLO',
    }),
  },
  multifile: {
    setup: () => {
      writeFileSync(join(work, 'one.txt'), 'header\nstatus: MARKER_OLD\nfooter\n');
      writeFileSync(join(work, 'two.txt'), 'title\nstatus: MARKER_OLD\nend\n');
    },
    task: 'Two files in this directory — one.txt and two.txt — each contain the text MARKER_OLD. Change MARKER_OLD to MARKER_NEW in BOTH files. Change nothing else. Then stop.',
    done: () => read('one.txt').includes('MARKER_NEW') && read('two.txt').includes('MARKER_NEW'),
    digest: () => {
      const a = read('one.txt'); const b = read('two.txt');
      return {
        bothChanged: a.includes('MARKER_NEW') && b.includes('MARKER_NEW'),
        bothOldGone: !a.includes('MARKER_OLD') && !b.includes('MARKER_OLD'),
        keptContext: a.includes('header') && a.includes('footer') && b.includes('title') && b.includes('end'),
      };
    },
  },
  recover: {
    // A GENUINE error-recovery loop: a real off-by-one bug. Running it prints
    // SUM=NaN (the `<=` reads one past the array → undefined → NaN). The agent
    // must read, diagnose, fix the source, re-run, and capture the right output.
    setup: () => writeFileSync(join(work, 'buggy.js'),
      'const nums = [3, 4, 5];\nlet total = 0;\nfor (let i = 0; i <= nums.length; i++) total += nums[i];\nconsole.log("SUM=" + total);\n'),
    task: 'The file buggy.js in this directory has a bug — running it with `node buggy.js` prints SUM=NaN instead of the correct sum of [3, 4, 5]. Find and fix the bug in buggy.js, run it again to confirm it now prints SUM=12, and write that exact output line to fixed.txt. Then stop.',
    done: () => read('fixed.txt').includes('SUM=12'),
    digest: () => ({
      bugFixed: !read('buggy.js').includes('<= nums.length'), // the off-by-one is gone
      outputCaptured: read('fixed.txt').includes('SUM=12'),    // the corrected run was captured
    }),
  },
  // /clear must start a FRESH conversation (Claude Code parity): tell the agent
  // a secret, /clear, then ask for it back — a working /clear means the model
  // no longer knows it. `drive` overrides the default task/poll flow.
  clearmem: {
    drive: async (term, getScreen) => {
      const SECRET = 'CLEARTEST-MAGENTA-88';
      term.write('Remember this token for later, just acknowledge it: ' + SECRET + '\r');
      await wait(18_000);                       // let the agent acknowledge
      const beforeLen = getScreen().length;     // mark the boundary
      term.write('/clear\r');
      await wait(3_000);                        // screen + history reset
      term.write('What token did I ask you to remember earlier? If you do not know, reply exactly: I-DONT-KNOW\r');
      await wait(18_000);                       // let the agent answer
      const afterClear = getScreen().slice(beforeLen);
      return {
        forgotSecret: !afterClear.includes(SECRET), // the model no longer knows it
        sawAcknowledge: getScreen().slice(0, beforeLen).includes(SECRET), // it DID see it pre-clear
      };
    },
  },
};

const S = SCENARIOS[scenario];
if (!S) { console.log('TASK_RESULT ' + JSON.stringify({ skipped: 'unknown-scenario:' + scenario })); process.exit(0); }

const pty = require('node-pty');
const term = pty.spawn('node', [BIN], {
  name: 'xterm-256color', cols: 100, rows: 36, cwd: work,
  env: { ...process.env, ANVILWING_API_KEY: KEY, ANVILWING_DATA_DIR: data, FORCE_COLOR: '1' },
});
let buf = '';
term.onData((d) => { buf += d; });

try {
  S.setup?.();
  const bootDeadline = Date.now() + 20_000;
  while (Date.now() < bootDeadline && !/for commands|for shortcuts|No Anvilwing/.test(strip(buf))) await wait(250);
  let digest;
  if (S.drive) {
    // Custom multi-step drive (e.g. /clear-then-ask). Hands the scenario the
    // pty and a stripped-screen accessor; it returns its own digest.
    digest = await S.drive(term, () => strip(buf));
  } else {
    term.write(S.task + '\r');
    const deadline = Date.now() + 170_000;
    while (Date.now() < deadline) {
      if (S.done()) break;
      await wait(1000);
    }
    await wait(1500);
    digest = S.digest();
  }
  const screen = strip(buf);
  console.log('TASK_RESULT ' + JSON.stringify({
    scenario,
    ...digest,
    sawError: /\b(401|403|429|invalid api key|unauthorized)\b/i.test(screen),
  }));
} finally {
  try { term.kill(); } catch { /* ignore */ }
  rmSync(work, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
}
