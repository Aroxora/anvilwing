import { createInMemorySessionStorage, setSessionStorage, getSessionStorage } from '../../src/core/sessionStorage.js';

describe('sessionStorage abstraction', () => {
  afterEach(() => {
    // reset to default storage to avoid leaking in-memory storage across suites
    setSessionStorage(getSessionStorage());
  });

  it('supports in-memory storage for tests', () => {
    const storage = createInMemorySessionStorage();
    setSessionStorage(storage);

    storage.ensureDir('/mem/sessions');
    storage.writeFile('/mem/sessions/test.json', '{"hello":"world"}');

    expect(storage.readFile('/mem/sessions/test.json')).toBe('{"hello":"world"}');
    expect(storage.exists('/mem/sessions/test.json')).toBe(true);
  });
});
