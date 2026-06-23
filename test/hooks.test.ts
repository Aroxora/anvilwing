import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadHooksConfig,
  runPreToolUseHooks,
  runPostToolUseHooks,
} from '../src/core/hooks.js';

describe('hooks', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'anvilwing-hooks-'));
  });
  afterEach(() => rmSync(workingDir, { recursive: true, force: true }));

  function writeProjectSettings(config: unknown): void {
    const dir = join(workingDir, '.anvilwing');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(config), 'utf-8');
  }

  /**
   * Build a hook command that prints the given payload as JSON.
   * Uses `node -e` for cross-platform reliability (cmd.exe's `type`
   * is finicky about backslash quoting; sh's `cat` works but the
   * code path is different). node is always present — our agent
   * is a Node app.
   */
  function jsonHookCmd(payload: unknown): string {
    // Encode the payload as a base64 string to sidestep all shell
    // quoting on both cmd.exe and sh.
    const b64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
    return `node -e "process.stdout.write(Buffer.from('${b64}','base64').toString('utf-8'))"`;
  }

  it('returns empty config when no settings file exists', () => {
    const cfg = loadHooksConfig(workingDir);
    expect(cfg.hooks).toBeDefined();
    expect(Object.keys(cfg.hooks!).length).toBe(0);
  });

  it('skips malformed JSON without throwing', () => {
    const dir = join(workingDir, '.anvilwing');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), '{not valid json', 'utf-8');
    const cfg = loadHooksConfig(workingDir);
    expect(cfg.hooks).toBeDefined();
  });

  it('PreToolUse hook can block a tool with a reason', async () => {
    const cmd = jsonHookCmd({ decision: 'block', reason: 'no Bash for you' });
    writeProjectSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: cmd }] }],
      },
    });
    const cfg = loadHooksConfig(workingDir);
    const result = await runPreToolUseHooks(cfg, 'Bash', { command: 'rm -rf /' });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('no Bash');
  });

  it('PreToolUse hook does NOT match when matcher differs', async () => {
    const cmd = jsonHookCmd({ decision: 'block', reason: 'X' });
    writeProjectSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: cmd }] }],
      },
    });
    const cfg = loadHooksConfig(workingDir);
    expect(await runPreToolUseHooks(cfg, 'Bash', { command: 'ls' })).toBe(null);
  });

  it('"*" matcher matches every tool', async () => {
    const cmd = jsonHookCmd({ decision: 'block', reason: 'global' });
    writeProjectSettings({
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd }] }],
      },
    });
    const cfg = loadHooksConfig(workingDir);
    const r1 = await runPreToolUseHooks(cfg, 'Bash', {});
    const r2 = await runPreToolUseHooks(cfg, 'Read', {});
    expect(r1?.decision).toBe('block');
    expect(r2?.decision).toBe('block');
  });

  it('PostToolUse hook can append text to result', async () => {
    const cmd = jsonHookCmd({ appendToResult: 'linted' });
    writeProjectSettings({
      hooks: {
        PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: cmd }] }],
      },
    });
    const cfg = loadHooksConfig(workingDir);
    const r = await runPostToolUseHooks(cfg, 'Edit', {}, 'edit ok');
    expect(r?.appendToResult).toContain('linted');
  });

  it('hook that errors / times out is silently skipped', async () => {
    const isWin = process.platform === 'win32';
    const broken = isWin
      ? 'exit /b 1'
      : 'exit 1';
    writeProjectSettings({
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: broken }] }],
      },
    });
    const cfg = loadHooksConfig(workingDir);
    const r = await runPreToolUseHooks(cfg, 'Bash', {});
    expect(r).toBe(null); // No block, just pass-through.
  });

  it('non-JSON stdout from a hook is treated as pass-through', async () => {
    const isWin = process.platform === 'win32';
    const noisy = isWin
      ? 'echo just plain text'
      : 'echo just plain text';
    writeProjectSettings({
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: noisy }] }],
      },
    });
    const cfg = loadHooksConfig(workingDir);
    const r = await runPreToolUseHooks(cfg, 'Bash', {});
    expect(r).toBe(null);
  });
});
