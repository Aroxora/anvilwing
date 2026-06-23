/**
 * Edge cases for custom slash command loader: malformed JSON,
 * duplicate command names, mixed array/object payloads, missing
 * fields. Each path has historically been a source of "command not
 * found" or silent skips.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCustomSlashCommands, buildCustomCommandPrompt } from '../src/core/customCommands.js';

describe('customCommands edge cases', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'anvilwing-custom-edge-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips malformed JSON without throwing', () => {
    writeFileSync(join(dir, 'broken.json'), '{this is not json');
    writeFileSync(
      join(dir, 'good.json'),
      JSON.stringify({
        command: 'good',
        description: 'works',
        template: 'tpl',
        requireInput: false,
      })
    );
    const cmds = loadCustomSlashCommands(dir);
    expect(cmds.length).toBe(1);
    expect(cmds[0]?.command).toBe('/good');
  });

  it('deduplicates by command name across files', () => {
    writeFileSync(
      join(dir, 'a.json'),
      JSON.stringify({ command: 'shared', description: 'first', template: 'A', requireInput: false })
    );
    writeFileSync(
      join(dir, 'b.json'),
      JSON.stringify({ command: 'shared', description: 'second', template: 'B', requireInput: false })
    );
    const cmds = loadCustomSlashCommands(dir);
    expect(cmds.length).toBe(1);
  });

  it('accepts an array payload of multiple commands', () => {
    writeFileSync(
      join(dir, 'pack.json'),
      JSON.stringify([
        { command: 'one', description: 'd1', template: 't1', requireInput: false },
        { command: 'two', description: 'd2', template: 't2', requireInput: false },
        { command: 'three', description: 'd3', template: 't3', requireInput: false },
      ])
    );
    const cmds = loadCustomSlashCommands(dir);
    expect(cmds.length).toBe(3);
    expect(cmds.map((c) => c.command).sort()).toEqual(['/one', '/three', '/two']);
  });

  it('skips entries missing required fields', () => {
    writeFileSync(
      join(dir, 'partial.json'),
      JSON.stringify([
        { command: 'has-cmd', description: 'd', template: 't', requireInput: false },
        { command: 'no-template' /* missing template */ },
        { description: 'no-command-key' },
      ])
    );
    const cmds = loadCustomSlashCommands(dir);
    expect(cmds.length).toBe(1);
    expect(cmds[0]?.command).toBe('/has-cmd');
  });

  it('returns empty array when the directory does not exist', () => {
    const cmds = loadCustomSlashCommands(join(dir, 'does-not-exist'));
    expect(cmds).toEqual([]);
  });

  it('buildCustomCommandPrompt substitutes {{workspace}}, {{profile}}, {{input}}', () => {
    const cmd = {
      command: '/foo',
      description: '',
      template: 'In {{workspace}} as {{profile}} -> {{input}}',
      requireInput: true,
      source: 'test',
    };
    const out = buildCustomCommandPrompt(cmd, 'do thing', {
      workspace: '/tmp/proj',
      profile: 'general',
      provider: 'anvilwing',
      model: 'anvilwing',
    });
    expect(out).toContain('/tmp/proj');
    expect(out).toContain('general');
    expect(out).toContain('do thing');
  });

  it('buildCustomCommandPrompt with empty input still produces a prompt', () => {
    const cmd = {
      command: '/foo',
      description: '',
      template: 'just {{profile}}',
      requireInput: false,
      source: 'test',
    };
    const out = buildCustomCommandPrompt(cmd, '', {
      workspace: '/x',
      profile: 'general',
      provider: 'anvilwing',
      model: 'anvilwing',
    });
    expect(out).toContain('general');
  });
});
