/**
 * `~` / `~/` in a tool path must expand to the user's home, the way a shell
 * does. Before this, the file resolvers joined `~/foo` onto the cwd, so:
 *   - read_file('~/.x') looked under <cwd>/~/.x  -> "File not found", and
 *   - edit create of '~/.x' wrote a LITERAL `~` directory inside the project,
 *     silently the wrong place (the agent thinks it wrote to home).
 *
 * Drives the REAL read_file + Edit tools and the shared expandHome helper.
 */

import { describe, expect, test, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expandHome } from '../../src/utils/pathUtils.js';
import { createFileTools } from '../../src/tools/fileTools.js';
import { performSurgicalEdit } from '../../src/tools/editTools.js';

const HOME = os.homedir();
const probes: string[] = [];
afterEach(() => { for (const p of probes.splice(0)) { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } } });

describe('expandHome', () => {
  test.each([
    ['~', HOME],
    ['~/', path.join(HOME, '')],
    ['~/.zshrc', path.join(HOME, '.zshrc')],
    ['~/a/b/c.txt', path.join(HOME, 'a/b/c.txt')],
  ])('expands %s', (input, expected) => {
    expect(expandHome(input)).toBe(expected);
  });

  test.each([
    'relative/path.ts',
    '/absolute/path.ts',
    '~otheruser/file',           // another user's home — left untouched
    'src/~weird/name',           // ~ not at the start — untouched
  ])('leaves %s untouched', (input) => {
    expect(expandHome(input)).toBe(input);
  });
});

describe('file tools honour ~ (real home I/O)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-tilde-'));
  const read = createFileTools(dir).find((t) => t.name === 'read_file')!;

  test('read_file expands ~ (was File not found)', async () => {
    const name = `.ero_tilde_read_${process.pid}.txt`;
    const abs = path.join(HOME, name); probes.push(abs);
    fs.writeFileSync(abs, 'HOME_CONTENT_OK');
    const out = await read.handler({ path: `~/${name}` });
    expect(out).toContain('HOME_CONTENT_OK');
  });

  test('Edit create writes to home, NOT a literal ~ dir under cwd', async () => {
    const name = `.ero_tilde_write_${process.pid}.txt`;
    const abs = path.join(HOME, name); probes.push(abs);
    await performSurgicalEdit(dir, { file_path: `~/${name}`, old_string: '', new_string: 'WROTE_HOME' });
    expect(fs.existsSync(path.join(dir, '~'))).toBe(false);   // no junk ~ dir
    expect(fs.existsSync(abs)).toBe(true);                     // really in home
    expect(fs.readFileSync(abs, 'utf8')).toBe('WROTE_HOME');
  });
});

describe('source guard: resolvers run expandHome', () => {
  const { readFileSync } = require('node:fs');
  const { resolve } = require('node:path');
  test.each(['fileTools', 'editTools', 'searchTools', 'notebookTools'])('%s imports/uses expandHome', (f) => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'tools', `${f}.ts`), 'utf8');
    expect(src).toMatch(/expandHome/);
  });
});
