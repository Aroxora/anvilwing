import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSkillTools } from '../src/tools/skillTools.js';

describe('Skill tools', () => {
  let workingDir: string;
  let list: (a: Record<string, unknown>) => Promise<string>;
  let load: (a: Record<string, unknown>) => Promise<string>;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'anvilwing-skill-'));
    const tools = createSkillTools(workingDir);
    list = tools.find((t) => t.name === 'list_skills')!.handler as never;
    load = tools.find((t) => t.name === 'Skill')!.handler as never;
  });
  afterEach(() => rmSync(workingDir, { recursive: true, force: true }));

  function writeSkill(folderName: string, frontmatter: { name?: string; description?: string }, body: string): void {
    const dir = join(workingDir, '.anvilwing', 'skills', folderName);
    mkdirSync(dir, { recursive: true });
    const fm = ['---'];
    if (frontmatter.name) fm.push(`name: ${frontmatter.name}`);
    if (frontmatter.description) fm.push(`description: ${frontmatter.description}`);
    fm.push('---');
    writeFileSync(join(dir, 'SKILL.md'), `${fm.join('\n')}\n\n${body}`, 'utf-8');
  }

  function writeFlatSkill(filename: string, frontmatter: { name?: string; description?: string }, body: string): void {
    const dir = join(workingDir, '.anvilwing', 'skills');
    mkdirSync(dir, { recursive: true });
    const fm = ['---'];
    if (frontmatter.name) fm.push(`name: ${frontmatter.name}`);
    if (frontmatter.description) fm.push(`description: ${frontmatter.description}`);
    fm.push('---');
    writeFileSync(join(dir, filename), `${fm.join('\n')}\n\n${body}`, 'utf-8');
  }

  it('returns helpful message when no skills installed', async () => {
    const out = await list({});
    expect(out).toContain('No skills installed');
  });

  it('lists folder-form skills (<name>/SKILL.md)', async () => {
    writeSkill('simplify', { name: 'simplify', description: 'Cleanup pass' }, 'do the cleanup');
    writeSkill('reviewer', { name: 'reviewer', description: 'Code review' }, 'review carefully');
    const out = await list({});
    expect(out).toContain('simplify');
    expect(out).toContain('Cleanup pass');
    expect(out).toContain('reviewer');
  });

  it('lists flat-form skills (<name>.md)', async () => {
    writeFlatSkill('flat.md', { name: 'flat', description: 'Flat layout' }, 'flat body');
    const out = await list({});
    expect(out).toContain('flat');
  });

  it('Skill loads the body of a discovered skill', async () => {
    writeSkill('simplify', { name: 'simplify', description: 'Cleanup' }, 'STEP 1: read code\nSTEP 2: simplify');
    const out = await load({ name: 'simplify' });
    expect(out).toContain('Skill: simplify');
    expect(out).toContain('STEP 1: read code');
    expect(out).toContain('STEP 2: simplify');
  });

  it('Skill returns clear error for missing name', async () => {
    writeSkill('a', { name: 'a', description: 'A' }, 'a-body');
    expect(await load({ name: 'nonexistent' })).toContain('not found');
    expect(await load({ name: 'nonexistent' })).toContain('a'); // available list
  });

  it('Skill rejects empty / missing name', async () => {
    expect(await load({})).toContain('Error');
    expect(await load({ name: '' })).toContain('Error');
  });

  it('Skills with no `name:` frontmatter fall back to directory/file name', async () => {
    writeSkill('legacy', { description: 'No name in frontmatter' }, 'body');
    const out = await list({});
    // Falls back to "legacy" (the folder name).
    expect(out).toContain('legacy');
  });
});
