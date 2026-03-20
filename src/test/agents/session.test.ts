import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// We test AgentSession in isolation by overriding process.cwd() behaviour.
// AgentSession uses process.cwd() for its file paths, so we exercise the
// class directly and verify side effects on disk.
// ---------------------------------------------------------------------------

import { AgentSession } from '../../agents/session.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { KVState } from '../../state/kv-state.ts';

describe('AgentSession', () => {
  let session: AgentSession;
  const agentId = 'test-agent-01';
  const model = 'gpt-4';
  const provider = 'openai';

  beforeEach(() => {
    session = new AgentSession(agentId, model, provider);
  });

  afterEach(async () => {
    await session.dispose();
    // Clean up the JSONL file written to cwd-relative path
    if (existsSync(session.sessionFile)) {
      rmSync(session.sessionFile, { force: true });
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

    test('two AgentSessions have different kvState instances', () => {
      const other = new AgentSession('other-agent', model, provider);
      expect(session.kvState).not.toBe(other.kvState);
      // Clean up
      other.dispose();
      if (existsSync(other.sessionFile)) rmSync(other.sessionFile, { force: true });
    });
  });

  // -------------------------------------------------------------------------
  // conversation isolation
  // -------------------------------------------------------------------------

  describe('conversation isolation', () => {
    test('each AgentSession has its own ConversationManager', () => {
      const other = new AgentSession('other-agent-2', model, provider);
      expect(session.conversation).not.toBe(other.conversation);
      other.dispose();
      if (existsSync(other.sessionFile)) rmSync(other.sessionFile, { force: true });
    });

    test('messages in one session do not appear in another', () => {
      session.conversation.addUserMessage('hello from agent 1');
      const other = new AgentSession('other-agent-3', model, provider);
      expect(other.conversation.getMessageCount()).toBe(0);
      other.dispose();
      if (existsSync(other.sessionFile)) rmSync(other.sessionFile, { force: true });
    });
  });

  // -------------------------------------------------------------------------
  // dispose
  // -------------------------------------------------------------------------

  describe('dispose', () => {
    test('dispose resolves without error', async () => {
      const s = new AgentSession('dispose-test', model, provider);
      await expect(s.dispose()).resolves.toBeUndefined();
      if (existsSync(s.sessionFile)) rmSync(s.sessionFile, { force: true });
    });
  });
});
