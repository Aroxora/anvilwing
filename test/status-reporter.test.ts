/**
 * Status reporter tests — the renderer's `addEvent('error', ...)`
 * path routes through reportStatus, so bugs here surface as missing
 * or doubled error messages in the status bar.
 */

import {
  reportStatus,
  reportStatusError,
  setStatusSink,
} from '../src/utils/statusReporter.js';

describe('statusReporter', () => {
  let captured: string[] = [];

  beforeEach(() => {
    captured = [];
    setStatusSink((msg) => captured.push(msg));
  });

  afterEach(() => {
    setStatusSink(null);
  });

  it('routes a basic message to the sink', () => {
    reportStatus('Hello world');
    expect(captured).toEqual(['Hello world']);
  });

  it('normalizes whitespace (collapses runs, trims edges)', () => {
    reportStatus('  multiple   spaces\nand newlines  ');
    expect(captured).toEqual(['multiple spaces and newlines']);
  });

  it('drops empty / whitespace-only messages silently', () => {
    reportStatus('');
    reportStatus('   ');
    reportStatus('\n\t  ');
    expect(captured).toEqual([]);
  });

  it('reportStatusError formats Error instances with prefix', () => {
    reportStatusError(new Error('boom'), 'render');
    expect(captured).toEqual(['render: boom']);
  });

  it('reportStatusError accepts non-Error values', () => {
    reportStatusError('string error', 'fetch');
    expect(captured).toEqual(['fetch: string error']);

    captured = [];
    reportStatusError({ code: 42 } as unknown, 'object');
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain('object:');
  });

  it('reportStatusError with empty prefix omits the colon prefix', () => {
    reportStatusError(new Error('lone'), '');
    expect(captured).toEqual(['lone']);
  });

  it('reportStatusError does not double-colon when prefix already ends with one', () => {
    reportStatusError(new Error('x'), 'tag:');
    expect(captured).toEqual(['tag: x']);
  });

  it('without a sink, falls back silently (no throw)', () => {
    setStatusSink(null);
    expect(() => reportStatus('no sink fallback')).not.toThrow();
  });
});
