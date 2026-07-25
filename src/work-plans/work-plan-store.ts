// ---------------------------------------------------------------------------
// work-plan-store.ts — per-project work plan persisted at
//   <home>/.goodvibes/tui/work-plans/<projectId>.json
//
// Recovery discipline (applies to every read):
//
//  * CONTENT, NOT EXISTENCE, decides whether the file is usable. A plan file
//    can exist and still be unusable — zero-byte, truncated mid-write, or
//    otherwise torn by a crash. Every read parses defensively and validates the
//    parsed SHAPE; an unusable file degrades to an empty plan instead of
//    throwing out of the store's public methods (which used to brick every
//    /work-plan operation until the user deleted the file by hand).
//  * AN UNREADABLE FILE IS PRESERVED, NOT OVERWRITTEN. It is renamed aside to
//    `<plan>.json.corrupt-<ms>-<rand>` so a user can still recover their list.
//    Those quarantine copies are themselves bounded (age TTL + count cap) so
//    the recovery path cannot become its own leak.
//  * THE STORE IS BOUNDED. Terminal (done/cancelled) items age out and are
//    capped by count. Items the user still has open — pending, in_progress,
//    blocked, failed — are NEVER reclaimed by either bound: garbage collection
//    must not delete live work.
//  * NOTHING IS DELETED SILENTLY. Whatever a sweep reclaimed is recorded on the
//    plan as `housekeeping` and rendered by `toMarkdown()` (which /work-plan
//    show prints), so a reclaim is distinguishable from data loss.
//
// Sweeps are idempotent and safe to run from more than one process: removal is
// computed from the file's own contents, writes go through atomicWriteFileSync
// (rename(2)), and unlink races are treated as already-done.
// ---------------------------------------------------------------------------

import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { atomicWriteFileSync } from '@/config/atomic-write.ts';
import { basename, dirname, join } from 'node:path';

/**
 * Age TTL for TERMINAL (done/cancelled) items. Once a completed or cancelled
 * item has been untouched this long it is reclaimed by the next read. Chosen to
 * comfortably outlive "I finished that last month and want to see it" while
 * still bounding a plan that is never manually cleared.
 */
export const WORK_PLAN_TERMINAL_ITEM_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Count cap for TERMINAL (done/cancelled) items: the most recently completed
 * this many are kept, older ones are reclaimed oldest-first. Live items are
 * neither counted against this cap nor removed by it.
 */
export const WORK_PLAN_TERMINAL_ITEM_CAP = 200;

/** Age TTL for quarantined (unreadable) plan files — the recovery copy's own bound. */
export const WORK_PLAN_QUARANTINE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/** Count cap for quarantined plan files kept alongside one plan; oldest go first. */
export const WORK_PLAN_QUARANTINE_CAP = 5;

/**
 * Minimum gap between quarantine-directory scans for one store instance. The
 * item bounds are evaluated on every read (they are a pure pass over in-memory
 * items); the directory scan is throttled so a redrawing modal cannot turn it
 * into a per-frame readdir. This is what makes the sweep periodic rather than
 * startup-only: a long-lived session keeps sweeping on this cadence.
 */
export const WORK_PLAN_QUARANTINE_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Filename marker for a preserved copy of a plan file that could not be parsed. */
const QUARANTINE_SUFFIX = '.corrupt-';

export const WORK_PLAN_STATUSES = [
  'pending',
  'in_progress',
  'blocked',
  'done',
  'failed',
  'cancelled',
] as const;

export type WorkPlanItemStatus = typeof WORK_PLAN_STATUSES[number];

export interface WorkPlanLinkTargets {
  readonly agentId?: string;
  readonly wrfcId?: string;
  readonly taskId?: string;
  readonly sessionId?: string;
}

