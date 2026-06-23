/**
 * WebFetch promises the page's content (e.g. "fetching a JSON API"), but it used
 * to run stripHtml unconditionally — and stripHtml's prose whitelist deletes any
 * line with braces / semicolons / long content, wiping a JSON body or code file
 * entirely. Non-HTML responses must come back verbatim; HTML is still
 * prose-extracted.
 *
 * Drives the REAL WebFetch tool against a REAL local HTTP server.
 */
import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import { createServer, type Server } from 'node:http';
import { createWebTools } from '../../src/tools/webTools.js';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/api.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"key":"value","items":[1,2,3],"nested":{"ok":true}}');
    } else if (req.url === '/code.ts') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('export const xs: Array<string> = [];\nfunction f() { return a < b && c > d; }');
    } else if (req.url === '/page.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><p>Hello readable prose content that is long enough to pass.</p><script>var z=1;</script></body></html>');
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function webFetch() {
  const tool = createWebTools().find((t) => t.name === 'WebFetch');
  if (!tool) throw new Error('WebFetch not registered');
  return tool.handler as (a: Record<string, unknown>) => Promise<string>;
}

describe('WebFetch — non-HTML content is returned verbatim', () => {
  test('a JSON API body is returned intact (braces/structure preserved)', async () => {
    const out = await webFetch()({ url: `${base}/api.json` });
    expect(out).toContain('{"key":"value"');
    expect(out).toContain('"nested":{"ok":true}');
  });

  test('a code/text body keeps angle brackets and braces (not wiped)', async () => {
    const out = await webFetch()({ url: `${base}/code.ts` });
    expect(out).toContain('Array<string>');
    expect(out).toContain('a < b && c > d');
    expect(out).toContain('function f()');
  });

  test('an HTML page is still prose-extracted (script stripped)', async () => {
    const out = await webFetch()({ url: `${base}/page.html` });
    expect(out).toContain('Hello readable prose content');
    expect(out).not.toContain('var z=1');
  });
});
