import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ConversationMessage } from '../src/core/types.js';

describe('sessionStore', () => {
  let tempDir: string;
  let saveSessionSnapshot: typeof import('../src/core/sessionStore.js').saveSessionSnapshot;
  let listSessions: typeof import('../src/core/sessionStore.js').listSessions;
  let loadSessionById: typeof import('../src/core/sessionStore.js').loadSessionById;
  let deleteSession: typeof import('../src/core/sessionStore.js').deleteSession;
  let saveAutosaveSnapshot: typeof import('../src/core/sessionStore.js').saveAutosaveSnapshot;
  let loadAutosaveSnapshot: typeof import('../src/core/sessionStore.js').loadAutosaveSnapshot;
  let clearAutosaveSnapshot: typeof import('../src/core/sessionStore.js').clearAutosaveSnapshot;

  const baseMessages: ConversationMessage[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'Initial request' },
    { role: 'assistant', content: 'Response' },
  ];

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'anvilwing-session-store-'));
    process.env['ANVILWING_DATA_DIR'] = tempDir;
    jest.resetModules();

    ({
      saveSessionSnapshot,
      listSessions,
      loadSessionById,
      deleteSession,
      saveAutosaveSnapshot,
      loadAutosaveSnapshot,
      clearAutosaveSnapshot,
    } = await import('../src/core/sessionStore.js'));
  });

  afterEach(() => {
    delete process.env['ANVILWING_DATA_DIR'];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('saves, lists, and loads sessions', () => {
    const summary = saveSessionSnapshot({
      profile: 'general',
      provider: 'anvilwing',
      model: 'anvilwing',
      workspaceRoot: '/tmp/project',
      messages: baseMessages,
      title: 'My session',
    });

    expect(summary.id).toBeTruthy();

    const sessions = listSessions('general');
    expect(sessions).toHaveLength(1);

    const first = sessions[0];
    expect(first?.title).toBe('My session');

    const loaded = loadSessionById(summary.id);
    expect(loaded?.messages.length).toBe(baseMessages.length);
    expect(loaded?.workspaceRoot).toBe('/tmp/project');

    expect(deleteSession(summary.id)).toBe(true);
    expect(listSessions('general')).toHaveLength(0);
  });

  it('autosave helpers round trip', () => {
    saveAutosaveSnapshot('general', {
      provider: 'anvilwing',
      model: 'anvilwing',
      workspaceRoot: '/tmp/project',
      messages: baseMessages,
      title: 'Autosave session',
    });

    const autosaved = loadAutosaveSnapshot('general');
    expect(autosaved?.title).toBe('Autosave session');
    expect(autosaved?.messages[1]?.role).toBe('user');

    clearAutosaveSnapshot('general');
    const cleared = loadAutosaveSnapshot('general');
    expect(cleared).toBeNull();
  });
});
