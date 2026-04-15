import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

import { AgentSession } from '../../agents/session.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { KVState } from '@pellux/goodvibes-sdk/platform/state/kv-state';

describe('AgentSession', () => {
  let session: AgentSession;
  let rootDir: string;
  const agentId = 'test-agent-01';
  const model = 'gpt-4';
  const provider = 'openai';

  function sessionPaths(root: string) {
    return {
      sessionsDir: join(root, '.goodvibes', 'tui', 'sessions'),
      stateDir: join(root, '.goodvibes', 'state'),
    };
  }

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'gv-agent-session-'));
    session = new AgentSession(agentId, model, provider, sessionPaths(rootDir));
  });

  afterEach(async () => {
    await session.dispose();
    if (existsSync(rootDir)) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    test('stores agentId', () => {
      expect(session.agentId).toBe(agentId);
    });

    test('creates a ConversationManager', () => {
      expect(session.conversation).toBeInstanceOf(ConversationManager);
    });

    test('creates a KVState', () => {
      expect(session.kvState).toBeInstanceOf(KVState);
    });

    test('sets sessionFile path with agent prefix', () => {
      expect(session.sessionFile).toContain(`${agentId}.jsonl`);
      expect(session.sessionFile).toContain('.goodvibes/tui/sessions');
    });

    test('creates the sessions directory', () => {
      const dir = session.sessionFile.replace(/\/[^/]+$/, '');
      expect(existsSync(dir)).toBe(true);
    });

    test('writes a session_start entry to JSONL on construction', () => {
      expect(existsSync(session.sessionFile)).toBe(true);
      const content = readFileSync(session.sessionFile, 'utf-8').trim();
      const firstLine = content.split('\n')[0];
      const entry = JSON.parse(firstLine);
      expect(entry.type).toBe('meta');
      expect(entry.agentId).toBe(agentId);
      expect(entry.model).toBe(model);
      expect(entry.provider).toBe(provider);
      expect(entry.timestamp).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // appendMessage
  // -------------------------------------------------------------------------

  describe('appendMessage', () => {
    test('appends a JSON line to the session file', () => {
      session.appendMessage({ type: 'user', content: 'hello' });
      const lines = readFileSync(session.sessionFile, 'utf-8').trim().split('\n');
      // session_start line + our new line
      expect(lines.length).toBe(2);
      const entry = JSON.parse(lines[1]);
      expect(entry.type).toBe('user');
      expect(entry.content).toBe('hello');
    });

    test('each call appends a separate line', () => {
      session.appendMessage({ type: 'user', content: 'msg1' });
      session.appendMessage({ type: 'assistant', content: 'msg2' });
      session.appendMessage({ type: 'tool', name: 'read' });
      const lines = readFileSync(session.sessionFile, 'utf-8').trim().split('\n');
      // session_start + 3 messages
      expect(lines.length).toBe(4);
    });

    test('each line is valid JSON', () => {
      session.appendMessage({ role: 'user', content: 'hi' });
      const lines = readFileSync(session.sessionFile, 'utf-8').trim().split('\n');
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });

  // -------------------------------------------------------------------------
  // KVState namespace isolation
  // -------------------------------------------------------------------------

  describe('kvState namespace', () => {
    test('kvState session ID includes agent prefix', () => {
      const sessionId = session.kvState.getSessionId();
      expect(sessionId).toBe(agentId);
    });

    test('two AgentSessions have different kvState instances', async () => {
      const other = new AgentSession('other-agent', model, provider, sessionPaths(rootDir));
      expect(session.kvState).not.toBe(other.kvState);
      await other.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // conversation isolation
  // -------------------------------------------------------------------------

  describe('conversation isolation', () => {
    test('each AgentSession has its own ConversationManager', async () => {
      const other = new AgentSession('other-agent-2', model, provider, sessionPaths(rootDir));
      expect(session.conversation).not.toBe(other.conversation);
      await other.dispose();
    });

    test('messages in one session do not appear in another', async () => {
      session.conversation.addUserMessage('hello from agent 1');
      const other = new AgentSession('other-agent-3', model, provider, sessionPaths(rootDir));
      expect(other.conversation.getMessageCount()).toBe(0);
      await other.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // dispose
  // -------------------------------------------------------------------------

  describe('dispose', () => {
    test('dispose resolves without error', async () => {
      const s = new AgentSession('dispose-test', model, provider, sessionPaths(rootDir));
      await expect(s.dispose()).resolves.toBeUndefined();
    });
  });
});
