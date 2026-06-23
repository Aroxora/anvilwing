const { TextEncoder, TextDecoder } = require('util');
const os = require('os');
const path = require('path');
const fs = require('fs');

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// Isolate the OS secret store to a throwaway dir for the whole test run.
// src/core/secretStore.ts resolves its directory from ANVILWING_HOME; without
// this, a test that did `setSecretValue('TAVILY_API_KEY', 'tvly-test')` wrote
// to the developer's REAL ~/.anvilwing/secrets.json and clobbered their live
// keys on every `npm test`. Setting ANVILWING_HOME here (before secretStore is
// imported) sends all secret-store writes to a temp dir instead.
if (!process.env.ANVILWING_HOME) {
  const dir = path.join(os.tmpdir(), `anvilwing-jest-${process.pid}`);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  process.env.ANVILWING_HOME = dir;
}

// Disable "Read Before Edit" enforcement during tests
// (matches the env var name read in src/tools/fileReadTracker.ts)
process.env.ANVILWING_ENFORCE_READ_BEFORE_EDIT = 'false';

// Tests run with a placeholder key so code paths that read the env var
// don't crash on undefined. Tests must NOT make real keyed provider calls
// (use stubs); a real key never belongs in source.
process.env.ANVILWING_API_KEY = process.env.ANVILWING_API_KEY || 'sk-test-placeholder-0000000000000000';

const originalConsole = { ...console };

beforeAll(() => {
  console.log = jest.fn();
  console.error = jest.fn();
  console.warn = jest.fn();
  console.info = jest.fn();
});

afterAll(() => {
  Object.assign(console, originalConsole);
});
