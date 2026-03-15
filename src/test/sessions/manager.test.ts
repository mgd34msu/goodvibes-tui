import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionManager } from '../../sessions/manager.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const META = {
  title: 'Test Session',
  model: 'test-model',
  provider: 'test-provider',
  timestamp: 1700000000000,
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SessionManager', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    sm = new SessionManager(tmpDir);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // sanitizeName
  // -------------------------------------------------------------------------

  describe('sanitizeName', () => {
    test('lowercase and preserves alphanumeric', () => {
      expect(sm.sanitizeName('MySession123')).toBe('mysession123');
    });

    test('replaces spaces with hyphens', () => {
      expect(sm.sanitizeName('my session name')).toBe('my-session-name');
    });

    test('strips special characters', () => {
      expect(sm.sanitizeName('hello!@#world')).toBe('helloworld');
    });

    test('strips path traversal characters', () => {
      expect(sm.sanitizeName('../../../etc/passwd')).toBe('etcpasswd');
    });

    test('collapses multiple hyphens', () => {
      expect(sm.sanitizeName('hello---world')).toBe('hello-world');
    });

    test('trims leading and trailing hyphens', () => {
      expect(sm.sanitizeName('--hello--')).toBe('hello');
    });

    test('returns fallback for empty-after-sanitize name', () => {
      expect(sm.sanitizeName('!!!###')).toBe('session');
    });

    test('preserves underscores', () => {
      expect(sm.sanitizeName('my_session')).toBe('my_session');
    });
  });

  // -------------------------------------------------------------------------
  // save / load round-trip
  // -------------------------------------------------------------------------

  describe('save and load', () => {
    test('round-trip: messages and meta preserved', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ];

      sm.save('test-session', messages, META);
      const { meta, messages: loaded } = sm.load('test-session');

      expect(meta.title).toBe(META.title);
      expect(meta.model).toBe(META.model);
      expect(meta.provider).toBe(META.provider);
      expect(meta.timestamp).toBe(META.timestamp);
      expect(loaded).toHaveLength(2);
      expect((loaded[0] as { role: string; content: string }).role).toBe('user');
      expect((loaded[0] as { role: string; content: string }).content).toBe('Hello');
      expect((loaded[1] as { role: string; content: string }).role).toBe('assistant');
    });

    test('save strips type field from incoming messages', () => {
      // If a message already has a type field, it must not override the 'message' wrapper
      const messages = [
        { role: 'user', content: 'Hello', type: 'custom-type' },
      ];

      sm.save('strip-type', messages, META);
      const { messages: loaded } = sm.load('strip-type');

      expect(loaded).toHaveLength(1);
      // type field should be stripped (not returned in messages)
      expect((loaded[0] as Record<string, unknown>).type).toBeUndefined();
      expect((loaded[0] as Record<string, unknown>).role).toBe('user');
    });

    test('save returns sanitized name and file path', () => {
      const result = sm.save('My Session Name!', [], META);
      expect(result.sanitizedName).toBe('my-session-name');
      expect(result.filePath).toContain('my-session-name.jsonl');
    });

    test('load skips messages with removed: true', () => {
      const messages = [
        { role: 'user', content: 'Keep me' },
        { role: 'assistant', content: 'Remove me', removed: true },
        { role: 'user', content: 'Also keep me' },
      ];

      sm.save('removed-test', messages, META);
      const { messages: loaded } = sm.load('removed-test');

      // The removed message is excluded
      expect(loaded).toHaveLength(2);
      expect((loaded[0] as { content: string }).content).toBe('Keep me');
      expect((loaded[1] as { content: string }).content).toBe('Also keep me');
    });

    test('save with same name overwrites previous', () => {
      sm.save('overwrite-me', [{ role: 'user', content: 'v1' }], META);
      sm.save('overwrite-me', [{ role: 'user', content: 'v2' }, { role: 'assistant', content: 'v2-reply' }], META);
      const { messages: loaded } = sm.load('overwrite-me');
      expect(loaded).toHaveLength(2);
      expect((loaded[0] as { content: string }).content).toBe('v2');
    });
  });

  // -------------------------------------------------------------------------
  // Validation errors
  // -------------------------------------------------------------------------

  describe('empty name validation', () => {
    test('save throws on empty string', () => {
      expect(() => sm.save('', [], META)).toThrow('Session name cannot be empty');
    });

    test('save throws on whitespace-only string', () => {
      expect(() => sm.save('   ', [], META)).toThrow('Session name cannot be empty');
    });

    test('load throws on empty string', () => {
      expect(() => sm.load('')).toThrow('Session name cannot be empty');
    });

    test('load throws on whitespace-only string', () => {
      expect(() => sm.load('   ')).toThrow('Session name cannot be empty');
    });

    test('load throws on non-existent session', () => {
      expect(() => sm.load('does-not-exist')).toThrow('Session not found');
    });
  });

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  describe('list', () => {
    test('returns empty array when no sessions directory', () => {
      const emptyDir = makeTmpDir();
      const emptySm = new SessionManager(emptyDir);
      // No sessions written, so sessions dir doesn't exist
      expect(emptySm.list()).toEqual([]);
      rmSync(emptyDir, { recursive: true, force: true });
    });

    test('returns sessions sorted by most recent first', () => {
      sm.save('older', [], { ...META, timestamp: 1000 });
      sm.save('newer', [], { ...META, timestamp: 2000 });
      sm.save('middle', [], { ...META, timestamp: 1500 });

      const sessions = sm.list();
      expect(sessions).toHaveLength(3);
      expect(sessions[0].name).toBe('newer');
      expect(sessions[1].name).toBe('middle');
      expect(sessions[2].name).toBe('older');
    });

    test('includes correct message count', () => {
      const messages = [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' },
      ];
      sm.save('count-test', messages, META);
      const sessions = sm.list();
      expect(sessions[0].messageCount).toBe(3);
    });

    test('excludes removed messages from count', () => {
      const messages = [
        { role: 'user', content: 'keep' },
        { role: 'assistant', content: 'removed', removed: true },
      ];
      sm.save('removed-count', messages, META);
      const sessions = sm.list();
      expect(sessions[0].messageCount).toBe(1);
    });

    test('includes session meta info', () => {
      sm.save('meta-test', [], META);
      const sessions = sm.list();
      expect(sessions[0].title).toBe(META.title);
      expect(sessions[0].timestamp).toBe(META.timestamp);
      expect(sessions[0].name).toBe('meta-test');
    });
  });

  // -------------------------------------------------------------------------
  // Malformed data handling
  // -------------------------------------------------------------------------

  describe('malformed data handling', () => {
    test('load skips malformed JSON lines and still loads valid messages', () => {
      // Manually write a file with a bad line
      const sessionsDir = join(tmpDir, '.goodvibes', 'tui', 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      const content = [
        JSON.stringify({ type: 'meta', title: 'Bad Lines Test', model: 'm', provider: 'p', timestamp: 1 }),
        'NOT_VALID_JSON{{{',
        JSON.stringify({ type: 'message', role: 'user', content: 'valid' }),
      ].join('\n') + '\n';
      writeFileSync(join(sessionsDir, 'malformed.jsonl'), content, 'utf-8');

      const { messages } = sm.load('malformed');
      expect(messages).toHaveLength(1);
      expect((messages[0] as { content: string }).content).toBe('valid');
    });
  });
});
