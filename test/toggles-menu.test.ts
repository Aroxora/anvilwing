/**
 * Ctrl+T toggles menu — source contract (CI-runnable without a PTY; the
 * real-binary render proof is test/e2e-toggles.test.ts).
 *
 * Keyboard access to the below-box settings (auto-continue · confirm actions /
 * HITL · debug) that previously needed slash commands. The wiring spans four
 * layers; this pins each so a refactor that drops a link fails CI.
 */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';

const REPO = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(REPO, ...p), 'utf8');

const PROMPT = read('src', 'ui', 'ink', 'Prompt.tsx');
const CONTROLLER = read('src', 'ui', 'ink', 'InkPromptController.ts');
const SHELL = read('src', 'headless', 'interactiveShell.ts');

describe('Ctrl+T is bound and flows to the host', () => {
  test('Prompt handles key.ctrl+t → onShowToggles', () => {
    expect(PROMPT).toMatch(/key\.ctrl && \(input === 't' \|\| input === 'T'\)\) \{ onShowToggles\?\.\(\); return; \}/);
    expect(PROMPT).toMatch(/onShowToggles\?: \(\) => void/);
  });

  test('the controller forwards onShowToggles to the host callback', () => {
    expect(CONTROLLER).toMatch(/onShowToggles\?: \(\) => void/);
    expect(CONTROLLER).toMatch(/onShowToggles: \(\) => this\.callbacks\.onShowToggles\?\.\(\)/);
  });

  test('the shell wires onShowToggles → showTogglesMenu', () => {
    expect(SHELL).toMatch(/onShowToggles: \(\) => this\.showTogglesMenu\(\)/);
  });
});

describe('showTogglesMenu builds the three toggles with live state and flips them', () => {
  test('all three toggle rows are present', () => {
    expect(SHELL).toMatch(/id: 'auto', label: `Auto-continue/);
    expect(SHELL).toMatch(/id: 'hitl', label: `Confirm actions/);
    expect(SHELL).toMatch(/id: 'debug', label: `Debug output/);
  });

  test('selection flips the real toggle via the controller / debug path', () => {
    expect(SHELL).toMatch(/case 'auto': controller\.toggleAutoContinue\(\);/);
    expect(SHELL).toMatch(/case 'hitl': controller\.toggleHITL\(\);/);
    expect(SHELL).toMatch(/case 'debug': this\.applyDebugState\(!this\.debugEnabled\);/);
  });

  test('the menu re-opens after a flip so state change is visible', () => {
    expect(SHELL).toMatch(/setTimeout\(\(\) => this\.showTogglesMenu\(\), 0\)/);
  });
});

describe('discoverability', () => {
  test('the shortcuts panel lists Ctrl+T', () => {
    expect(SHELL).toMatch(/row\('Ctrl\+T', 'Toggles menu/);
  });

  test('the /help footer mentions Ctrl+T toggles', () => {
    expect(SHELL).toMatch(/Ctrl\+T toggles/);
  });
});
