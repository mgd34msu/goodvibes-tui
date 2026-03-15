import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.ts';

/**
 * Metadata for a saved session (the first JSONL line).
 */
export interface SessionMeta {
  title: string;
  model: string;
  provider: string;
  timestamp: number;
}

/**
 * Summary info for listing saved sessions.
 */
export interface SessionInfo {
  name: string;
  title: string;
  timestamp: number;
  messageCount: number;
  filePath: string;
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
  save(name: string, messages: object[], meta: SessionMeta): { filePath: string; sanitizedName: string } {
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
    };
    lines.push(JSON.stringify(metaRecord));

    // Subsequent lines: one message per line
    for (const msg of messages) {
      const { type: _ignored, ...safeMsg } = msg as Record<string, unknown>;
      const record = { ...safeMsg, type: 'message' as const };
      lines.push(JSON.stringify(record));
    }

    writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
    return { filePath, sanitizedName };
  }

  /**
   * Load a session from JSONL. Returns meta and messages (excluding removed ones).
   * Throws if the file does not exist or cannot be parsed.
   */
  load(name: string): { meta: SessionMeta; messages: object[] } {
    if (!name || !name.trim()) throw new Error('Session name cannot be empty');
    const filename = this.sanitizeName(name);
    const filePath = join(this.sessionsDir, `${filename}.jsonl`);

    if (!existsSync(filePath)) {
      throw new Error(`Session not found: ${name}`);
    }

    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);

    let meta: SessionMeta = { title: '', model: '', provider: '', timestamp: 0 };
    const messages: object[] = [];

    let skipped = 0;
    for (const line of lines) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        skipped++;
        continue;
      }

      if (record.type === 'meta') {
        meta = {
          title: String(record.title ?? ''),
          model: String(record.model ?? ''),
          provider: String(record.provider ?? ''),
          timestamp: Number(record.timestamp ?? 0),
        };
      } else if (record.type === 'message') {
        // Skip messages marked as removed (F2 future feature)
        if (record.removed === true) continue;
        // Strip the 'type' wrapper before returning raw message
        const { type: _type, ...msgFields } = record;
        messages.push(msgFields);
      }
    }

    if (skipped > 0) logger.debug('Skipped malformed lines', { name, skipped });
    return { meta, messages };
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
      return [];
    }

    const sessions: SessionInfo[] = [];

    for (const file of files) {
      const name = file.replace(/\.jsonl$/, '');
      const filePath = join(this.sessionsDir, file);

      let meta: SessionMeta = { title: '', model: '', provider: '', timestamp: 0 };
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
              };
            }
          } catch {
            // Malformed meta line; continue with defaults
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
        // Skip unreadable files
        continue;
      }

      sessions.push({
        name,
        title: meta.title,
        timestamp: meta.timestamp,
        messageCount,
        filePath,
      });
    }

    // Sort by most recent first
    sessions.sort((a, b) => b.timestamp - a.timestamp);
    return sessions;
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

/**
 * Lazy singleton accessor for SessionManager.
 * Avoids re-instantiation on every command invocation.
 */
let _instance: SessionManager | undefined;
export function getSessionManager(): SessionManager {
  if (!_instance) _instance = new SessionManager();
  return _instance;
}
