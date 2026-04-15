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
import { dirname, join } from 'path';

import { SessionManager, type SessionMeta } from '../sessions/manager.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { SessionReturnContextSummary } from './session-return-context.ts';
import type { ConversationTitleSource } from '../core/conversation.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

export type SessionSnapshot = {
  messages: Array<Record<string, unknown>>;
  timestamp?: number;
  title?: string;
  titleSource?: ConversationTitleSource;
  returnContext?: SessionReturnContextSummary;
};

export type RecoveryFileInfo = {
  title: string;
  timestamp: number;
  sessionId: string;
  returnContext?: SessionReturnContextSummary;
};

export type SessionPersistenceOptions = {
  workingDirectory?: string;
  homeDirectory?: string;
  sessionManager?: SessionManager;
};

export type SessionPersistencePaths = {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
};

function requireWorkingDirectory(options?: Pick<SessionPersistenceOptions, 'workingDirectory'>): string {
  const workingDirectory = options?.workingDirectory;
  if (!workingDirectory) {
    throw new Error('Session persistence requires an explicit workingDirectory.');
  }
  return workingDirectory;
}

function requireHomeDirectory(options?: Pick<SessionPersistenceOptions, 'homeDirectory'>): string {
  const homeDirectory = options?.homeDirectory;
  if (!homeDirectory) {
    throw new Error('Session persistence requires an explicit homeDirectory.');
  }
  return homeDirectory;
}

function resolveSessionPersistencePaths(options: SessionPersistenceOptions): SessionPersistencePaths {
  return {
    workingDirectory: requireWorkingDirectory(options),
    homeDirectory: requireHomeDirectory(options),
  };
}

function resolveSessionManager(options?: SessionPersistenceOptions): SessionManager {
  if (options?.sessionManager) {
    return options.sessionManager;
  }
  return new SessionManager(requireWorkingDirectory(options));
}

export function getUserSessionsDir(workingDirectory: string): string {
  return join(workingDirectory, '.goodvibes', 'tui', 'sessions');
}

export function getLastSessionPointerPath(workingDirectory: string): string {
  return join(getUserSessionsDir(workingDirectory), 'last-session.json');
}

export function getRecoveryFilePath(homeDirectory: string): string {
  return join(homeDirectory, '.goodvibes', 'tui', 'recovery.jsonl');
}

export function generateUserSessionId(): string {
  return randomBytes(4).toString('hex');
}

export function saveSession(
  sessionId: string,
  data: SessionSnapshot,
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
      titleSource: data.titleSource,
      returnContext: data.returnContext,
    };
    sm.save(sessionId, data.messages as Array<Record<string, unknown>>, meta);
  } catch (e) {
    logger.debug('saveSession failed', { error: summarizeError(e) });
  }
}

export function persistConversation(
  sessionId: string,
  data: SessionSnapshot,
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
    const workingDirectory = requireWorkingDirectory(options);
    const pointerPath = getLastSessionPointerPath(workingDirectory);
    mkdirSync(dirname(pointerPath), { recursive: true });
    writeFileSync(
      pointerPath,
      JSON.stringify({ sessionId, timestamp: new Date().toISOString() }) + '\n',
      'utf-8',
    );
  } catch (e) {
    logger.debug('writeLastSessionPointer failed', { error: summarizeError(e) });
  }
}

