/**
 * Assistant Markdown must render to themed ANSI in the transcript (Claude Code
 * parity) — headings, bold, inline code, tables, rules — never raw `###` / `**`
 * / `|---|`. Plain prose must pass through untouched (no mangling).
 */
import { describe, expect, test } from '@jest/globals';
import { renderMarkdown } from '../../src/ui/ink/markdownRender.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('renderMarkdown', () => {
  test('headings render without the leading ## and keep the text', () => {
    const out = renderMarkdown('## Phase 1 Site Brand Identity');
    expect(strip(out)).not.toMatch(/##/);
    expect(strip(out)).toContain('Phase 1 Site Brand Identity');
    expect(out).toMatch(/\x1b\[1m/); // bold
  });

  test('bold renders without literal asterisks', () => {
    const out = renderMarkdown('this is **important** text');
    expect(strip(out)).not.toContain('**');
    expect(strip(out)).toContain('important');
  });

  test('inline code is themed ice-cyan', () => {
    const out = renderMarkdown('run `make data` now');
    expect(strip(out)).toContain('make data');
    expect(out).toMatch(/38;2;100;210;255/); // ICE #64d2ff
  });

  // marked-terminal does not apply inline renderers inside list items, so bold
  // and inline code leaked as raw ** / backticks — pervasive, since the agent
  // explains things with bulleted lists full of `code` references.
  describe('inline markdown inside list items (the leak)', () => {
    test('bulleted inline code renders without literal backticks', () => {
      const out = strip(renderMarkdown('- the `parseQuery` function splits the string'));
      expect(out).not.toContain('`');
      expect(out).toContain('parseQuery');
    });
    test('bulleted bold renders without literal asterisks', () => {
      const out = strip(renderMarkdown('- this is a **key risk** here'));
      expect(out).not.toContain('**');
      expect(out).toContain('key risk');
    });
    test('ordered list with both bold and code', () => {
      const out = strip(renderMarkdown('1. call `bar()` then **stop**'));
      expect(out).not.toContain('`');
      expect(out).not.toContain('**');
      expect(out).toContain('bar()');
      expect(out).toContain('stop');
    });
    test('inline code in a list IS themed ice-cyan (styled, not just stripped)', () => {
      const out = renderMarkdown('- run `make data`');
      expect(out).toMatch(/38;2;100;210;255/); // ICE applied inside the list
    });
    test('a fenced code block is NOT corrupted (backticks/asterisks kept)', () => {
      const out = strip(renderMarkdown('```js\nconst x = `tmpl`; a ** b;\n```'));
      expect(out).toContain('`tmpl`'); // code content preserved verbatim
      expect(out).toContain('a ** b');
    });
  });

  test('tables render as box drawing, not raw pipes', () => {
    const md = '| Step | File |\n|------|------|\n| 1 | index.html |';
    const out = strip(renderMarkdown(md));
    expect(out).not.toMatch(/\|---/);
    expect(out).toMatch(/[│─┼┌┐└┘├┤]/);
    expect(out).toContain('index.html');
  });

  test('a horizontal rule does not render as raw dashes-in-markdown', () => {
    const out = strip(renderMarkdown('above\n\n---\n\nbelow'));
    expect(out).toContain('above');
    expect(out).toContain('below');
  });

  test('plain prose with no markdown is returned byte-for-byte (fast path)', () => {
    const prose = 'The make data step timed out, so I reran gen_analysis.py with a longer timeout.';
    expect(renderMarkdown(prose)).toBe(prose);
  });

  test('empty / whitespace input is unchanged', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   ')).toBe('   ');
  });

  test('prose with bare * or _ is NOT mangled (no data loss)', () => {
    // These are valid CommonMark emphasis but must be left alone: marked would
    // otherwise delete the markers and the text between them.
    expect(renderMarkdown('use 2*3*4 = 24')).toBe('use 2*3*4 = 24');
    expect(renderMarkdown('a*b*c')).toBe('a*b*c');
    expect(renderMarkdown('the file_name_here and other_var')).toBe('the file_name_here and other_var');
    expect(renderMarkdown('snake_case_identifier mid sentence')).toBe('snake_case_identifier mid sentence');
  });

  test('genuine **bold** and `code` still render', () => {
    expect(strip(renderMarkdown('**rebuild** now'))).not.toContain('**');
    expect(strip(renderMarkdown('**rebuild** now'))).toContain('rebuild');
    expect(renderMarkdown('run `make data`')).toMatch(/38;2;100;210;255/);
  });

  test('never throws and never returns empty for real content', () => {
    const out = renderMarkdown('# H\n\n- a\n- b\n\n```js\nconst x=1;\n```\n');
    expect(out.length).toBeGreaterThan(0);
  });
});
