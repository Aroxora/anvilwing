/**
 * analyzeBashFlow surfaces workflow gaps in bash commands the agent is about to
 * run (redundant git status, incomplete npm publish flow). It was untested;
 * this locks the two heuristics and the "clean command → no noise" contract.
 */

import { analyzeBashFlow } from '../src/core/bashCommandGuidance.js';

const codes = (cmd: string) => analyzeBashFlow(cmd).map((w) => w.code);

describe('analyzeBashFlow', () => {
  it('returns nothing for empty / whitespace input', () => {
    expect(analyzeBashFlow('')).toEqual([]);
    expect(analyzeBashFlow('   ')).toEqual([]);
  });

  it('stays silent on ordinary commands', () => {
    expect(analyzeBashFlow('ls -la')).toEqual([]);
    expect(analyzeBashFlow('git status')).toEqual([]); // a single status is fine
    expect(analyzeBashFlow('npm run build && npm test')).toEqual([]);
  });

  it('flags multiple git status calls in one chain', () => {
    const warnings = analyzeBashFlow('git status && git add -A && git status');
    expect(codes('git status && git status')).toContain('GIT_REDUNDANT_STATUS');
    expect(warnings[0].severity).toBe('info');
    expect(warnings[0].suggestion).toMatch(/git add/);
  });

  it('warns when npm publish lacks a complete release flow', () => {
    expect(codes('npm publish')).toContain('NPM_INCOMPLETE_WORKFLOW');
    expect(codes('npm version patch && npm publish')).toContain('NPM_INCOMPLETE_WORKFLOW'); // missing build/test + push
    const w = analyzeBashFlow('npm publish');
    expect(w[0].severity).toBe('warning');
  });

  it('does NOT warn when npm publish has version + build/test + git push', () => {
    expect(
      codes('npm version patch && npm run build && npm test && git push && npm publish')
    ).not.toContain('NPM_INCOMPLETE_WORKFLOW');
    // yarn/pnpm equivalents satisfy the same heuristic
    expect(
      codes('yarn version --patch && yarn build && git push && npm publish')
    ).not.toContain('NPM_INCOMPLETE_WORKFLOW');
  });

  it('is case-insensitive', () => {
    expect(codes('NPM PUBLISH')).toContain('NPM_INCOMPLETE_WORKFLOW');
  });

  describe('python -c misuse (the dod-report transcript failure)', () => {
    // The exact command from the v1.5.0 transcript: a for-loop after `;` plus
    // nested " inside the double-quoted -c — a guaranteed SyntaxError + broken
    // shell quoting.
    const BROKEN = `python3 -c "import json; d=json.load(open('web/public/data/cad_models.json')); print(f'Models: {len(d["models"])}'); for m in d['models']: print(f'  {m["id"]}:')"`;

    it('flags a compound statement after a semicolon in python -c', () => {
      expect(codes(BROKEN)).toContain('PYTHON_INLINE_MULTISTATEMENT');
      expect(codes(`python3 -c "import os; for f in os.listdir('.'): print(f)"`))
        .toContain('PYTHON_INLINE_MULTISTATEMENT');
      const w = analyzeBashFlow(BROKEN).find((x) => x.code === 'PYTHON_INLINE_MULTISTATEMENT');
      expect(w?.severity).toBe('warning');
      expect(w?.suggestion).toMatch(/heredoc|temp .py|<<'PY'/);
    });

    it('flags nested double-quotes inside a double-quoted -c body', () => {
      expect(codes(`python3 -c "print(d["k"])"`)).toContain('PYTHON_INLINE_MULTISTATEMENT');
    });

    it('does NOT flag a valid single compound statement in python -c', () => {
      // One compound statement is legal in -c; only a compound AFTER `;` fails.
      expect(codes(`python3 -c "for i in range(3): print(i)"`)).not.toContain('PYTHON_INLINE_MULTISTATEMENT');
      expect(codes(`python -c "if True: print(1)"`)).not.toContain('PYTHON_INLINE_MULTISTATEMENT');
    });

    it('does NOT flag ordinary single-statement python -c', () => {
      expect(codes(`python3 -c "import sys; print(sys.version)"`)).not.toContain('PYTHON_INLINE_MULTISTATEMENT');
      expect(codes(`python3 -c 'print("hi")'`)).not.toContain('PYTHON_INLINE_MULTISTATEMENT');
    });
  });
});
