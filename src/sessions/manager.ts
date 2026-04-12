import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.ts';
import type { AgentRecord } from '../tools/agent/index.ts';
import type { SessionReturnContextSummary } from '../runtime/session-return-context.ts';
import type { ConversationTitleSource } from '../core/conversation.ts';

/**
 * Metadata for a saved session (the first JSONL line).
 */
export interface SessionMeta {
  title: string;
  model: string;
  provider: string;
  timestamp: number;
  titleSource?: ConversationTitleSource;
  returnContext?: SessionReturnContextSummary;
}

/**
 * Summary info for listing saved sessions.
 */
export interface SessionInfo {
  name: string;
  title: string;
  model: string;
  provider: string;
  timestamp: number;
  messageCount: number;
  filePath: string;
  titleSource?: ConversationTitleSource;
  returnContext?: SessionReturnContextSummary;
}

/**
 * SessionManager - Handles saving and loading named conversation sessions
 * as JSONL files under .goodvibes/tui/sessions/.
 *
 * Format: each line is a JSON object.
 *   Line 0: { type: 'meta', ...SessionMeta }
 *   Line N: { type: 'message', ...message fields }
 */
export class SessionManager {
  private sessionsDir: string;

  constructor(baseDir?: string) {
    this.sessionsDir = join(baseDir ?? process.cwd(), '.goodvibes', 'tui', 'sessions');
  }

  /**
   * Save conversation messages to a JSONL session file.
   * Overwrites if file already exists.
   * Returns the sanitized filename used (may differ from input name).
   */
  save(
    name: string,
    messages: object[],
    meta: SessionMeta,
    agentRecords?: AgentRecord[],
  ): { filePath: string; sanitizedName: string } {
    if (!name || !name.trim()) throw new Error('Session name cannot be empty');
    mkdirSync(this.sessionsDir, { recursive: true });
    const sanitizedName = this.sanitizeName(name);
    const filePath = join(this.sessionsDir, `${sanitizedName}.jsonl`);

    const lines: string[] = [];

    // First line: meta record
    const metaRecord = {
      type: 'meta' as const,
      timestamp: meta.timestamp,
      title: meta.title,
      model: meta.model,
      provider: meta.provider,
      titleSource: meta.titleSource ?? 'system',
      returnContext: meta.returnContext,
    };
    lines.push(JSON.stringify(metaRecord));

    // Subsequent lines: one message per line
    for (const msg of messages) {
      const { type: _ignored, ...safeMsg } = msg as Record<string, unknown>;
      const record = { ...safeMsg, type: 'message' as const };
      lines.push(JSON.stringify(record));
    }

    // Agent records: one per line, after messages
    if (agentRecords && agentRecords.length > 0) {
      for (const agent of agentRecords) {
        const record = { ...agent, type: 'agent_record' as const };
        lines.push(JSON.stringify(record));
      }
    }

    writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
    return { filePath, sanitizedName };
  }

  /**
   * Load a session from JSONL. Returns meta and messages (excluding removed ones).
   * Throws if the file does not exist or cannot be parsed.
   */
  load(name: string): { meta: SessionMeta; messages: object[]; agentRecords: AgentRecord[] } {
    if (!name || !name.trim()) throw new Error('Session name cannot be empty');
    const filename = this.sanitizeName(name);
    const filePath = join(this.sessionsDir, `${filename}.jsonl`);

    if (!existsSync(filePath)) {
      throw new Error(`Session not found: ${name}`);
    }

    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);

    let meta: SessionMeta = { title: '', model: '', provider: '', timestamp: 0, titleSource: 'system' };
    const messages: object[] = [];
    const agentRecords: AgentRecord[] = [];

