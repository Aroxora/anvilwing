import { ToolRuntime } from '../../src/core/toolRuntime.js';
import type { ToolExecutionIO } from '../../src/core/toolRuntimeTypes.js';

const inMemoryIO = (): ToolExecutionIO => {
  const files = new Map<string, string>();
  return {
    root: '/mem',
    ensureDir: () => {},
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, content) => {
      files.set(path, content);
    },
    deleteFile: (path) => {
      files.delete(path);
    },
    listFiles: () => Array.from(files.keys()),
    exists: (path) => files.has(path),
  };
};

describe('ToolRuntime IO injection', () => {
  it('uses injected IO for side-effecting handlers', async () => {
    const io = inMemoryIO();
    const runtime = new ToolRuntime(
      [
        {
          name: 'write_mem',
          description: 'write content',
          handler: (args: { path: string; content: string }) => {
            io.writeFile(args.path, args.content);
            return 'ok';
          },
        },
      ],
      {},
      io
    );

    await runtime.execute({ name: 'write_mem', arguments: { path: '/mem/test.txt', content: 'hello' } });
    expect(io.readFile('/mem/test.txt')).toBe('hello');
  });
});
