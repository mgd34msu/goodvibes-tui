import { OperatorSqliteStore } from '../../operator/index.ts';
import type { AtRestCipher } from '../../operator/index.ts';
import { redactWebhook, sha256First } from '../../operator/index.ts';

// ---------------------------------------------------------------------------
// Draft Sync Backend store.
//
// Mirrors the agent's local draft store (channels/drafts.json) server-side so
// drafts are visible across surfaces. The agent's local file remains the source
// of truth; this store is a sync mirror. Conflict resolution (most-recent
// updatedAt wins) is the integrator's concern — this store performs a plain
// upsert and records the supplied/derived updatedAt.
//
// SECURITY POSTURE:
//   - The plaintext message body is NEVER persisted. It is encrypted at rest
//     via the daemon at-rest cipher (AES-256-GCM) and stored as `bodyEnc`.
//   - The webhook URL is encrypted at rest (`webhookEnc`) and is ALWAYS
//     redacted ('[redacted]') in every list/get response — the raw URL never
//     leaves the store.
//   - `messageDigest` (sha256First(body, 12)) is computed at save time and
//     stored alongside, so reads never need to decrypt the body. The raw body
//     is never included in any response — only the digest.
// ---------------------------------------------------------------------------

export type DraftStatus = 'draft' | 'queued' | 'sent' | 'failed';

/** Statuses callers are permitted to write via save(). */
export const WRITABLE_DRAFT_STATUSES: readonly DraftStatus[] = ['draft', 'queued'];

/** All known statuses (writable + terminal states set by the send pipeline). */
export const ALL_DRAFT_STATUSES: readonly DraftStatus[] = [
  'draft',
  'queued',
  'sent',
  'failed',
];

export const DRAFT_MESSAGE_DIGEST_HEX = 12;

export const DEFAULT_DRAFT_LIST_LIMIT = 50;
export const MAX_DRAFT_LIST_LIMIT = 200;

/**
 * Public draft record returned by list/get. The plaintext body is NEVER
 * present — only `messageDigest`. `webhook` is always '[redacted]' when set.
 */
export interface DraftRecord {
  id: string;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  status: DraftStatus;
  title?: string;
  messageDigest: string; // sha256First(body, 12) — body is NOT transmitted
  channel?: string;
  route?: string;
  webhook?: string; // '[redacted]' when a webhook is stored, else omitted
  link?: string;
  tags?: string[];
  sentResponseId?: string;
  sendError?: string;
}

/** Normalized input accepted by upsert(). */
export interface DraftSaveInput {
  id?: string;
  title?: string;
  message: string;
  channel?: string;
  route?: string;
  webhook?: string;
  link?: string;
  tags?: string[];
  status?: DraftStatus;
  /**
   * Caller-supplied last-modified timestamp (ISO-8601). When provided it is
   * persisted verbatim, enabling the sync contract's conflict model ('on
   * conflict, most recent updatedAt wins') to be expressed through this store:
   * an integrator can push the agent's authoritative updatedAt rather than
   * having it overwritten by daemon-local time. When omitted, the store stamps
   * updatedAt = now().
   */
  updatedAt?: string;
}

export interface DraftListQuery {
  status?: DraftStatus;
  limit?: number;
}

export interface DraftSaveResult {
  id: string;
  created: boolean;
}

export interface DraftSyncStoreOptions {
  workingDirectory: string;
  cipher: AtRestCipher;
  /** Override the sqlite filename (tests). Defaults to 'drafts.sqlite'. */
  fileName?: string;
  /** UUID generator injection point (tests). Defaults to crypto.randomUUID. */
  generateId?: () => string;
  /** Clock injection point (tests). Defaults to () => new Date().toISOString(). */
  now?: () => string;
}

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS drafts (
     id TEXT PRIMARY KEY,
     createdAt TEXT NOT NULL,
     updatedAt TEXT NOT NULL,
     status TEXT NOT NULL,
     title TEXT,
     bodyEnc TEXT NOT NULL,
     messageDigest TEXT NOT NULL,
     channel TEXT,
     route TEXT,
     webhookEnc TEXT,
     link TEXT,
     tags TEXT,
     sentResponseId TEXT,
     sendError TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts (status)',
  'CREATE INDEX IF NOT EXISTS idx_drafts_updatedAt ON drafts (updatedAt)',
];