    let skipped = 0;
    for (const line of lines) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Non-fatal: malformed JSON line — skip and count it
        skipped++;
        continue;
      }

      if (record.type === 'meta') {
        meta = {
          title: String(record.title ?? ''),
          model: String(record.model ?? ''),
          provider: String(record.provider ?? ''),
          timestamp: Number(record.timestamp ?? 0),
          titleSource: record.titleSource === 'user' ? 'user' : 'system',
          returnContext: (record.returnContext && typeof record.returnContext === 'object')
            ? (record.returnContext as SessionReturnContextSummary)
            : undefined,
        };
      } else if (record.type === 'message') {
        // Skip messages marked as removed (F2 future feature)
        if (record.removed === true) continue;
        // Strip the 'type' wrapper before returning raw message
        const { type: _type, ...msgFields } = record;
        messages.push(msgFields);
      } else if (record.type === 'agent_record') {
        const { type: _type, ...agentFields } = record;
        if (typeof agentFields.id === 'string' && typeof agentFields.status === 'string' && typeof agentFields.task === 'string') {
          agentRecords.push(agentFields as unknown as AgentRecord);
        }
      }
    }

    if (skipped > 0) logger.debug('Skipped malformed lines', { name, skipped });
    return { meta, messages, agentRecords };
  }

  /**
   * List all saved sessions with metadata, sorted by most recent first.
   */
  list(): SessionInfo[] {
    if (!existsSync(this.sessionsDir)) return [];

    let files: string[];
    try {
      files = readdirSync(this.sessionsDir).filter(f => f.endsWith('.jsonl'));
    } catch {
      // Non-fatal: sessions directory unreadable (permissions, doesn't exist yet)
      logger.debug('SessionManager: could not read sessions directory', { dir: this.sessionsDir });
      return [];
    }

    const sessions: SessionInfo[] = [];

    for (const file of files) {
      const name = file.replace(/\.jsonl$/, '');
      const filePath = join(this.sessionsDir, file);

      let meta: SessionMeta = { title: '', model: '', provider: '', timestamp: 0, titleSource: 'system' };
      let messageCount = 0;

      try {
        const raw = readFileSync(filePath, 'utf-8');
        const lines = raw.split('\n').filter(l => l.trim().length > 0);

        // Parse only the first line for meta; count remaining non-removed message lines
        if (lines.length > 0) {
          try {
            const first = JSON.parse(lines[0]) as Record<string, unknown>;
            if (first.type === 'meta') {
              meta = {
                title: String(first.title ?? ''),
                model: String(first.model ?? ''),
                provider: String(first.provider ?? ''),
                timestamp: Number(first.timestamp ?? 0),
                titleSource: first.titleSource === 'user' ? 'user' : 'system',
                returnContext: (first.returnContext && typeof first.returnContext === 'object')
                  ? (first.returnContext as SessionReturnContextSummary)
                  : undefined,
              };
            }
          } catch {
            // Non-fatal: malformed meta line — session listed with default title/model
            logger.debug('SessionManager: malformed meta line', { name });
          }
        }

        // Count message lines: parse each line's type/removed fields only (no full content parse)
        // Using startsWith anchor to avoid false positives from message content containing these strings
        for (const l of lines.slice(1)) {
          const trimmed = l.trim();
          if (trimmed.startsWith('{"') && trimmed.includes('"type":"message"')) {
            // Quick check: is "removed":true near the start of the line (before content)?
            // Content is always the longest field, so type/removed appear in the first ~50 chars
            const prefix = trimmed.slice(0, 60);
            if (!prefix.includes('"removed":true')) {
              messageCount++;
            }
          }
        }
      } catch {
        // Non-fatal: session file unreadable — skip it from the listing
        logger.debug('SessionManager: unreadable session file', { name });
        continue;
      }

      sessions.push({
        name,
        title: meta.title,
        model: meta.model,
        provider: meta.provider,
        timestamp: meta.timestamp,
        messageCount,
        filePath,
        titleSource: meta.titleSource,
        returnContext: meta.returnContext,
      });
    }

    // Sort by most recent first
    sessions.sort((a, b) => b.timestamp - a.timestamp);
    return sessions;
  }

  /**
   * Get just the metadata for a session without loading all messages.
   * Returns null if the session does not exist or meta cannot be parsed.
   */
  getMeta(name: string): SessionMeta | null {
    if (!name || !name.trim()) return null;
    const filename = this.sanitizeName(name);
    const filePath = join(this.sessionsDir, `${filename}.jsonl`);
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const firstLine = raw.split('\n')[0];
      if (!firstLine?.trim()) return null;
      const record = JSON.parse(firstLine) as Record<string, unknown>;
      if (record.type !== 'meta') return null;
      return {
        title: String(record.title ?? ''),
        model: String(record.model ?? ''),
        provider: String(record.provider ?? ''),
        timestamp: Number(record.timestamp ?? 0),
        titleSource: record.titleSource === 'user' ? 'user' : 'system',
        returnContext: (record.returnContext && typeof record.returnContext === 'object')
          ? (record.returnContext as SessionReturnContextSummary)
          : undefined,
      };
    } catch {
      // Non-fatal: session file unreadable or missing meta — return null to caller
      logger.debug('SessionManager: could not read session meta', { name: filePath });
      return null;
    }
  }

  /**
   * Rename a session by rewriting its meta line with a new title.
   * The file is stored under the sanitized name — rename updates the title
   * field inside the file but does NOT rename the file itself.
   * Throws if the session does not exist.
   */
  rename(name: string, newTitle: string): void {
    if (!name || !name.trim()) throw new Error('Session name cannot be empty');
    const filename = this.sanitizeName(name);
    const filePath = join(this.sessionsDir, `${filename}.jsonl`);
    if (!existsSync(filePath)) throw new Error(`Session not found: ${name}`);

    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n');
    if (lines.length === 0) throw new Error('Session file is empty');

    try {
      const record = JSON.parse(lines[0]) as Record<string, unknown>;
      record.title = newTitle;
      lines[0] = JSON.stringify(record);
      writeFileSync(filePath, lines.join('\n'), 'utf-8');
    } catch {
      throw new Error(`Failed to update session title: ${name}`);
    }
  }

  /**
   * Delete a session file.
   * Throws if the session does not exist.
   */
  delete(name: string): void {
    if (!name || !name.trim()) throw new Error('Session name cannot be empty');
    const filename = this.sanitizeName(name);
    const filePath = join(this.sessionsDir, `${filename}.jsonl`);
    if (!existsSync(filePath)) throw new Error(`Session not found: ${name}`);
    try {
      unlinkSync(filePath);
    } catch (e) {
      throw new Error(`Failed to delete session: ${(e as Error).message}`);
    }
  }

  /**
   * Search all sessions for messages containing the query string (case-insensitive).
   * Returns sessions with match count and up to 3 context snippets per session.
   */
  search(query: string): Array<{ session: SessionInfo; matchCount: number; snippets: string[] }> {
    if (!query || !query.trim()) return [];
    const q = query.toLowerCase();
    const sessions = this.list();
    const results: Array<{ session: SessionInfo; matchCount: number; snippets: string[] }> = [];

    for (const session of sessions) {
      try {
        const raw = readFileSync(session.filePath, 'utf-8');
        const lines = raw.split('\n').filter(l => l.trim().length > 0);
        let matchCount = 0;
        const snippets: string[] = [];

        for (const line of lines.slice(1)) { // skip meta line
          try {
            const record = JSON.parse(line) as Record<string, unknown>;
            if (record.type !== 'message') continue;
            const content = String(record.content ?? '');
            const lower = content.toLowerCase();
            const idx = lower.indexOf(q);
            if (idx !== -1) {
              matchCount++;
              if (snippets.length < 3) {
                const start = Math.max(0, idx - 40);
                const end = Math.min(content.length, idx + q.length + 60);
                const snippet = (start > 0 ? '...' : '') + content.slice(start, end).replace(/\n/g, ' ') + (end < content.length ? '...' : '');
                snippets.push(snippet);
              }
            }
          } catch {
            // Non-fatal: malformed line in session during search — skip it
            logger.debug('SessionManager: malformed line during search', { name });
          }
        }

        if (matchCount > 0) {
          results.push({ session, matchCount, snippets });
        }
      } catch {
        // Non-fatal: session unreadable during search — skip it
        logger.debug('SessionManager: unreadable session during search', { name });
      }
    }

    // Sort by match count descending
    results.sort((a, b) => b.matchCount - a.matchCount);
    return results;
  }

  /**
   * Sanitize a session name into a safe filename.
   * Replaces spaces with hyphens, strips non-alphanumeric/hyphen/underscore chars,
   * collapses multiple hyphens, trims leading/trailing hyphens.
   */
  sanitizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      || 'session';
  }
}
