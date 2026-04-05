import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SessionManager } from '../../sessions/manager.ts';
import {
  checkRecoveryFile,
  deleteRecoveryFile,
  getLastSessionPointerPath,
  getRecoveryFilePath,
  loadLastConversation,
  loadRecoveryConversation,
  persistConversation,
  readLastSessionPointer,
  writeRecoveryFile,
} from '../../runtime/session-persistence.ts';

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('runtime/session-persistence', () => {
  let cwdDir: string;
  let homeDir: string;
  let sessionManager: SessionManager;

  beforeEach(() => {
    cwdDir = makeTmpDir('gv-session-persist-cwd');
    homeDir = makeTmpDir('gv-session-persist-home');
    sessionManager = new SessionManager(cwdDir);
  });

  afterEach(() => {
    if (existsSync(cwdDir)) rmSync(cwdDir, { recursive: true, force: true });
    if (existsSync(homeDir)) rmSync(homeDir, { recursive: true, force: true });
  });

  test('persistConversation saves the session and updates last-session pointer', () => {
    persistConversation(
      'user-test',
      {
        messages: [{ role: 'user', content: 'hello' }],
        timestamp: 1_700_000_000_000,
      },
      'gpt-test',
      'openai',
      'Hello',
      { cwd: cwdDir, sessionManager },
    );

    expect(readLastSessionPointer({ cwd: cwdDir })).toBe('user-test');
    const pointer = JSON.parse(readFileSync(getLastSessionPointerPath(cwdDir), 'utf-8')) as { sessionId: string };
    expect(pointer.sessionId).toBe('user-test');

    const { meta, messages } = sessionManager.load('user-test');
    expect(meta.title).toBe('Hello');
    expect(meta.model).toBe('gpt-test');
    expect(meta.provider).toBe('openai');
    expect(meta.timestamp).toBe(1_700_000_000_000);
    expect(messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  test('loadLastConversation returns null when no last-session pointer exists', () => {
    const loaded = loadLastConversation({ cwd: cwdDir, homeDir, sessionManager });
    expect(loaded).toBeNull();
    expect(readLastSessionPointer({ cwd: cwdDir })).toBeNull();
    expect(sessionManager.list()).toHaveLength(0);
  });

  test('recovery helpers round-trip metadata and messages', () => {
    writeRecoveryFile(
      {
        messages: [
          { role: 'user', content: 'recover me' },
          { role: 'assistant', content: 'restored' },
        ],
      },
      'user-recovery',
      'Recovered Session',
      { homeDir },
    );

    const info = checkRecoveryFile({ cwd: cwdDir, homeDir });
    expect(info).not.toBeNull();
    expect(info?.sessionId).toBe('user-recovery');
    expect(info?.title).toBe('Recovered Session');

    const loaded = loadRecoveryConversation({ homeDir });
    expect(loaded).toEqual({
      messages: [
        { role: 'user', content: 'recover me' },
        { role: 'assistant', content: 'restored' },
      ],
    });

    deleteRecoveryFile({ homeDir });
    expect(existsSync(getRecoveryFilePath(homeDir))).toBe(false);
  });
});
