/**
 * Permission mode (Claude Code's Shift+Tab interaction) — verified against
 * the REAL ToolRuntime.execute chokepoint and the REAL filesystem, per
 * CLAUDE.md "Tests run real" + "behavioural assertion + source assertion".
 *
 * Fail-before/pass-after: before plan mode existed, an Edit in any state
 * wrote the file. The `plan mode blocks a real Edit` case below fails on the
 * pre-change tree (the file gets created) and passes after (the call is
 * blocked at the runtime and the file never appears on disk).
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolRuntime, type ToolDefinition } from '../src/core/toolRuntime.js';
import { createEditTools } from '../src/tools/editTools.js';
import { createBashTools } from '../src/tools/bashTools.js';
import {
  getPermissionMode, setPermissionMode, cyclePermissionMode,
  isMutatingTool, isEditTool, planModeBlock, shouldSkipPreflight,
  permissionHint, permissionModeStrip, permissionStatusChip,
} from '../src/core/permissionMode.js';

const SRC = readFileSync(join(__dirname, '..', 'src', 'core', 'permissionMode.ts'), 'utf-8');
const RUNTIME_SRC = readFileSync(join(__dirname, '..', 'src', 'core', 'toolRuntime.ts'), 'utf-8');

function buildRuntime(workingDir: string): ToolRuntime {
  const tools: ToolDefinition[] = [
    ...createEditTools(workingDir),
    ...createBashTools(workingDir),
  ];
  return new ToolRuntime(tools, { workingDir, enableCache: false });
}

describe('permission mode — Shift+Tab cycle', () => {
  afterEach(() => setPermissionMode('default'));

  it('starts in default mode', () => {
    expect(getPermissionMode()).toBe('default');
  });

  it('cycles default → acceptEdits → plan → default', () => {
    setPermissionMode('default');
    expect(cyclePermissionMode()).toBe('acceptEdits');
    expect(cyclePermissionMode()).toBe('plan');
    expect(cyclePermissionMode()).toBe('default');
  });

  it('exposes the trailing strip hint per mode', () => {
    expect(permissionHint('default')).toBe('shift+tab — ? for shortcuts');
    expect(permissionHint('acceptEdits')).toBe('shift+tab to cycle');
    expect(permissionHint('plan')).toBe('shift+tab to cycle');
  });

  it('the trailing hint defaults to the live module state', () => {
    setPermissionMode('plan');
    expect(permissionHint()).toBe('shift+tab to cycle');
    setPermissionMode('default');
    expect(permissionHint()).toBe('shift+tab — ? for shortcuts');
  });

  it('shows a status chip only outside default mode (keeps chrome quiet)', () => {
    expect(permissionStatusChip('default')).toBeNull();
    expect(permissionStatusChip('acceptEdits')).toBe('accept-edits');
    expect(permissionStatusChip('plan')).toBe('plan');
  });
});

describe('permission mode — toggle-modes strip', () => {
  afterEach(() => setPermissionMode('default'));

  it.each([
    ['default', [true, false, false]],
    ['acceptEdits', [false, true, false]],
    ['plan', [false, false, true]],
  ] as const)('strip for %s highlights exactly that mode', (mode, actives) => {
    expect(permissionModeStrip(mode)).toEqual([
      { label: '⏵ default', active: actives[0] },
      { label: '⏵⏵ accept edits', active: actives[1] },
      { label: '⏸ plan', active: actives[2] },
    ]);
  });

  it('defaults to the live module state', () => {
    setPermissionMode('acceptEdits');
    expect(permissionModeStrip().filter((s) => s.active).map((s) => s.label)).toEqual(['⏵⏵ accept edits']);
  });
});

describe('permission mode — tool classification', () => {
  it.each([
    'write', 'write_file', 'edit', 'edit_file', 'multiedit', 'multi_edit',
    'delete_file', 'notebookedit', 'git_commit', 'git_push',
    'bash', 'execute_bash', 'execute_command', 'run_command', 'shell',
    'WRITE', 'Edit', 'Bash', // case-insensitive
  ])('isMutatingTool(%s) === true', (name) => {
    expect(isMutatingTool(name)).toBe(true);
  });

  it.each([
    'read', 'read_file', 'grep', 'search', 'glob', 'list_files',
    'git_status', 'git_diff', 'git_log', 'web_fetch', 'web_search', 'memory_load',
  ])('isMutatingTool(%s) === false', (name) => {
    expect(isMutatingTool(name)).toBe(false);
  });

  it('isEditTool covers file edits but not bash', () => {
    expect(isEditTool('edit')).toBe(true);
    expect(isEditTool('write_file')).toBe(true);
    expect(isEditTool('bash')).toBe(false);
    expect(isEditTool('git_commit')).toBe(false);
  });
});

describe('permission mode — planModeBlock / shouldSkipPreflight pure logic', () => {
  afterEach(() => setPermissionMode('default'));

  it('plan mode blocks mutating tools, allows read-only', () => {
    setPermissionMode('plan');
    expect(planModeBlock('write_file')).toMatch(/disabled in plan mode/);
    expect(planModeBlock('bash')).toMatch(/disabled in plan mode/);
    expect(planModeBlock('read_file')).toBeNull();
    expect(planModeBlock('grep')).toBeNull();
  });

  it('plan mode is deny-by-default — closes the leaks the old allowlist missed', () => {
    setPermissionMode('plan');
    // These could mutate files/repo/processes but were NOT in the old
    // MUTATING_TOOLS allowlist, so they leaked through plan mode.
    for (const tool of ['search_replace', 'git', 'git_smart_commit', 'git_create_pr',
      'GitRestore', 'NotebookEdit', 'memory_save', 'memory_delete', 'KillShell',
      'Agent', 'parallel_agents', 'Skill']) {
      expect(planModeBlock(tool)).toMatch(/disabled in plan mode/);
    }
    // An unknown/newly-added tool is blocked by default (safe).
    expect(planModeBlock('some_future_tool')).toMatch(/disabled in plan mode/);
  });

  it('plan mode still allows real read-only + planning work', () => {
    setPermissionMode('plan');
    for (const tool of ['read_file', 'Read', 'glob', 'Grep', 'Search', 'list_files',
      'file_exists', 'web_fetch', 'WebSearch', 'TodoRead', 'TodoWrite', 'memory_load',
      'GitHistory', 'agent_status', 'BashOutput']) {
      expect(planModeBlock(tool)).toBeNull();
    }
  });

  it('default and acceptEdits never block (guardrail-free contract preserved)', () => {
    setPermissionMode('default');
    expect(planModeBlock('write_file')).toBeNull();
    expect(planModeBlock('bash')).toBeNull();
    setPermissionMode('acceptEdits');
    expect(planModeBlock('write_file')).toBeNull();
    expect(planModeBlock('bash')).toBeNull();
  });

  it('only acceptEdits skips the adversarial pre-flight, and only for edits', () => {
    setPermissionMode('acceptEdits');
    expect(shouldSkipPreflight('edit')).toBe(true);
    expect(shouldSkipPreflight('bash')).toBe(false); // shell still critiqued
    setPermissionMode('default');
    expect(shouldSkipPreflight('edit')).toBe(false);
    setPermissionMode('plan');
    expect(shouldSkipPreflight('edit')).toBe(false);
  });
});

describe('permission mode — enforced at the REAL ToolRuntime chokepoint', () => {
  let workingDir: string;
  beforeEach(() => { workingDir = mkdtempSync(join(tmpdir(), 'anvilwing-perm-')); });
  afterEach(() => {
    setPermissionMode('default');
    try { rmSync(workingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('plan mode blocks a real Edit — the file is never written to disk', async () => {
    setPermissionMode('plan');
    const runtime = buildRuntime(workingDir);
    const result = await runtime.execute({
      id: 'p1', name: 'Edit',
      arguments: { file_path: 'blocked.txt', old_string: '', new_string: 'should not exist\n' },
    });
    expect(result).toMatch(/disabled in plan mode/);
    expect(existsSync(join(workingDir, 'blocked.txt'))).toBe(false);
  });

  it('plan mode blocks a real Bash command — the side effect never happens', async () => {
    setPermissionMode('plan');
    const runtime = buildRuntime(workingDir);
    const marker = join(workingDir, 'ran.txt');
    const result = await runtime.execute({
      id: 'p2', name: 'execute_bash',
      arguments: { command: `echo hi > ${JSON.stringify(marker)}` },
    });
    expect(result).toMatch(/disabled in plan mode/);
    expect(existsSync(marker)).toBe(false);
  });

  it('default mode runs the same Edit (guardrail-free behaviour unchanged)', async () => {
    setPermissionMode('default');
    const runtime = buildRuntime(workingDir);
    const result = await runtime.execute({
      id: 'd1', name: 'Edit',
      arguments: { file_path: 'allowed.txt', old_string: '', new_string: 'written\n' },
    });
    expect(result).not.toMatch(/disabled in plan mode/);
    expect(existsSync(join(workingDir, 'allowed.txt'))).toBe(true);
    expect(readFileSync(join(workingDir, 'allowed.txt'), 'utf-8')).toBe('written\n');
  });

  it('acceptEdits mode runs a real Edit', async () => {
    setPermissionMode('acceptEdits');
    const runtime = buildRuntime(workingDir);
    const result = await runtime.execute({
      id: 'a1', name: 'Edit',
      arguments: { file_path: 'edited.txt', old_string: '', new_string: 'ok\n' },
    });
    expect(result).not.toMatch(/disabled in plan mode/);
    expect(existsSync(join(workingDir, 'edited.txt'))).toBe(true);
  });

  it('plan mode still allows read-only tools (Read of an existing file)', async () => {
    writeFileSync(join(workingDir, 'readme.txt'), 'hello plan\n');
    setPermissionMode('plan');
    const runtime = new ToolRuntime(
      [...createEditTools(workingDir), ...createBashTools(workingDir)],
      { workingDir, enableCache: false },
    );
    // Edit with a read-only intent is still mutating; instead assert that a
    // non-mutating tool name is not blocked by the gate at all.
    expect(planModeBlock('read_file')).toBeNull();
    // and a mutating one is, through the same runtime instance:
    const blocked = await runtime.execute({
      id: 'p3', name: 'Edit',
      arguments: { file_path: 'readme.txt', old_string: 'hello', new_string: 'HELLO' },
    });
    expect(blocked).toMatch(/disabled in plan mode/);
    expect(readFileSync(join(workingDir, 'readme.txt'), 'utf-8')).toBe('hello plan\n'); // unchanged
  });
});

describe('permission mode — source assertions (refactor-proofing per CLAUDE.md)', () => {
  it('permissionMode.ts plan-blocks deny-by-default (allow only read-only)', () => {
    expect(SRC).toMatch(/current !== 'plan'/);
    expect(SRC).toMatch(/isPlanModeReadOnly\(toolName\)/);
    // bash must NOT be on the read-only allowlist (its args can do anything).
    expect(SRC).not.toMatch(/PLAN_MODE_READONLY[\s\S]*?'bash'/);
  });
  it('toolRuntime.ts calls planModeBlock at the execute chokepoint and returns the block', () => {
    expect(RUNTIME_SRC).toMatch(/import \{ planModeBlock, shouldSkipPreflight/);
    expect(RUNTIME_SRC).toMatch(/const planBlock = planModeBlock\(call\.name\)/);
    expect(RUNTIME_SRC).toMatch(/return planBlock;/);
  });
  it('toolRuntime.ts lets acceptEdits skip the adversarial pre-flight', () => {
    expect(RUNTIME_SRC).toMatch(/!shouldSkipPreflight\(call\.name\)/);
  });
  it('App.tsx renders the strip per-segment with the active mode in ember', () => {
    const APP = readFileSync(join(__dirname, '..', 'src', 'ui', 'ink', 'App.tsx'), 'utf-8');
    expect(APP).toMatch(/strip\.map\(/);
    expect(APP).toMatch(/seg\.active[\s\S]*?<Text color="#ff9f43">\{seg\.label\}<\/Text>/);
    // The trailing hint must fall back to the LIVE module state (mirroring
    // `strip`), not a hardcoded default-mode literal; permissionMode.ts owns
    // the wording.
    expect(APP).toMatch(/permissionHint \?\? permissionHintFn\(\)/);
    expect(SRC).toMatch(/\? for shortcuts/);
  });
  it('InkPromptController wires strip + trailing hint + meta line into the tree', () => {
    const CTRL = readFileSync(join(__dirname, '..', 'src', 'ui', 'ink', 'InkPromptController.ts'), 'utf-8');
    expect(CTRL).toMatch(/permissionStrip: permissionModeStrip\(\)/);
    expect(CTRL).toMatch(/permissionHint: permissionHint\(\)/);
    expect(CTRL).toMatch(/metaLine: modeChips/);
  });
});
