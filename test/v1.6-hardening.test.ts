/**
 * v1.6 hardening — four real correctness bugs surfaced by the broad discovery
 * sweep, each fixed with a fail-before/pass-after test against the REAL artifact
 * (no mock for the thing under test).
 *
 *  A — contextManager.pruneMessagesWithSummary dropped the summarize boundary
 *      when startIndex peeled leading turns (the `- startIndex` slice bug), so
 *      summarization silently no-op'd instead of compressing the leading turn.
 *  B — bashTools BackgroundShell.getNewOutput re-returned the ENTIRE stderr
 *      history on every poll (no read-position tracking, filter ignored).
 *  C — the Glob tool advertised head_limit (default 50) but hard-capped the
 *      displayed results at 5, making the parameter a no-op.
 *  D — the Grep tool threw an uncaught SyntaxError on an invalid regex instead
 *      of returning a model-recoverable error like Search does.
 */

import { ContextManager } from '../src/core/contextManager';
import { createBashTools } from '../src/tools/bashTools';
import { createSearchTools } from '../src/tools/searchTools';
import { createGrepTools } from '../src/tools/grepTools';
import type { ConversationMessage } from '../src/core/types';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tool = (tools: ReturnType<typeof createBashTools>, name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('A — pruneMessagesWithSummary summarizes the leading turn peeled by startIndex (#prune-boundary)', () => {
  test('a leading assistant turn with an unmatched tool call is summarized, not silently skipped', async () => {
    const recorded: ConversationMessage[] = [];
    const cm = new ContextManager({
      maxTokens: 100000,
      targetTokens: 80000,
      useLLMSummarization: true,
      preserveRecentMessages: 5, // > the 1 user turn below → the recency walk keeps ALL turns
      summarizationCallback: async (msgs) => { recorded.push(...msgs); return 'SUMMARY'; },
    });

    // turns[0] is an assistant turn whose toolCall has NO matching tool result,
    // so startIndex peels it. Before the fix the summarize slice became empty and
    // the callback was never called; after, this leading turn is summarized.
    const messages: ConversationMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'PEELED_MARKER doing work', toolCalls: [{ id: 'tc1', name: 'X', arguments: {} }] },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1 final answer' },
    ];

    const result = await cm.pruneMessagesWithSummary(messages, { force: true });

    expect(result.summarized).toBe(true);
    expect(result.removed).toBeGreaterThan(0);
    // The peeled turn's content reached the summarizer (was dropped from both
    // sets before the fix).
    expect(recorded.some((m) => typeof m.content === 'string' && m.content.includes('PEELED_MARKER'))).toBe(true);
  });
});

describe('B — BashOutput returns only NEW stderr, not the whole history (#bgshell-stderr)', () => {
  test('a second poll does not re-return stderr already seen', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eros-bg-'));
    try {
      const tools = createBashTools(dir);
      const exec = tool(tools, 'execute_bash');
      const out = tool(tools, 'BashOutput');

      const started = await exec.handler({ command: 'echo E1 >&2; echo E2 >&2; echo DONE', run_in_background: true });
      const m = /shell started:\s*(\S+)/i.exec(String(started));
      expect(m).toBeTruthy();
      const bashId = m![1];

      await sleep(400); // let the echoes land + the shell exit

      const poll1 = String(await out.handler({ bash_id: bashId }));
      expect(poll1).toContain('E1');
      expect(poll1).toContain('E2');

      const poll2 = String(await out.handler({ bash_id: bashId }));
      // No new stderr arrived → it must NOT be re-dumped.
      expect(poll2).not.toContain('E1');
      expect(poll2).not.toContain('E2');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});

describe('C — Glob head_limit caps display at the requested limit, not 5 (#glob-head-limit)', () => {
  test('head_limit:10 over 12 files lists 10 paths', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eros-glob-'));
    try {
      for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `f${i}.ts`), `// file ${i}\n`);
      const glob = tool(createSearchTools(dir), 'Glob');
      const result = String(await glob.handler({ pattern: '**/*.ts', head_limit: 10, path: dir }));
      const fileLines = result.split('\n').filter((l) => l.endsWith('.ts')); // path lines, not the header (ends `.ts":`)
      expect(fileLines.length).toBe(10); // was hard-capped at 5 before the fix
      expect(result).toContain('12 file(s)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('D — Grep returns a graceful error on an invalid regex (#grep-invalid-regex)', () => {
  test('an unterminated group resolves to an Error string, not a thrown SyntaxError', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eros-grep-'));
    try {
      const grep = tool(createGrepTools(dir), 'Grep');
      await expect(grep.handler({ pattern: '(unclosed' })).resolves.toMatch(/invalid regex/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
