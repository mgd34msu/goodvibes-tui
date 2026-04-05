import { randomBytes } from 'crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

import { getSessionManager, type SessionManager, type SessionMeta } from '../sessions/manager.ts';
import { logger } from '../utils/logger.ts';

export type SessionSnapshot = {
  messages: Array<Record<string, unknown>>;
  timestamp?: number;
};

export type RecoveryFileInfo = {
  title: string;
  timestamp: number;
  sessionId: string;
};

export type SessionPersistenceOptions = {
  cwd?: string;
  homeDir?: string;
  sessionManager?: SessionManager;
};

function resolveSessionManager(options?: SessionPersistenceOptions): SessionManager {
  return options?.sessionManager ?? getSessionManager();
}

export function getUserSessionsDir(cwd = process.cwd()): string {
  return join(cwd, '.goodvibes', 'tui', 'sessions');
}

export function getLastSessionPointerPath(cwd = process.cwd()): string {
  return join(getUserSessionsDir(cwd), 'last-session.json');
}

export function getRecoveryFilePath(homeDir = homedir()): string {
  return join(homeDir, '.goodvibes', 'tui', 'recovery.jsonl');
}

export function generateUserSessionId(): string {
  return randomBytes(4).toString('hex');
}

export function saveSession(
  sessionId: string,
  data: { messages: object[]; timestamp?: number },
  model: string,
  provider: string,
  title = '',
  options?: SessionPersistenceOptions,
): void {
  try {
    const sm = resolveSessionManager(options);
    const meta: SessionMeta = {
      title,
      model,
      provider,
      timestamp: data.timestamp ?? Date.now(),
    };
    sm.save(sessionId, data.messages as Array<Record<string, unknown>>, meta);
  } catch (e) {
    logger.debug('saveSession failed', { error: String(e) });
  }
}

export function persistConversation(
  sessionId: string,
  data: { messages: object[]; timestamp?: number },
  model: string,
  provider: string,
  title = '',
  options?: SessionPersistenceOptions,
): void {
  saveSession(sessionId, data, model, provider, title, options);
  writeLastSessionPointer(sessionId, options);
}

export function writeLastSessionPointer(sessionId: string, options?: SessionPersistenceOptions): void {
  try {
    const pointerPath = getLastSessionPointerPath(options?.cwd);
    mkdirSync(dirname(pointerPath), { recursive: true });
    writeFileSync(
      pointerPath,
      JSON.stringify({ sessionId, timestamp: new Date().toISOString() }) + '\n',
      'utf-8',
    );
  } catch (e) {
    logger.debug('writeLastSessionPointer failed', { error: String(e) });
  }
}

export function readLastSessionPointer(options?: SessionPersistenceOptions): string | null {
  try {
    const pointerPath = getLastSessionPointerPath(options?.cwd);
    if (!existsSync(pointerPath)) return null;
    const data = JSON.parse(readFileSync(pointerPath, 'utf-8')) as { sessionId?: unknown };
    if (typeof data.sessionId === 'string' && data.sessionId.trim()) return data.sessionId;
  } catch (e) {
    logger.debug('readLastSessionPointer failed', { error: String(e) });
  }
  return null;
}

export function loadLastConversation(options?: SessionPersistenceOptions): SessionSnapshot | null {
  try {
    const lastId = readLastSessionPointer(options);
    const sm = resolveSessionManager(options);
    if (!lastId) return null;

    const { messages } = sm.load(lastId);
    return { messages: messages as Array<Record<string, unknown>> };
  } catch (e) {
    logger.debug('loadLastConversation failed', { error: String(e) });
  }
  return null;
}

export function writeRecoveryFile(
  snapshot: SessionSnapshot,
  sessionId: string,
  title = '',
  options?: SessionPersistenceOptions,
): void {
  try {
    if (!snapshot.messages.length) return;
    const recoveryFile = getRecoveryFilePath(options?.homeDir);
    const lines: string[] = [];
    lines.push(JSON.stringify({ type: 'meta', sessionId, title, timestamp: Date.now() }));
    for (const msg of snapshot.messages) {
      lines.push(JSON.stringify({ type: 'message', ...msg }));
    }
    const tmpPath = recoveryFile + '.tmp';
    mkdirSync(dirname(recoveryFile), { recursive: true });
    writeFileSync(tmpPath, lines.join('\n') + '\n', 'utf-8');
    renameSync(tmpPath, recoveryFile);
  } catch (err) {
    logger.debug('[Recovery] Write failed', { error: String(err) });
  }
}

export function deleteRecoveryFile(options?: SessionPersistenceOptions): void {
  try {
    unlinkSync(getRecoveryFilePath(options?.homeDir));
  } catch {
    // missing file is fine
  }
}

export function checkRecoveryFile(options?: SessionPersistenceOptions): RecoveryFileInfo | null {
  try {
    const recoveryFile = getRecoveryFilePath(options?.homeDir);
    if (!existsSync(recoveryFile)) return null;
    const recoveryMtime = statSync(recoveryFile).mtimeMs;
    const pointerPath = getLastSessionPointerPath(options?.cwd);
    if (existsSync(pointerPath)) {
      const lastCleanMtime = statSync(pointerPath).mtimeMs;
      if (recoveryMtime <= lastCleanMtime) return null;
    }
    const fd = openSync(recoveryFile, 'r');
    const buf = Buffer.alloc(4096);
    const bytesRead = readSync(fd, buf, 0, 4096, 0);
    closeSync(fd);
    const firstLine = buf.toString('utf-8', 0, bytesRead).split('\n')[0];
    const meta = JSON.parse(firstLine) as { title?: string; timestamp?: number; sessionId?: string };
    return {
      title: meta.title ?? '',
      timestamp: meta.timestamp ?? 0,
      sessionId: meta.sessionId ?? '',
    };
  } catch (err) {
    logger.debug('[Recovery] Check failed', { error: String(err) });
    return null;
  }
}

export function loadRecoveryConversation(options?: SessionPersistenceOptions): SessionSnapshot | null {
  try {
    const recoveryFile = getRecoveryFilePath(options?.homeDir);
    const raw = readFileSync(recoveryFile, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length < 2) return { messages: [] };
    return {
      messages: lines.slice(1).map((line) => {
        const { type: _type, ...rest } = JSON.parse(line) as { type: string } & Record<string, unknown>;
        return rest;
      }),
    };
  } catch (err) {
    logger.debug('[Recovery] Load failed', { error: String(err) });
    return null;
  }
}
