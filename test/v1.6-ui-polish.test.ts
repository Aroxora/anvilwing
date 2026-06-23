/**
 * UI/UX polish net — 2026-06-12 PTY audit findings (each verified on the real
 * binary's rendered screen before fixing). Source assertions pin the fixes;
 * the render-level proof for the live surfaces is the PTY e2e suite.
 *
 *  - Ctrl+D typed a literal `d` into the input box (the shortcuts panel
 *    advertised "Ctrl+D Exit (when empty)" — false until now).
 *  - Parallel tools: start/start/complete/complete glued tool B's result
 *    under tool A's header (§3 pairing).
 *  - `!cmd` output rendered as one bold block with no ⎿ result (§2/§3).
 *  - Shortcuts panel columns drifted 1-2 cols per row (hand-counted spaces).
 *  - Inline panels auto-vanished after 8s mid-read.
 *  - Streaming text/spinner hugged the transcript then jumped a row at
 *    commit (§1).
 */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';

const REPO = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(REPO, ...p), 'utf8');

const PROMPT = read('src', 'ui', 'ink', 'Prompt.tsx');
const CONTROLLER = read('src', 'ui', 'ink', 'InkPromptController.ts');
const APP = read('src', 'ui', 'ink', 'App.tsx');
const SHELL = read('src', 'headless', 'interactiveShell.ts');

describe('Ctrl+D exits on empty buffer (PTY: literal `d` appeared in the box)', () => {
  test('Prompt handles key.ctrl+d before the insert walk', () => {
    expect(PROMPT).toMatch(/key\.ctrl && \(input === 'd' \|\| input === 'D'\)/);
    expect(PROMPT).toMatch(/stateRef\.current\.text\.length === 0\) \{ onExit\?\.\(\); return; \}/);
  });

  test('raw 0x04 EOF byte in a chunk takes the same path', () => {
    expect(PROMPT).toMatch(/code === 0x04/);
  });

  test('the controller forwards onExit to the host (which maps it to handleExit)', () => {
    expect(CONTROLLER).toMatch(/onExit: \(\) => this\.callbacks\.onExit\?\.\(\)/);
    expect(SHELL).toMatch(/onExit: \(\) => this\.handleExit\(\)/);
  });

  test('with text in the buffer Ctrl+D forward-deletes (readline)', () => {
    expect(PROMPT).toMatch(/key\.ctrl && \(input === 'd' \|\| input === 'D'\)[\s\S]{0,200}apply\(\{ type: 'delete' \}\)/);
  });
});

describe('parallel tool results pair with THEIR call header (§3)', () => {
  test('tool.complete re-emits its own header when another rendered since', () => {
    expect(SHELL).toMatch(/lastToolHeaderEmitted/);
    expect(SHELL).toMatch(/const ownHeader = formatToolCall\(event\.toolName, params, this\.workingDir\);/);
    expect(SHELL).toMatch(/if \(lastToolHeaderEmitted !== ownHeader\) \{\s*\n\s*renderer\.addEvent\('tool', ownHeader\);/);
  });

  test('prose and errors clear the tracker so a later result re-pairs', () => {
    const clears = SHELL.match(/lastToolHeaderEmitted = null;/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(3);
  });
});

describe('!cmd renders header + ⎿ result as separate blocks (§2/§3)', () => {
  test('success path emits tool + tool-result events', () => {
    expect(SHELL).toMatch(/addEvent\('tool', `\$ \$\{command\}`\);\s*\n\s*renderer\?\.addEvent\('tool-result', formatToolResult\('bash', output/);
  });

  test('failure path emits the header then a formatted ⎿ Error line', () => {
    expect(SHELL).toMatch(/addEvent\('error', formatToolError\(output \|\| 'command failed'\)\)/);
    expect(SHELL).not.toMatch(/addEvent\('tool', `\$ \$\{command\}\\n\$\{output\}`\)/);
  });
});

describe('shortcuts panel is grid-aligned', () => {
  test('rows pad the plain key text before colouring', () => {
    expect(SHELL).toMatch(/const row = \(keys: string, text: string\) => `  \$\{kb\(keys\.padEnd\(14\)\)\}\$\{desc\(text\)\}`/);
  });
});

describe('live region keeps the §1 gap (no row-jump at commit)', () => {
  test('streaming block and status line carry marginTop when history exists', () => {
    const margins = APP.match(/marginTop=\{history && history\.length > 0 \? 1 : 0\}/g) ?? [];
    expect(margins.length).toBe(2);
  });
});

describe('welcome box (§7)', () => {
  test('composeWelcomeLines has no built-in trailing blank (double-gap fix)', () => {
    expect(SHELL).toMatch(/return \['', \.\.\.\(input\.updateLines \?\? \[\]\), \.\.\.roundedBox\(welcomeBodyLines\(input\)\)\];/);
  });
});
