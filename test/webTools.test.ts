describe('test/webTools.test.ts', () => {
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebTools } from '../src/tools/webTools.js';

it('WebSearch returns formatted Brave results', async () => {
  const originalFetch = globalThis.fetch;
  process.env[BRAVE_SEARCH_API_KEY] = 'test-key';

  const mockResponse = {
    ok: true,
    status: 200,
    async json() {
      return {
        web: {
          results: [
            {
              title: 'Example Docs',
              url: 'https://example.com/docs',
              description: 'Example documentation summary.',
              profile: { name: 'example.com' },
              publishedDate: '2025-01-01',
            },
          ],
        },
      };
    },
  } as unknown as Response;

  const mockFetch: typeof fetch = async () => mockResponse;
  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mockFetch;

  try {
    const tools = createWebTools();
    const searchTool = tools.find((tool) => tool.name === 'WebSearch');
    assert.ok(searchTool, 'WebSearch tool should be registered');
    const output = await searchTool!.handler({ query: 'example docs' });
    assert.match(output, /Example Docs/);
    assert.match(output, /https:\/\/example.com\/docs/);
    assert.match(output, /provider: Brave Search/i);
  } finally {
    delete process.env[BRAVE_SEARCH_API_KEY];
    globalThis.fetch = originalFetch;
  }
});

it('WebSearch warns when no provider configured', async () => {
  const tools = createWebTools();
  const searchTool = tools.find((tool) => tool.name === 'WebSearch');
  assert.ok(searchTool);
  const output = await searchTool!.handler({ query: 'missing key test' });
  assert.match(output, /requires either BRAVE_SEARCH_API_KEY or SERPAPI_API_KEY/i);
});

});