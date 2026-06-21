// ---------------------------------------------------------------------------
// Daemon-internal triage PIPELINE.
//
// runInboxTriage(items): scores each inbound item (scorer.ts) and writes the
// resulting triageScore/triageTags back into the inbox triage store so that a
// later channels.inbox.list response can surface pre-scored items.
//
// The inbox surface owns the authoritative cursor-store and exposes
// triageScore/triageTags columns. To stay strictly within the triage handler
// surface, this pipeline persists into a dedicated, co-located
// HandlerSqliteStore ('inbox-triage.sqlite') keyed by item id. The inbox
// surface reads these rows by id when assembling its list response (the
// integration decorator does exactly that). The schema mirrors the agreed
// columns: triageScore REAL, triageTags TEXT (JSON array).
// ---------------------------------------------------------------------------

import { HandlerSqliteStore } from '../sqlite-store.ts';
import type { HandlerContext } from '../context.ts';
import type { InboundChannelItem, TriageLabel } from './types.ts';
import {
  labelToTag,
  scoreInboundItem,
  type TriageScore,
  type TriageScorerOptions,
} from './scorer.ts';

export const TRIAGE_STORE_FILE = 'inbox-triage.sqlite';

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS inbox_triage (
     id TEXT PRIMARY KEY,
     surface TEXT NOT NULL,
     triageScore REAL NOT NULL,
     triageLabel TEXT NOT NULL,
     triageTags TEXT NOT NULL,
     spamSignal REAL NOT NULL,
     prioritySignal REAL NOT NULL,
     updatedAt TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_inbox_triage_label ON inbox_triage (triageLabel)`,
  `CREATE INDEX IF NOT EXISTS idx_inbox_triage_surface ON inbox_triage (surface)`,
];

export interface TriageMetadata {
  triageScore: number;
  triageLabel: TriageLabel;
  triageTags: string[];
  signals: TriageScore['signals'];
}

export interface TriagedItem extends InboundChannelItem {
  triage: TriageMetadata;
}

export interface RunInboxTriageOptions {
  scorer?: TriageScorerOptions;
  /** Inject a store (tests). When omitted, a triage store is opened/closed. */
  store?: HandlerSqliteStore;
  /** When true, do not persist — only compute (used by inbox.triage.list). */
  dryRun?: boolean;
  /** Clock injection for deterministic updatedAt in tests. */
  now?: () => Date;
}

export interface RunInboxTriageResult {
  items: TriagedItem[];
  scored: number;
  persisted: number;
}

function toMetadata(score: TriageScore): TriageMetadata {
  return {
    triageScore: score.score,
    triageLabel: score.label,
    triageTags: [labelToTag(score.label)],
    signals: score.signals,
  };
}

/**
 * Open the triage store for this working directory. Caller owns close()/save()
 * when they pass their own store; otherwise runInboxTriage manages lifecycle.
 */
export function createTriageStore(workingDirectory: string): HandlerSqliteStore {
  return new HandlerSqliteStore({
    workingDirectory,
    fileName: TRIAGE_STORE_FILE,
    schema: SCHEMA,
  });
}

function persistRow(
  store: HandlerSqliteStore,
  item: InboundChannelItem,
  meta: TriageMetadata,
  updatedAt: string,
): void {
  store.run(
    `INSERT INTO inbox_triage
       (id, surface, triageScore, triageLabel, triageTags, spamSignal, prioritySignal, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       surface = excluded.surface,
       triageScore = excluded.triageScore,
       triageLabel = excluded.triageLabel,
       triageTags = excluded.triageTags,
       spamSignal = excluded.spamSignal,
       prioritySignal = excluded.prioritySignal,
       updatedAt = excluded.updatedAt`,
    [
      item.id,
      item.surface,
      meta.triageScore,
      meta.triageLabel,
      JSON.stringify(meta.triageTags),
      meta.signals.spam,
      meta.signals.priority,
      updatedAt,
    ],
  );
}

/**
 * Score every item and (unless dryRun) persist triageScore/triageTags back into
 * the inbox triage store. Returns each item enriched with triage metadata so
 * the caller can surface it without a second read.
 *
 * Called by the inbox poller (Responsibility 1) after each poll.
 */
export async function runInboxTriage(
  items: readonly InboundChannelItem[],
  ctx: HandlerContext,
  options: RunInboxTriageOptions = {},
): Promise<RunInboxTriageResult> {
  const now = options.now ?? (() => new Date());
  const updatedAt = now().toISOString();

  const enriched: TriagedItem[] = items.map((item) => {
    const score = scoreInboundItem(item, options.scorer);
    return { ...item, triage: toMetadata(score) };
  });

  if (options.dryRun || enriched.length === 0) {
    return { items: enriched, scored: enriched.length, persisted: 0 };
  }

  const ownsStore = !options.store;
  const store = options.store ?? createTriageStore(ctx.workingDirectory);
  let persisted = 0;
  try {
    if (ownsStore) await store.init();
    store.transaction(() => {
      for (const item of enriched) {
        persistRow(store, item, item.triage, updatedAt);
        persisted += 1;
      }
    });
    if (ownsStore) await store.save();
  } catch (error) {
    ctx.logger.error('triage: failed to persist scores', {
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (ownsStore) store.close();
  }

  return { items: enriched, scored: enriched.length, persisted };
}

/** Optional persisted triage metadata overlaid onto an inbound item. */
export interface TriageOverlay {
  triageScore?: number;
  triageTags?: string[];
  triageLabel?: TriageLabel;
}

/** An inbound item overlaid with optional persisted triage metadata. */
export type TriageEnrichedItem = InboundChannelItem & TriageOverlay;

function rowToMetadata(row: Omit<TriageRow, 'id'>): TriageMetadata {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.triageTags) as unknown;
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    tags = [];
  }
  return {
    triageScore: row.triageScore,
    triageLabel: row.triageLabel as TriageLabel,
    triageTags: tags,
    signals: { spam: row.spamSignal, priority: row.prioritySignal },
  };
}

interface TriageRow {
  id: string;
  triageScore: number;
  triageLabel: string;
  triageTags: string;
  spamSignal: number;
  prioritySignal: number;
}

/**
 * Read persisted triage rows for many item ids in a single `WHERE id IN (...)`
 * query. Returns a Map keyed by item id; ids without a stored row are absent.
 * De-duplicates ids so the placeholder list stays minimal.
 */
export function readTriageMetadataBatch(
  store: HandlerSqliteStore,
  itemIds: readonly string[],
): Map<string, TriageMetadata> {
  const out = new Map<string, TriageMetadata>();
  const uniqueIds = [...new Set(itemIds)];
  if (uniqueIds.length === 0) return out;
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = store.all<TriageRow>(
    `SELECT id, triageScore, triageLabel, triageTags, spamSignal, prioritySignal
       FROM inbox_triage WHERE id IN (${placeholders})`,
    uniqueIds,
  );
  for (const row of rows) {
    out.set(row.id, rowToMetadata(row));
  }
  return out;
}

/** Read a single persisted triage row by item id (used by the inbox surface). */
export function readTriageMetadata(
  store: HandlerSqliteStore,
  itemId: string,
): TriageMetadata | null {
  const row = store.get<Omit<TriageRow, 'id'>>(
    `SELECT triageScore, triageLabel, triageTags, spamSignal, prioritySignal
       FROM inbox_triage WHERE id = ?`,
    [itemId],
  );
  if (!row) return null;
  return rowToMetadata(row);
}

/**
 * Merge persisted triage metadata onto a batch of inbound items by id. This is
 * the exact glue `channels.inbox.list` invokes to surface pre-scored items: the
 * inbox surface lists from its cursor store, then calls this to overlay the
 * triageScore/triageTags columns the contract promises. Items without a stored
 * triage row pass through untouched, so an un-scored feed degrades gracefully.
 */
export function enrichItemsWithTriage<T extends { id: string }>(
  store: HandlerSqliteStore,
  items: readonly T[],
): Array<T & TriageOverlay> {
  if (items.length === 0) return [];
  // Single batched read (`WHERE id IN (...)`) instead of one SELECT per item —
  // this is a hot read path (every channels.inbox.list call), so the N+1 is
  // collapsed to one query keyed by id.
  const byId = readTriageMetadataBatch(
    store,
    items.map((item) => item.id),
  );
  return items.map((item) => {
    const meta = byId.get(item.id);
    if (!meta) return { ...item };
    return {
      ...item,
      triageScore: meta.triageScore,
      triageLabel: meta.triageLabel,
      triageTags: meta.triageTags,
    };
  });
}
