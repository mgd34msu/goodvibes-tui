import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
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
} from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeTmpDir(prefix: string): string {
  return makeProjectTempDir(prefix);
}

describe('runtime/session-persistence', () => {
  let cwdDir: string;
  let homeDir: string;
  let sessionManager: SessionManager;

  beforeEach(() => {
    cwdDir = makeTmpDir('gv-session-persist-cwd');
    homeDir = makeTmpDir('gv-session-persist-home');
    sessionManager = new SessionManager(cwdDir, { surfaceRoot: 'tui' });
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
        titleSource: 'user',
        returnContext: {
          activityLabel: 'user prompt queued',
          statusLabel: 'awaiting response',
          pendingApprovals: 0,
          toolCallCount: 0,
          toolResultCount: 0,
          assistantTurnCount: 0,
          userTurnCount: 1,
          activeTasks: 2,
          blockedTasks: 1,
          remoteContracts: 1,
          worktreeCount: 3,
          openPanels: ['remote', 'approval'],
          lines: ['Activity: user prompt queued', 'Status: awaiting response'],
        },
      },
      'gpt-test',
      'openai',
      'Hello',
      { workingDirectory: cwdDir, homeDirectory: homeDir, sessionManager, surfaceRoot: 'tui' },
    );

    expect(readLastSessionPointer({ workingDirectory: cwdDir, homeDirectory: homeDir, surfaceRoot: 'tui' })).toBe('user-test');
    const pointer = JSON.parse(readFileSync(getLastSessionPointerPath(cwdDir, 'tui'), 'utf-8')) as { sessionId: string };
    expect(pointer.sessionId).toBe('user-test');

    const { meta, messages } = sessionManager.load('user-test');
    expect(meta.title).toBe('Hello');
    expect(meta.model).toBe('gpt-test');
    expect(meta.provider).toBe('openai');
    expect(meta.timestamp).toBe(1_700_000_000_000);
    expect(meta.titleSource).toBe('user');
    expect(meta.returnContext?.statusLabel).toBe('awaiting response');
    expect(meta.returnContext?.worktreeCount).toBe(3);
    expect(meta.returnContext?.openPanels).toEqual(['remote', 'approval']);
    expect(messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  test('loadLastConversation returns null when no last-session pointer exists', () => {
    const loaded = loadLastConversation({ workingDirectory: cwdDir, homeDirectory: homeDir, sessionManager, surfaceRoot: 'tui' });
    expect(loaded).toBeNull();
    expect(readLastSessionPointer({ workingDirectory: cwdDir, homeDirectory: homeDir, surfaceRoot: 'tui' })).toBeNull();
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
      { workingDirectory: cwdDir, homeDirectory: homeDir, surfaceRoot: 'tui' },
    );

    const info = checkRecoveryFile({ workingDirectory: cwdDir, homeDirectory: homeDir, surfaceRoot: 'tui' });
    expect(info).not.toBeNull();
    expect(info?.sessionId).toBe('user-recovery');
    expect(info?.title).toBe('Recovered Session');
    expect(info?.returnContext).toBeUndefined();

    const loaded = loadRecoveryConversation({ homeDirectory: homeDir, surfaceRoot: 'tui' });
    expect(loaded).toEqual({
      title: 'Recovered Session',
      titleSource: undefined,
      returnContext: undefined,
      messages: [
        { role: 'user', content: 'recover me' },
        { role: 'assistant', content: 'restored' },
      ],
    });

    deleteRecoveryFile({ homeDirectory: homeDir, surfaceRoot: 'tui' });
    expect(existsSync(getRecoveryFilePath(homeDir, 'tui'))).toBe(false);
  });

  test('recovery helpers preserve return context metadata when provided', () => {
    writeRecoveryFile(
      {
        titleSource: 'system',
        returnContext: {
          activityLabel: 'assistant replied',
          statusLabel: 'ready for next turn',
          pendingApprovals: 0,
          toolCallCount: 1,
          toolResultCount: 1,
          assistantTurnCount: 1,
          userTurnCount: 1,
          activeTasks: 2,
          blockedTasks: 1,
          remoteContracts: 1,
          worktreeCount: 2,
          openPanels: ['remote', 'approval'],
          lines: ['Activity: assistant replied', 'Status: ready for next turn'],
        },
        messages: [
          { role: 'user', content: 'recover me' },
          { role: 'assistant', content: 'restored' },
        ],
      },
      'user-recovery',
      'Recovered Session',
      { workingDirectory: cwdDir, homeDirectory: homeDir, surfaceRoot: 'tui' },
    );

    const info = checkRecoveryFile({ workingDirectory: cwdDir, homeDirectory: homeDir, surfaceRoot: 'tui' });
    expect(info?.returnContext?.activityLabel).toBe('assistant replied');

    const loaded = loadRecoveryConversation({ homeDirectory: homeDir, surfaceRoot: 'tui' });
    expect(loaded?.titleSource).toBe('system');
    expect(loaded?.returnContext?.statusLabel).toBe('ready for next turn');
    expect(loaded?.returnContext?.remoteContracts).toBe(1);
    expect(loaded?.returnContext?.openPanels).toEqual(['remote', 'approval']);
  });
});
