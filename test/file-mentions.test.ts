/**
 * @-file mentions (content expansion) — REAL files on disk, no mocks. An
 * `@path` in a prompt inlines that file's content for the agent; emails,
 * nonexistent paths, directories, and over-limit files are left untouched.
 * Source assertion locks the processPrompt wiring (agent-bound copy expanded,
 * displayed history unchanged).
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expandFileMentions, activeMentionPartial, rankFileMatches, applyMentionCompletion, listWorkspaceFiles } from '../src/core/fileMentions.js';

const SHELL = readFileSync(resolve(__dirname, '..', 'src', 'headless', 'interactiveShell.ts'), 'utf8');

describe('@-file mentions — content expansion on real files', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'anvilwing-fm-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('inlines a referenced file under a "Referenced files" block', () => {
    writeFileSync(join(dir, 'util.ts'), 'export const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, hi));\n');
    const r = expandFileMentions('explain @util.ts please', dir);
    expect(r.included).toEqual(['util.ts']);
    expect(r.prompt).toMatch(/--- Referenced files ---/);
    expect(r.prompt).toContain('export const clamp');
    expect(r.prompt.startsWith('explain @util.ts please')).toBe(true); // original kept verbatim, content appended
  });

  it('does NOT treat an email address as a mention', () => {
    const r = expandFileMentions('email me at bo@ero.solar', dir);
    expect(r.included).toEqual([]);
    expect(r.prompt).toBe('email me at bo@ero.solar');
  });

  it('leaves a nonexistent @path untouched', () => {
    const r = expandFileMentions('read @does-not-exist.ts', dir);
    expect(r.included).toEqual([]);
    expect(r.prompt).toBe('read @does-not-exist.ts');
  });

  it('inlines a directory mention as a bounded listing (Claude Code parity)', () => {
    mkdirSync(join(dir, 'srcdir'));
    writeFileSync(join(dir, 'srcdir', 'alpha.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'srcdir', 'beta.ts'), 'export const b = 2;\n');
    mkdirSync(join(dir, 'srcdir', 'nested'));
    const r = expandFileMentions('look at @srcdir', dir);
    expect(r.included).toEqual(['srcdir']);
    expect(r.prompt).toMatch(/@srcdir \(directory listing\)/);
    expect(r.prompt).toContain('alpha.ts');
    expect(r.prompt).toContain('beta.ts');
    expect(r.prompt).toContain('nested/'); // subdirs shown with a trailing slash
  });

  it('a @dir/ mention (trailing slash) also lists the directory', () => {
    mkdirSync(join(dir, 'pkg'));
    writeFileSync(join(dir, 'pkg', 'index.ts'), 'export default 1;\n');
    const r = expandFileMentions('what is in @pkg/', dir);
    expect(r.included).toEqual(['pkg/']);
    expect(r.prompt).toContain('index.ts');
  });

  it('dedupes repeated mentions of the same file', () => {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    const r = expandFileMentions('@a.ts and again @a.ts', dir);
    expect(r.included).toEqual(['a.ts']);
  });

  it('inlines multiple distinct files', () => {
    writeFileSync(join(dir, 'a.ts'), 'AAA');
    writeFileSync(join(dir, 'b.ts'), 'BBB');
    const r = expandFileMentions('compare @a.ts and @b.ts', dir);
    expect(r.included.sort()).toEqual(['a.ts', 'b.ts']);
    expect(r.prompt).toContain('AAA');
    expect(r.prompt).toContain('BBB');
  });

  it('strips trailing sentence punctuation from the path', () => {
    writeFileSync(join(dir, 'note.md'), '# hi\n');
    const r = expandFileMentions('see @note.md.', dir);
    expect(r.included).toEqual(['note.md']);
  });

  it('skips a file over the size cap', () => {
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(200 * 1024)); // > 100KB cap
    const r = expandFileMentions('read @big.txt', dir);
    expect(r.included).toEqual([]);
  });

  it('no @ → prompt returned unchanged', () => {
    const r = expandFileMentions('just a normal prompt', dir);
    expect(r.included).toEqual([]);
    expect(r.prompt).toBe('just a normal prompt');
  });
});

describe('@-mention autocomplete — pure matching/replace logic', () => {
  const files = ['src/util.ts', 'src/utils/format.ts', 'README.md', 'src/core/agent.ts'];

  it('activeMentionPartial reads the @token at the cursor (and is email-safe)', () => {
    expect(activeMentionPartial('see @uti', 8)).toBe('uti');
    expect(activeMentionPartial('go @', 4)).toBe('');        // bare @ → match all
    expect(activeMentionPartial('no mention here', 5)).toBeNull();
    expect(activeMentionPartial('mail a@b.com', 12)).toBeNull(); // email, not a mention
    expect(activeMentionPartial('@a and @b', 2)).toBe('a');  // partial at cursor, not the later @
  });

  it('rankFileMatches ranks basename-prefix above substring above path', () => {
    expect(rankFileMatches('util', files)).toEqual(['src/util.ts', 'src/utils/format.ts']);
    expect(rankFileMatches('agent', files)).toEqual(['src/core/agent.ts']);
    expect(rankFileMatches('', files, 2)).toEqual(['src/util.ts', 'src/utils/format.ts']); // bare @ → first N
    expect(rankFileMatches('zzz', files)).toEqual([]);
  });

  it('applyMentionCompletion replaces the @partial with @path and a trailing space', () => {
    expect(applyMentionCompletion('see @uti', 8, 'src/util.ts')).toEqual({ text: 'see @src/util.ts ', cursor: 17 });
    expect(applyMentionCompletion('@a', 2, 'README.md')).toEqual({ text: '@README.md ', cursor: 11 });
  });

  it('listWorkspaceFiles excludes node_modules/.git and is bounded', () => {
    const ws = listWorkspaceFiles(resolve(__dirname, '..'), 5000);
    expect(ws.length).toBeGreaterThan(0);
    expect(ws.some((f) => f.includes('node_modules'))).toBe(false);
    expect(ws.some((f) => f.startsWith('.git/'))).toBe(false);
    expect(ws).toContain('src/config.ts');
  });

  it('listWorkspaceFiles offers directories as completion candidates (trailing /)', () => {
    const ws = listWorkspaceFiles(resolve(__dirname, '..'), 5000);
    expect(ws).toContain('src/');       // a directory is mentionable now
    expect(ws).toContain('src/core/');  // including nested
  });
});

describe('@-file mentions — wired into processPrompt (agent-bound copy only)', () => {
  it('expands the agent-bound sanitizedPrompt, not the displayed history', () => {
    expect(SHELL).toMatch(/import \{ expandFileMentions/);
    expect(SHELL).toMatch(/const mentions = expandFileMentions\(prompt, this\.workingDir\)/);
    expect(SHELL).toMatch(/const sanitizedPrompt = mentions\.prompt/);
    // The user-visible history commit is unchanged — only sanitizedPrompt
    // (sent via controller.send) carries the inlined content.
    expect(SHELL).toMatch(/this\.controller\.send\(sanitizedPrompt\)/);
  });
});