export interface WorkPlanItem {
  readonly id: string;
  readonly title: string;
  readonly status: WorkPlanItemStatus;
  readonly owner?: string;
  readonly source?: string;
  readonly notes?: string;
  readonly linked?: WorkPlanLinkTargets;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

/**
 * What the last recovery/bounding sweep reclaimed. Persisted with the plan and
 * rendered by `toMarkdown()` so a removal is always disclosed — counts and
 * paths only, never item text.
 */
export interface WorkPlanHousekeeping {
  /** Unix ms of the sweep that produced these counts. */
  readonly at: number;
  /** Terminal items reclaimed by the age TTL. */
  readonly expiredItems: number;
  /** Terminal items reclaimed by the count cap. */
  readonly cappedItems: number;
  /** True when the plan file on disk could not be parsed and the plan was reset. */
  readonly resetFromUnreadableFile?: boolean;
  /** Where the unreadable file was preserved, when there was content worth keeping. */
  readonly quarantinePath?: string;
  /** Quarantined files removed by their own TTL / count cap. */
  readonly quarantinesRemoved?: number;
}

export interface WorkPlan {
  readonly id: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly title: string;
  readonly items: readonly WorkPlanItem[];
  readonly activeItemId?: string;
  readonly source?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Result of the most recent sweep that actually reclaimed something. */
  readonly housekeeping?: WorkPlanHousekeeping;
}

export interface WorkPlanStoreOptions {
  readonly homeDirectory: string;
  readonly projectId: string;
  readonly projectRoot: string;
}

export interface AddWorkPlanItemOptions {
  readonly status?: WorkPlanItemStatus;
  readonly owner?: string;
  readonly source?: string;
  readonly notes?: string;
  readonly linked?: WorkPlanLinkTargets;
}

export interface UpdateWorkPlanItemPatch {
  readonly title?: string;
  readonly status?: WorkPlanItemStatus;
  readonly owner?: string | null;
  readonly source?: string | null;
  readonly notes?: string | null;
  readonly linked?: WorkPlanLinkTargets | null;
}

function nowMs(): number {
  return Date.now();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function isWorkPlanStatus(value: unknown): value is WorkPlanItemStatus {
  return typeof value === 'string' && WORK_PLAN_STATUSES.includes(value as WorkPlanItemStatus);
}

function safeFileId(projectId: string, projectRoot: string): string {
  const normalized = projectId.trim() || 'project';
  const safe = normalized.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  if (safe.length > 0 && safe.length <= 96) return safe;
  const hash = createHash('sha256').update(`${projectId}\0${projectRoot}`).digest('hex').slice(0, 16);
  return `${safe.slice(0, 80) || 'project'}-${hash}`;
}

function createPlanId(projectId: string, projectRoot: string): string {
  const hash = createHash('sha256').update(`${projectId}\0${projectRoot}`).digest('hex').slice(0, 12);
  return `wp-${hash}`;
}

function createItemId(): string {
  return `wpi-${randomUUID().slice(0, 8)}`;
}

function normalizeLinked(value: unknown): WorkPlanLinkTargets | undefined {
  if (!isObject(value)) return undefined;
  const agentId = readString(value.agentId);
  const wrfcId = readString(value.wrfcId);
  const taskId = readString(value.taskId);
  const sessionId = readString(value.sessionId);
  const linked: WorkPlanLinkTargets = {
    ...(agentId ? { agentId } : {}),
    ...(wrfcId ? { wrfcId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
  return Object.keys(linked).length > 0 ? linked : undefined;
}

function normalizeItem(value: unknown, fallbackCreatedAt: number): WorkPlanItem | null {
  if (!isObject(value)) return null;
  const title = readString(value.title);
  if (!title) return null;
  const status = isWorkPlanStatus(value.status) ? value.status : 'pending';
  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : fallbackCreatedAt;
  const updatedAt = typeof value.updatedAt === 'number' ? value.updatedAt : createdAt;
  const completedAt = typeof value.completedAt === 'number' ? value.completedAt : undefined;
  const owner = readString(value.owner);
  const source = readString(value.source);
  const notes = readString(value.notes);
  const linked = normalizeLinked(value.linked);
  return {
    id: readString(value.id) ?? createItemId(),
    title,
    status,
    ...(owner ? { owner } : {}),
    ...(source ? { source } : {}),
    ...(notes ? { notes } : {}),
    ...(linked ? { linked } : {}),
    createdAt,
    updatedAt,
    ...(completedAt !== undefined ? { completedAt } : {}),
  };
}

function formatStatus(status: WorkPlanItemStatus): string {
  return status.replace(/_/g, ' ');
}

/**
 * Terminal = the user is done with it. Only these two statuses are eligible for
 * the age TTL and the count cap. `blocked` and `failed` still need attention and
 * `pending`/`in_progress` are live, so none of them are ever auto-reclaimed.
 */
function isTerminalStatus(status: WorkPlanItemStatus): boolean {
  return status === 'done' || status === 'cancelled';
}

/** The timestamp a terminal item is aged from. */
function terminalAgeStamp(item: WorkPlanItem): number {
  return item.completedAt ?? item.updatedAt ?? item.createdAt;
}

function normalizeHousekeeping(value: unknown): WorkPlanHousekeeping | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.at !== 'number') return undefined;
  const expiredItems = typeof value.expiredItems === 'number' ? value.expiredItems : 0;
  const cappedItems = typeof value.cappedItems === 'number' ? value.cappedItems : 0;
  const quarantinePath = readString(value.quarantinePath);
  const quarantinesRemoved = typeof value.quarantinesRemoved === 'number' ? value.quarantinesRemoved : undefined;
  return {
    at: value.at,
    expiredItems,
    cappedItems,
    ...(value.resetFromUnreadableFile === true ? { resetFromUnreadableFile: true } : {}),
    ...(quarantinePath ? { quarantinePath } : {}),
    ...(quarantinesRemoved !== undefined ? { quarantinesRemoved } : {}),
  };
}

/**
 * Parse a plan file's CONTENT. Returns null for anything that is not a JSON
 * object — empty/whitespace-only (a zero-byte file left by a crash), truncated
 * JSON, or a valid JSON scalar/array. Never throws.
 */
function parsePlanDocument(raw: string): Record<string, unknown> | null {
  if (raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  return isObject(parsed) ? parsed : null;
}

/** One-line, content-free disclosure of what the last sweep reclaimed. */
function formatHousekeeping(record: WorkPlanHousekeeping): string {
  const parts: string[] = [];
  if (record.resetFromUnreadableFile) {
    parts.push(record.quarantinePath
      ? `the previous plan file could not be read and was preserved at ${record.quarantinePath}`
      : 'the previous plan file was empty or unreadable and was reset');
  }
  if (record.expiredItems > 0) parts.push(`${record.expiredItems} completed item(s) aged out`);
  if (record.cappedItems > 0) parts.push(`${record.cappedItems} completed item(s) over the retention cap removed`);
  if (record.quarantinesRemoved && record.quarantinesRemoved > 0) {
    parts.push(`${record.quarantinesRemoved} old quarantined plan file(s) deleted`);
  }
  if (parts.length === 0) parts.push('nothing reclaimed');
  return `Housekeeping (${new Date(record.at).toISOString()}): ${parts.join('; ')}.`;
}

export function nextWorkPlanStatus(status: WorkPlanItemStatus): WorkPlanItemStatus {
  switch (status) {
    case 'pending':
      return 'in_progress';
    case 'in_progress':
      return 'done';
    case 'done':
      return 'pending';
    case 'blocked':
    case 'failed':
    case 'cancelled':
      return 'pending';
  }
}

export class WorkPlanStore {
  readonly filePath: string;

  /**
   * Unix ms of this instance's last quarantine-directory scan. Zero means the
   * first read of the session sweeps — that read IS the recovery point.
   */
  private lastQuarantineSweepAt = 0;

  constructor(private readonly options: WorkPlanStoreOptions) {
    const fileName = `${safeFileId(options.projectId, options.projectRoot)}.json`;
    this.filePath = join(options.homeDirectory, '.goodvibes', 'tui', 'work-plans', fileName);
  }

  getActivePlan(): WorkPlan {
    return this.readPlan();
  }

  listItems(): readonly WorkPlanItem[] {
    return this.getActivePlan().items;
  }

  addItem(title: string, options: AddWorkPlanItemOptions = {}): WorkPlanItem {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) throw new Error('Work plan item title is required.');
    const plan = this.readPlan();
    const time = nowMs();
    const item: WorkPlanItem = {
      id: createItemId(),
      title: normalizedTitle,
      status: options.status ?? 'pending',
      ...(options.owner ? { owner: options.owner } : {}),
      ...(options.source ? { source: options.source } : {}),
      ...(options.notes ? { notes: options.notes } : {}),
      ...(options.linked ? { linked: options.linked } : {}),
      createdAt: time,
      updatedAt: time,
      ...(options.status === 'done' ? { completedAt: time } : {}),
    };
    this.writePlan({
      ...plan,
      items: [...plan.items, item],
      activeItemId: item.id,
      updatedAt: time,
    });
    return item;
  }

  updateItem(idOrPrefix: string, patch: UpdateWorkPlanItemPatch): WorkPlanItem {
    const plan = this.readPlan();
    const item = this.resolveItem(plan, idOrPrefix);
    const time = nowMs();
    const nextStatus = patch.status ?? item.status;
    const next: WorkPlanItem = this.pruneItem({
      ...item,
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      status: nextStatus,
      ...(patch.owner !== undefined ? { owner: patch.owner || undefined } : {}),
      ...(patch.source !== undefined ? { source: patch.source || undefined } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes || undefined } : {}),
      ...(patch.linked !== undefined ? { linked: patch.linked || undefined } : {}),
      updatedAt: time,
      ...(nextStatus === 'done' ? { completedAt: item.completedAt ?? time } : { completedAt: undefined }),
    });
    if (!next.title) throw new Error('Work plan item title is required.');
    this.writePlan({
      ...plan,
      items: plan.items.map((candidate) => candidate.id === item.id ? next : candidate),
      activeItemId: next.id,
      updatedAt: time,
    });
    return next;
  }

  setItemStatus(idOrPrefix: string, status: WorkPlanItemStatus): WorkPlanItem {
    return this.updateItem(idOrPrefix, { status });
  }

  cycleItemStatus(idOrPrefix: string): WorkPlanItem {
    const item = this.resolveItem(this.readPlan(), idOrPrefix);
    return this.setItemStatus(item.id, nextWorkPlanStatus(item.status));
  }

  removeItem(idOrPrefix: string): WorkPlanItem {
    const plan = this.readPlan();
    const item = this.resolveItem(plan, idOrPrefix);
    const time = nowMs();
    const remaining = plan.items.filter((candidate) => candidate.id !== item.id);
    this.writePlan({
      ...plan,
      items: remaining,
      activeItemId: remaining[0]?.id,
      updatedAt: time,
    });
    return item;
  }

  clearCompleted(): number {
    const plan = this.readPlan();
    const remaining = plan.items.filter((item) => item.status !== 'done' && item.status !== 'cancelled');
    const removed = plan.items.length - remaining.length;
    if (removed === 0) return 0;
    this.writePlan({
      ...plan,
      items: remaining,
      activeItemId: remaining[0]?.id,
      updatedAt: nowMs(),
    });
    return removed;
  }

  /**
   * Writes the current plan's `toMarkdown()` output to a sibling `.md` file
   * next to the JSON store file, so the checklist can be opened outside the
   * TUI. Returns the written path alongside the markdown that was written.
   */
  exportMarkdown(): { readonly path: string; readonly markdown: string } {
    const plan = this.readPlan();
    const markdown = this.toMarkdown(plan);
    const path = this.filePath.replace(/\.json$/, '.md');
    atomicWriteFileSync(path, `${markdown}\n`, { mkdirp: true });
    return { path, markdown };
  }

  toMarkdown(plan: WorkPlan = this.readPlan()): string {
    const lines = [
      `# ${plan.title}`,
      '',
      `Project: ${plan.projectRoot}`,
      `Project ID: ${plan.projectId}`,
      `Updated: ${new Date(plan.updatedAt).toISOString()}`,
    ];
    // Disclosure: whatever the last sweep reclaimed is stated here, so a
    // removal can never be mistaken for silent data loss.
    if (plan.housekeeping) lines.push(formatHousekeeping(plan.housekeeping));
    lines.push('');
    if (plan.items.length === 0) {
      lines.push('No work plan items recorded.');
      return lines.join('\n');
    }
    for (const item of plan.items) {
      const marker = item.status === 'done' ? 'x' : ' ';
      const suffix = item.status === 'pending' ? '' : ` (${formatStatus(item.status)})`;
      lines.push(`- [${marker}] ${item.title}${suffix}`);
      if (item.owner) lines.push(`  - Owner: ${item.owner}`);
      if (item.source) lines.push(`  - Source: ${item.source}`);
      if (item.notes) lines.push(`  - Notes: ${item.notes}`);
    }
    return lines.join('\n');
  }

  /**
   * The plan as callers see it: loaded from disk (content-validated), then put
   * through the recovery/bounding sweep. When the sweep reclaimed anything the
   * bounded plan — carrying its housekeeping disclosure — is written back
   * immediately, so the disclosure survives even if the caller only reads.
   */
  private readPlan(): WorkPlan {
    const loaded = this.loadFromDisk();
    const swept = this.sweep(loaded.plan, loaded.recovery);
    if (swept.changed) this.writePlan(swept.plan);
    return swept.plan;
  }

  /**
   * Read and validate the plan file's CONTENT. A missing file is the ordinary
   * empty case. A file that exists but does not parse into a plan object is
   * moved aside (never overwritten in place) and reported as a recovery.
   */
  private loadFromDisk(): { plan: WorkPlan; recovery: WorkPlanHousekeeping | null } {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      // No file yet (the common first-run case), or it is unreadable right now.
      // Nothing existed to preserve, so there is nothing to disclose.
      return { plan: this.createEmptyPlan(), recovery: null };
    }
    const parsed = parsePlanDocument(raw);
    if (parsed === null) {
      // The file EXISTED but its contents are not a usable plan: zero-byte,
      // truncated mid-write, or otherwise torn. Existence is not validity.
      const quarantinePath = raw.trim().length > 0 ? this.quarantineUnreadableFile() : undefined;
      return {
        plan: this.createEmptyPlan(),
        recovery: {
          at: nowMs(),
          expiredItems: 0,
          cappedItems: 0,
          resetFromUnreadableFile: true,
          ...(quarantinePath ? { quarantinePath } : {}),
        },
      };
    }
    const time = nowMs();
    const createdAt = typeof parsed.createdAt === 'number' ? parsed.createdAt : time;
    const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : createdAt;
    const items = Array.isArray(parsed.items)
      ? parsed.items.map((item) => normalizeItem(item, createdAt)).filter((item): item is WorkPlanItem => item !== null)
      : [];
    const activeItemId = readString(parsed.activeItemId);
    const source = readString(parsed.source);
    const housekeeping = normalizeHousekeeping(parsed.housekeeping);
    return {
      plan: {
        id: readString(parsed.id) ?? createPlanId(this.options.projectId, this.options.projectRoot),
        projectId: readString(parsed.projectId) ?? this.options.projectId,
        projectRoot: readString(parsed.projectRoot) ?? this.options.projectRoot,
        title: readString(parsed.title) ?? 'Work Plan',
        items,
        ...(activeItemId && items.some((item) => item.id === activeItemId) ? { activeItemId } : {}),
        ...(source ? { source } : {}),
        createdAt,
        updatedAt,
        ...(housekeeping ? { housekeeping } : {}),
      },
      recovery: null,
    };
  }

  /**
   * Apply both bounds (age TTL, then count cap) over TERMINAL items only, plus
   * the throttled quarantine-file sweep. Pure with respect to disk except for
   * quarantine deletions; the caller persists the result when `changed`.
   *
   * Idempotent: re-running it on the returned plan reclaims nothing further,
   * which is what makes it safe to run concurrently from several processes.
   */
  private sweep(
    plan: WorkPlan,
    recovery: WorkPlanHousekeeping | null,
  ): { plan: WorkPlan; changed: boolean } {
    const now = nowMs();
    const expired = new Set<WorkPlanItem>();
    for (const item of plan.items) {
      if (!isTerminalStatus(item.status)) continue;
      if (now - terminalAgeStamp(item) > WORK_PLAN_TERMINAL_ITEM_TTL_MS) expired.add(item);
    }
    const survivors = plan.items.filter((item) => !expired.has(item));
    // Count cap applies to terminal survivors only — newest completions kept.
    const terminalSurvivors = survivors
      .filter((item) => isTerminalStatus(item.status))
      .sort((a, b) => terminalAgeStamp(b) - terminalAgeStamp(a));
    const capped = new Set<WorkPlanItem>(terminalSurvivors.slice(WORK_PLAN_TERMINAL_ITEM_CAP));
    const kept = survivors.filter((item) => !capped.has(item));
    const quarantinesRemoved = this.sweepQuarantines(now);

    const changed = expired.size > 0 || capped.size > 0 || recovery !== null || quarantinesRemoved > 0;
    if (!changed) return { plan, changed: false };

    const housekeeping: WorkPlanHousekeeping = {
      at: now,
      expiredItems: expired.size,
      cappedItems: capped.size,
      ...(recovery?.resetFromUnreadableFile ? { resetFromUnreadableFile: true } : {}),
      ...(recovery?.quarantinePath ? { quarantinePath: recovery.quarantinePath } : {}),
      ...(quarantinesRemoved > 0 ? { quarantinesRemoved } : {}),
    };
    const activeItemId = plan.activeItemId && kept.some((item) => item.id === plan.activeItemId)
      ? plan.activeItemId
      : undefined;
    return {
      plan: {
        id: plan.id,
        projectId: plan.projectId,
        projectRoot: plan.projectRoot,
        title: plan.title,
        items: kept,
        ...(activeItemId ? { activeItemId } : {}),
        ...(plan.source ? { source: plan.source } : {}),
        createdAt: plan.createdAt,
        // `updatedAt` tracks the user's edits; a garbage-collection pass is not
        // one, so it is deliberately left alone. housekeeping.at dates the sweep.
        updatedAt: plan.updatedAt,
        housekeeping,
      },
      changed: true,
    };
  }

  /**
   * Move an unparseable plan file aside so the user can still recover it.
   * Returns the quarantine path, or undefined if the rename did not happen
   * (already moved by a concurrent process, or the directory is not writable).
   */
  private quarantineUnreadableFile(): string | undefined {
    const target = `${this.filePath}${QUARANTINE_SUFFIX}${nowMs()}-${randomUUID().slice(0, 8)}`;
    try {
      renameSync(this.filePath, target);
      return target;
    } catch {
      // Gone already (another process quarantined it first) or unwritable —
      // either way the plan still degrades to empty rather than throwing.
      return undefined;
    }
  }

  /**
   * Bound the quarantine copies: delete any past WORK_PLAN_QUARANTINE_TTL_MS
   * and any beyond WORK_PLAN_QUARANTINE_CAP (oldest first). Throttled to
   * WORK_PLAN_QUARANTINE_SWEEP_INTERVAL_MS per store instance so a long-lived
   * session keeps sweeping without scanning the directory on every read.
   */
  private sweepQuarantines(now: number): number {
    if (now - this.lastQuarantineSweepAt < WORK_PLAN_QUARANTINE_SWEEP_INTERVAL_MS) return 0;
    this.lastQuarantineSweepAt = now;
    const directory = dirname(this.filePath);
    const prefix = `${basename(this.filePath)}${QUARANTINE_SUFFIX}`;
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return 0;
    }
    const candidates = entries
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => {
        const stamp = Number.parseInt(entry.slice(prefix.length).split('-')[0] ?? '', 10);
        return { entry, at: Number.isFinite(stamp) ? stamp : 0 };
      })
      .sort((a, b) => b.at - a.at); // newest first
    let removed = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      const tooOld = now - candidate.at > WORK_PLAN_QUARANTINE_TTL_MS;
      const overCap = index >= WORK_PLAN_QUARANTINE_CAP;
      if (!tooOld && !overCap) continue;
      try {
        unlinkSync(join(directory, candidate.entry));
        removed += 1;
      } catch {
        // Already removed by a concurrent sweep — idempotent, not an error, and
        // not counted so the disclosed number stays truthful.
      }
    }
    return removed;
  }

  private createEmptyPlan(): WorkPlan {
    const time = nowMs();
    return {
      id: createPlanId(this.options.projectId, this.options.projectRoot),
      projectId: this.options.projectId,
      projectRoot: this.options.projectRoot,
      title: 'Work Plan',
      items: [],
      source: 'tui',
      createdAt: time,
      updatedAt: time,
    };
  }

  private writePlan(plan: WorkPlan): void {
    atomicWriteFileSync(this.filePath, `${JSON.stringify(plan, null, 2)}\n`, { mkdirp: true });
  }

  private resolveItem(plan: WorkPlan, idOrPrefix: string): WorkPlanItem {
    const needle = idOrPrefix.trim();
    if (!needle) throw new Error('Work plan item id is required.');
    const exact = plan.items.find((item) => item.id === needle);
    if (exact) return exact;
    const matches = plan.items.filter((item) => item.id.startsWith(needle));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(`Work plan item id "${needle}" is ambiguous: ${matches.map((item) => item.id).join(', ')}`);
    }
    throw new Error(`Work plan item not found: ${needle}`);
  }

  private pruneItem(item: WorkPlanItem & {
    owner?: string | undefined;
    source?: string | undefined;
    notes?: string | undefined;
    linked?: WorkPlanLinkTargets | undefined;
    completedAt?: number | undefined;
  }): WorkPlanItem {
    return {
      id: item.id,
      title: item.title,
      status: item.status,
      ...(item.owner ? { owner: item.owner } : {}),
      ...(item.source ? { source: item.source } : {}),
      ...(item.notes ? { notes: item.notes } : {}),
      ...(item.linked ? { linked: item.linked } : {}),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      ...(item.completedAt !== undefined ? { completedAt: item.completedAt } : {}),
    };
  }
}
