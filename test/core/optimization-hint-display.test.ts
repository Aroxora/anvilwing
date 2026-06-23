/**
 * Optimization hints (`<optimization-hint>…⚡ SEARCH/EDIT/…</optimization-hint>`)
 * are agent-directed guidance for the NEXT tool call. They must reach the MODEL
 * (appended to the returned tool result) but must NOT leak into the user-visible
 * transcript — the display observer should receive the hint-FREE output. Before
 * the fix the same string carried the raw <optimization-hint> wrapper into the
 * UI (caught by running a real task: a failed Edit surfaced "</optimization-hint>"
 * in the rendered output).
 *
 * Drives the REAL ToolRuntime: a Grep with a broad pattern trips
 * SEARCH_BROAD_PATTERN, so a hint is generated.
 */

import { describe, expect, test } from '@jest/globals';
import { ToolRuntime } from '../../src/core/toolRuntime.js';
import type { ToolDefinition } from '../../src/core/toolRuntime.js';

const grepTool: ToolDefinition = {
  name: 'Grep',
  description: 'test grep',
  parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  handler: async () => 'GREP_REAL_OUTPUT_LINE',
};

describe('optimization hints reach the model but not the display', () => {
  test('broad-pattern Grep: model gets the hint, observer gets hint-free output', async () => {
    let displayOutput = '';
    const rt = new ToolRuntime([grepTool], {
      enableCache: false,
      observer: { onToolResult: (_call, output) => { displayOutput = output; } },
    });

    const modelOutput: string = await rt.execute({ id: 'c1', name: 'Grep', arguments: { pattern: '**' } } as any);

    // MODEL: keeps the agent-directed hint
    expect(modelOutput).toContain('<optimization-hint>');
    expect(modelOutput).toMatch(/⚡ SEARCH:/);
    expect(modelOutput).toContain('GREP_REAL_OUTPUT_LINE');

    // DISPLAY: real output, but NO raw hint wrapper
    expect(displayOutput).toContain('GREP_REAL_OUTPUT_LINE');
    expect(displayOutput).not.toContain('<optimization-hint>');
    expect(displayOutput).not.toContain('</optimization-hint>');
    expect(displayOutput).not.toMatch(/⚡ SEARCH:/);
  });

  test('a normal (non-broad) Grep emits no hint to either side', async () => {
    let displayOutput = '';
    const rt = new ToolRuntime([grepTool], {
      enableCache: false,
      observer: { onToolResult: (_call, output) => { displayOutput = output; } },
    });
    const modelOutput: string = await rt.execute({ id: 'c2', name: 'Grep', arguments: { pattern: 'specificFunctionName' } } as any);
    expect(modelOutput).not.toContain('<optimization-hint>');
    expect(displayOutput).not.toContain('<optimization-hint>');
    expect(modelOutput).toContain('GREP_REAL_OUTPUT_LINE');
  });

  test('source guard: display observer gets hint-free output, model return gets hints', () => {
    const { readFileSync } = require('node:fs');
    const { resolve } = require('node:path');
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'core', 'toolRuntime.ts'), 'utf8');
    expect(src).toMatch(/const modelOutput = optimizationHints\.length > 0/);
    expect(src).toMatch(/onToolResult\?\.\(augmentedCall, output\)/); // hint-free output to display
    expect(src).toMatch(/return modelOutput/);
  });
});
