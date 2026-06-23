/**
 * Capability separation guard. The cowork productivity surface was
 * extracted to its own placeholder repo (~/GitHub/anvilwing-cowork)
 * in 2026-05 to keep this CLI focused on coding/terminal work.
 *
 * If a future change accidentally re-introduces cowork sources or
 * imports into this repo, this test catches it before the next ship.
 * The bug pattern we're guarding against: greeting "hi" triggering
 * cowork_standing_read / cowork_due_tasks tool calls, plus the
 * system-prompt addendum that drove the model toward those calls.
 *
 * See CLAUDE.md "Capability separation" for the architectural rule.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO = path.resolve(__dirname, '..');

describe('capability separation: cowork extracted, coding CLI clean', () => {
  test('src/cowork directory does not exist', () => {
    expect(fs.existsSync(path.join(REPO, 'src/cowork'))).toBe(false);
  });

  test('src/capabilities/coworkCapability.ts does not exist', () => {
    expect(fs.existsSync(path.join(REPO, 'src/capabilities/coworkCapability.ts'))).toBe(false);
  });

  test('src/runtime/node.ts does not import or instantiate CoworkCapabilityModule', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/runtime/node.ts'), 'utf-8');
    expect(src).not.toMatch(/CoworkCapabilityModule/);
    expect(src).not.toMatch(/from\s+['"][^'"]*\/cowork(?:\/|['"])/);
  });

  test('src/runtime/agentSession.ts has no cowork addendum or helper', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/runtime/agentSession.ts'), 'utf-8');
    // The COWORK_ADDENDUM string was the rule that told the model to
    // call cowork tools on every fresh session — it must not return.
    expect(src).not.toMatch(/COWORK_ADDENDUM\s*=/);
    expect(src).not.toMatch(/withCoworkAddendum\s*\(/);
    expect(src).not.toMatch(/cowork_standing_read|cowork_due_tasks|cowork_record_task/);
  });

  test('src/capabilities/index.ts does not export CoworkCapabilityModule', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/capabilities/index.ts'), 'utf-8');
    expect(src).not.toMatch(/^export\s+\{[^}]*CoworkCapabilityModule[^}]*\}/m);
    expect(src).not.toMatch(/from\s+['"]\.\/coworkCapability\.js['"]/);
  });

  test('no source file imports from src/cowork', () => {
    // Walk every .ts under src/ and assert no surviving import resolves
    // to the deleted path. Avoids the regression where one stray import
    // would build cleanly via a leftover dist artefact.
    const collect = (dir: string, out: string[] = []): string[] => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full, out);
        else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) out.push(full);
      }
      return out;
    };
    const files = collect(path.join(REPO, 'src'));
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf-8');
      if (/from\s+['"][^'"]*\/cowork(?:\/|['"])/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
