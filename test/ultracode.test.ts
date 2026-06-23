/**
 * Ultracode operating mode — now BAKED IN, always on, no toggle. The directive
 * (phased: research → verify load-bearing facts → design → build the whole
 * thing → verify; plus a long-horizon section for big refactors / long
 * sessions) is appended to every resolved system prompt unconditionally.
 *
 * This file asserts the always-on contract so a future refactor that
 * re-introduces a gate or a /ultracode toggle is caught at CI. config.ts
 * can't load under jest (import.meta), so prompt wiring is asserted on source.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_FEATURE_FLAGS, FEATURE_FLAG_INFO } from '../src/core/preferences.js';

const SRC = resolve(__dirname, '..', 'src');
const read = (p: string): string => readFileSync(resolve(SRC, p), 'utf8');

describe('ultracode operating mode (baked in, always on)', () => {
  test('there is no ultracode feature flag any more (it is unconditional)', () => {
    // The flag was removed when ultracode became permanent — keeping a flag
    // would imply it can be turned off, which it can't.
    expect((DEFAULT_FEATURE_FLAGS as Record<string, unknown>)['ultracode']).toBeUndefined();
    expect((FEATURE_FLAG_INFO as Record<string, unknown>)['ultracode']).toBeUndefined();
  });

  test('the directive is appended UNCONDITIONALLY — no flag gate, no ultracodeEnabled()', () => {
    const src = read('config.ts');
    expect(src).toMatch(/ULTRACODE_DIRECTIVE/);
    // The block is built with no ternary gate.
    expect(src).toMatch(/const ultracodeBlock = `\\n\\n\$\{ULTRACODE_DIRECTIVE\}`/);
    expect(src).toMatch(/\$\{ultracodeBlock\}/);
    // The old gate is gone.
    expect(src).not.toMatch(/function ultracodeEnabled/);
    expect(src).not.toMatch(/loadFeatureFlags\(\)\.ultracode/);
    expect(src).not.toMatch(/ultracodeBlock\s*=\s*ultracodeEnabled\(\)\s*\?/);
  });

  test('the directive encodes the phased ethos AND long-horizon discipline', () => {
    const src = read('config.ts');
    const directive = src.slice(src.indexOf('const ULTRACODE_DIRECTIVE'));
    expect(directive).toMatch(/always on/i);
    expect(directive).toMatch(/max thinking budget/i);
    expect(directive).toMatch(/Research/i);
    expect(directive).toMatch(/Verify load-bearing facts/i);
    expect(directive).toMatch(/adversari/i);            // ties to the adversarial verifier
    expect(directive).toMatch(/parallel sub-agents/i);  // breadth via orchestration
    // Long-horizon section.
    expect(directive).toMatch(/Long-horizon/i);
    expect(directive).toMatch(/living TODO plan/i);
    expect(directive).toMatch(/multi-file/i);
    expect(directive).toMatch(/Don't stop early/i);
    expect(directive).toMatch(/trivial/i);              // scope discipline — no spree
  });

  test('the /ultracode slash command was removed (no toggle)', () => {
    const src = read('headless/interactiveShell.ts');
    expect(src).not.toMatch(/'\/ultracode'/);
    expect(src).not.toMatch(/toggleFeatureFlag\('ultracode'/);
  });
});