export function readLastSessionPointer(options?: SessionPersistenceOptions): string | null {
  try {
    const workingDirectory = requireWorkingDirectory(options);
    const pointerPath = getLastSessionPointerPath(workingDirectory);
    if (!existsSync(pointerPath)) return null;
    const data = JSON.parse(readFileSync(pointerPath, 'utf-8')) as { sessionId?: unknown };
    if (typeof data.sessionId === 'string' && data.sessionId.trim()) return data.sessionId;
  } catch (e) {
    logger.debug('readLastSessionPointer failed', { error: summarizeError(e) });
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
    logger.debug('loadLastConversation failed', { error: summarizeError(e) });
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
    const homeDirectory = requireHomeDirectory(options);
    const recoveryFile = getRecoveryFilePath(homeDirectory);
    const lines: string[] = [];
    lines.push(JSON.stringify({ type: 'meta', sessionId, title, timestamp: Date.now() }));
    if (snapshot.titleSource || snapshot.returnContext) {
      lines[0] = JSON.stringify({
        type: 'meta',
        sessionId,
        title,
        timestamp: Date.now(),
        titleSource: snapshot.titleSource,
        returnContext: snapshot.returnContext,
      });
    }
    for (const msg of snapshot.messages) {
      lines.push(JSON.stringify({ type: 'message', ...msg }));
    }
    const tmpPath = recoveryFile + '.tmp';
    mkdirSync(dirname(recoveryFile), { recursive: true });
    writeFileSync(tmpPath, lines.join('\n') + '\n', 'utf-8');
    renameSync(tmpPath, recoveryFile);
  } catch (err) {
    logger.debug('[Recovery] Write failed', { error: summarizeError(err) });
  }
}

export function deleteRecoveryFile(options?: SessionPersistenceOptions): void {
  try {
    const homeDirectory = requireHomeDirectory(options);
    unlinkSync(getRecoveryFilePath(homeDirectory));
  } catch {
    // missing file is fine
  }
}

export function checkRecoveryFile(options?: SessionPersistenceOptions): RecoveryFileInfo | null {
  try {
    const { workingDirectory, homeDirectory } = resolveSessionPersistencePaths({
      workingDirectory: requireWorkingDirectory(options),
      homeDirectory: requireHomeDirectory(options),
    });
    const recoveryFile = getRecoveryFilePath(homeDirectory);
    if (!existsSync(recoveryFile)) return null;
    const recoveryMtime = statSync(recoveryFile).mtimeMs;
    const pointerPath = getLastSessionPointerPath(workingDirectory);
    if (existsSync(pointerPath)) {
      const lastCleanMtime = statSync(pointerPath).mtimeMs;
      if (recoveryMtime <= lastCleanMtime) return null;
    }
    const fd = openSync(recoveryFile, 'r');
    const buf = Buffer.alloc(4096);
    const bytesRead = readSync(fd, buf, 0, 4096, 0);
    closeSync(fd);
    const firstLine = buf.toString('utf-8', 0, bytesRead).split('\n')[0];
    const meta = JSON.parse(firstLine) as { title?: string; timestamp?: number; sessionId?: string; returnContext?: SessionReturnContextSummary };
    return {
      title: meta.title ?? '',
      timestamp: meta.timestamp ?? 0,
      sessionId: meta.sessionId ?? '',
      returnContext: meta.returnContext,
    };
  } catch (err) {
    logger.debug('[Recovery] Check failed', { error: summarizeError(err) });
    return null;
  }
}

export function loadRecoveryConversation(options?: SessionPersistenceOptions): SessionSnapshot | null {
  try {
    const homeDirectory = requireHomeDirectory(options);
    const recoveryFile = getRecoveryFilePath(homeDirectory);
    const raw = readFileSync(recoveryFile, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length < 2) return { messages: [] };
    return {
      title: (() => {
        try {
          const metaLine = JSON.parse(lines[0]) as { title?: string; titleSource?: ConversationTitleSource; returnContext?: SessionReturnContextSummary };
          return metaLine.title;
        } catch {
          return undefined;
        }
      })(),
      titleSource: (() => {
        try {
          const metaLine = JSON.parse(lines[0]) as { titleSource?: ConversationTitleSource };
          return metaLine.titleSource;
        } catch {
          return undefined;
        }
      })(),
      returnContext: (() => {
        try {
          const metaLine = JSON.parse(lines[0]) as { returnContext?: SessionReturnContextSummary };
          return metaLine.returnContext;
        } catch {
          return undefined;
        }
      })(),
      messages: lines.slice(1).map((line) => {
        const { type: _type, ...rest } = JSON.parse(line) as { type: string } & Record<string, unknown>;
        return rest;
      }),
    };
  } catch (err) {
    logger.debug('[Recovery] Load failed', { error: summarizeError(err) });
    return null;
  }
}
