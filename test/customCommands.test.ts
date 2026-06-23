import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadCustomSlashCommands, buildCustomCommandPrompt } from '../src/core/customCommands.js';

describe('test/customCommands.test.ts', () => {
  it('custom command loader reads JSON definitions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvilwing-custom-commands-'));
    const filePath = join(dir, 'standup.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        command: 'standup',
        description: 'Daily standup helper',
        template: 'Project {{profile}} :: {{input}} @ {{workspace}}',
        requireInput: true,
      })
    );

    const commands = loadCustomSlashCommands(dir);
    assert.equal(commands.length, 1);
    const standup = commands[0];
    assert.ok(standup);
    assert.equal(standup.command, '/standup');
    const prompt = buildCustomCommandPrompt(standup, 'Finish feature X', {
      workspace: '/tmp/project',
      profile: 'general',
      provider: 'anvilwing',
      model: 'anvilwing',
    });
    assert.match(prompt, /Finish feature X/);
    assert.match(prompt, /general/);
    assert.match(prompt, /\/tmp\/project/);

    rmSync(dir, { recursive: true, force: true });
  });
});