interface DraftRow {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  title: string | null;
  messageDigest: string;
  channel: string | null;
  route: string | null;
  webhookEnc: string | null;
  link: string | null;
  tags: string | null;
  sentResponseId: string | null;
  sendError: string | null;
}

function nullable(value: string | undefined): string | null {
  return value === undefined ? null : value;
}

function parseTags(raw: string | null): string[] | undefined {
  if (raw === null || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const tags = parsed.filter((t): t is string => typeof t === 'string');
      return tags.length > 0 ? tags : undefined;
    }
  } catch {
    // Corrupt tags column — treat as absent rather than throwing on read.
  }
  return undefined;
}

function normalizeStatus(status: DraftStatus | undefined): DraftStatus {
  return status ?? 'draft';
}

/**
 * Server-side mirror of agent drafts. Wraps OperatorSqliteStore; all body and
 * webhook material is encrypted at rest via the injected AtRestCipher.
 */
export class DraftSyncStore {
  private readonly store: OperatorSqliteStore;
  private readonly cipher: AtRestCipher;
  private readonly generateId: () => string;
  private readonly now: () => string;
  private initialized = false;

  constructor(options: DraftSyncStoreOptions) {
    this.store = new OperatorSqliteStore({
      workingDirectory: options.workingDirectory,
      fileName: options.fileName ?? 'drafts.sqlite',
      schema: SCHEMA,
    });
    this.cipher = options.cipher;
    this.generateId = options.generateId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get dbPath(): string {
    return this.store.dbPath;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.store.init();
    this.initialized = true;
  }

  /** Persist the in-memory db to disk (atomic tmp+rename via the base store). */
  async save(): Promise<void> {
    await this.store.save();
  }

  close(): void {
    this.store.close();
    this.initialized = false;
  }

  /**
   * Create (no id) or update (id present) a draft. Encrypts the body and
   * webhook at rest, computes messageDigest, and sets updatedAt to the
   * caller-supplied input.updatedAt when present (enabling the 'most recent
   * updatedAt wins' conflict model) or now() otherwise. On update, createdAt is
   * preserved from the existing row.
   *
   * FULL-REPLACE SEMANTICS (intentional, per the full-snapshot sync contract):
   * every caller-supplied field is treated as a complete snapshot, NOT a partial
   * patch. The ON CONFLICT UPDATE SET clause below assigns each column from the
   * incoming row (excluded.*), so on update an OMITTED optional field is cleared,
   * not preserved. Concretely: omitting `webhook` clears any previously-stored
   * webhook (webhookEnc -> NULL); omitting `tags` removes them (tags -> NULL);
   * the same applies to title/channel/route/link. Callers performing a partial
   * edit MUST re-supply every field they want to keep. The ONLY exceptions are
   * sentResponseId/sendError, which are owned by the send pipeline and are
   * deliberately omitted from the UPDATE SET clause so they survive a save().
   *
   * NOTE: caller is responsible for store.save() after a batch of mutations,
   * or this can be invoked through DraftSyncStore.save(). The register layer
   * saves after every mutation.
   */
  async upsert(input: DraftSaveInput): Promise<DraftSaveResult> {
    const existing = input.id !== undefined ? this.getRow(input.id) : null;
    const created = existing === null;
    const id = existing?.id ?? input.id ?? this.generateId();
    const timestamp = this.now();
    const createdAt = existing?.createdAt ?? timestamp;
    const updatedAt = input.updatedAt ?? timestamp;
    const status = normalizeStatus(input.status);

    const bodyEnc = await this.cipher.encrypt(input.message);
    const messageDigest = sha256First(input.message, DRAFT_MESSAGE_DIGEST_HEX);
    const webhookEnc =
      input.webhook !== undefined && input.webhook !== ''
        ? await this.cipher.encrypt(input.webhook)
        : null;
    const tagsJson =
      input.tags !== undefined && input.tags.length > 0
        ? JSON.stringify(input.tags)
        : null;

    this.store.run(
      `INSERT INTO drafts (
         id, createdAt, updatedAt, status, title, bodyEnc, messageDigest,
         channel, route, webhookEnc, link, tags, sentResponseId, sendError
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         updatedAt = excluded.updatedAt,
         status = excluded.status,
         title = excluded.title,
         bodyEnc = excluded.bodyEnc,
         messageDigest = excluded.messageDigest,
         channel = excluded.channel,
         route = excluded.route,
         webhookEnc = excluded.webhookEnc,
         link = excluded.link,
         tags = excluded.tags`,
      [
        id,
        createdAt,
        updatedAt,
        status,
        nullable(input.title),
        bodyEnc,
        messageDigest,
        nullable(input.channel),
        nullable(input.route),
        webhookEnc,
        nullable(input.link),
        tagsJson,
        // sentResponseId / sendError are owned by the send pipeline, not save().
        // On update they are preserved (omitted from the UPDATE SET clause); on
        // insert they default to NULL.
        null,
        null,
      ],
    );

    return { id, created };
  }

  /** List drafts, newest-updated first, optionally filtered by status. */
  list(query: DraftListQuery = {}): DraftRecord[] {
    const limit = clampLimit(query.limit);
    const rows =
      query.status !== undefined
        ? this.store.all<DraftRow>(
            `SELECT id, createdAt, updatedAt, status, title, messageDigest,
                    channel, route, webhookEnc, link, tags, sentResponseId, sendError
             FROM drafts WHERE status = ? ORDER BY updatedAt DESC, id ASC LIMIT ?`,
            [query.status, limit],
          )
        : this.store.all<DraftRow>(
            `SELECT id, createdAt, updatedAt, status, title, messageDigest,
                    channel, route, webhookEnc, link, tags, sentResponseId, sendError
             FROM drafts ORDER BY updatedAt DESC, id ASC LIMIT ?`,
            [limit],
          );
    return rows.map((row) => toRecord(row));
  }

  /** Fetch a single draft as a redacted record, or null when absent. */
  get(id: string): DraftRecord | null {
    const row = this.getRow(id);
    return row === null ? null : toRecord(row);
  }

  /** Delete a draft. Returns true when a row was removed. */
  delete(id: string): boolean {
    const existed = this.getRow(id) !== null;
    if (existed) {
      this.store.run('DELETE FROM drafts WHERE id = ?', [id]);
    }
    return existed;
  }

  private getRow(id: string): DraftRow | null {
    return this.store.get<DraftRow>(
      `SELECT id, createdAt, updatedAt, status, title, messageDigest,
              channel, route, webhookEnc, link, tags, sentResponseId, sendError
       FROM drafts WHERE id = ?`,
      [id],
    );
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_DRAFT_LIST_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  if (floored > MAX_DRAFT_LIST_LIMIT) return MAX_DRAFT_LIST_LIMIT;
  return floored;
}

function toRecord(row: DraftRow): DraftRecord {
  const record: DraftRecord = {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status as DraftStatus,
    messageDigest: row.messageDigest,
  };
  if (row.title !== null) record.title = row.title;
  if (row.channel !== null) record.channel = row.channel;
  if (row.route !== null) record.route = row.route;
  // Webhook is encrypted at rest; reads ALWAYS redact. Presence of webhookEnc
  // means a webhook exists → emit '[redacted]'; the raw URL never leaves here.
  const redacted = redactWebhook(row.webhookEnc ?? undefined);
  if (redacted !== undefined) record.webhook = redacted;
  if (row.link !== null) record.link = row.link;
  const tags = parseTags(row.tags);
  if (tags !== undefined) record.tags = tags;
  if (row.sentResponseId !== null) record.sentResponseId = row.sentResponseId;
  if (row.sendError !== null) record.sendError = row.sendError;
  return record;
}
