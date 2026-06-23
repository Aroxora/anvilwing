/**
 * End-to-end: ToolRuntime + hooks pipeline.
 *
 * The unit tests in hooks.test.ts cover the hook engine in isolation.
 * This file wires a real ToolRuntime with a hook config and asserts
 * that hooks actually fire (and block / append) when a tool is
 * executed via runtime.execute(...) — the path the agent loop uses.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolRuntime } from '../src/core/toolRuntime.js';
import type { ToolDefinition } from '../src/core/toolRuntime.js';

function jsonHookCmd(payload: unknown): string {
  // base64 sidesteps shell-quoting differences on Windows / POSIX.
  const b64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
  return `node -e "process.stdout.write(Buffer.from('${b64}','base64').toString('utf-8'))"`;
}

function writeProjectSettings(workingDir: string, config: unknown): void {
  const dir = join(workingDir, '.anvilwing');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(config), 'utf-8');
}

const echoTool: ToolDefinition = {
  name: 'EchoTest',
  description: 'echo a string back; used to test hooks',
  parameters: {
    type: 'object' as const,
    properties: {
      text: { type: 'string' as const, description: 'string to echo' },
    },
    required: ['text'],
  },
  handler: async (args: Record<string, unknown>) => {
    return `echo:${String(args['text'] ?? '')}`;
  },
};

describe('ToolRuntime + hooks integration', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'anvilwing-runtime-hooks-'));
  });
  afterEach(() => {
    try { rmSync(workingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('runtime.execute returns the hook block message when PreToolUse blocks', async () => {
    writeProjectSettings(workingDir, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'EchoTest',
            hooks: [{ type: 'command', command: jsonHookCmd({ decision: 'block', reason: 'denied for test' }) }],
          },
        ],
      },
    });
    const runtime = new ToolRuntime([echoTool], { workingDir });
    const result = await runtime.execute({ id: 'c1', name: 'EchoTest', arguments: { text: 'hello' } });
    expect(result).toContain('blocked by user hook');
    expect(result).toContain('denied for test');
    // The handler should NOT have run — verify by checking the
    // result doesn't contain the echo prefix.
    expect(result).not.toContain('echo:hello');
  });

  it('PostToolUse hook output is appended to a successful tool result', async () => {
    writeProjectSettings(workingDir, {
      hooks: {
        PostToolUse: [
          {
            matcher: 'EchoTest',
            hooks: [{ type: 'command', command: jsonHookCmd({ appendToResult: '[audited]' }) }],
          },
        ],
      },
    });
    const runtime = new ToolRuntime([echoTool], { workingDir });
    const result = await runtime.execute({ id: 'c2', name: 'EchoTest', arguments: { text: 'world' } });
    expect(result).toContain('echo:world');
    expect(result).toContain('[audited]');
  });

  it('hook with non-matching matcher does not affect execution', async () => {
    writeProjectSettings(workingDir, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'DifferentToolName',
            hooks: [{ type: 'command', command: jsonHookCmd({ decision: 'block', reason: 'should not block' }) }],
          },
        ],
      },
    });
    const runtime = new ToolRuntime([echoTool], { workingDir });
    const result = await runtime.execute({ id: 'c3', name: 'EchoTest', arguments: { text: 'pass' } });
    expect(result).toContain('echo:pass');
    expect(result).not.toContain('blocked');
  });

  it('"*" matcher applies to every tool', async () => {
    writeProjectSettings(workingDir, {
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: jsonHookCmd({ decision: 'block', reason: 'all tools off' }) }],
          },
        ],
      },
    });
    const runtime = new ToolRuntime([echoTool], { workingDir });
    const result = await runtime.execute({ id: 'c4', name: 'EchoTest', arguments: { text: 'x' } });
    expect(result).toContain('all tools off');
  });

  it('hook timeout does not stall the runtime indefinitely', async () => {
    // Engine clamps min timeout to 500ms, so use 600ms — well under
    // Jest's default 5s test timeout but high enough to verify the
    // engine actually waits and then continues vs. hanging on the
    // child process.
    writeProjectSettings(workingDir, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'EchoTest',
            hooks: [
              {
                type: 'command',
                command: 'node -e "setTimeout(()=>{},30000)"',
                timeoutMs: 600,
              },
            ],
          },
        ],
      },
    });
    const runtime = new ToolRuntime([echoTool], { workingDir });
    const start = Date.now();
    const result = await runtime.execute({ id: 'c5', name: 'EchoTest', arguments: { text: 'y' } });
    const elapsed = Date.now() - start;
    // Hook timed out → tool should still run (best-effort behavior).
    expect(result).toContain('echo:y');
    // Sanity: didn't actually wait the full 30s.
    expect(elapsed).toBeLessThan(4000);
  }, 8000);

  it('hook that crashes (non-zero exit) does not block the tool', async () => {
    writeProjectSettings(workingDir, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'EchoTest',
            hooks: [{ type: 'command', command: 'node -e "process.exit(1)"' }],
          },
        ],
      },
    });
    const runtime = new ToolRuntime([echoTool], { workingDir });
    const result = await runtime.execute({ id: 'c6', name: 'EchoTest', arguments: { text: 'z' } });
    // Crashed hook is treated as pass-through.
    expect(result).toContain('echo:z');
  });
});
