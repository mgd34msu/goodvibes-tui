import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { GitService } from '../../git/service.ts';

export type ManagedWorktreeState = 'active' | 'paused' | 'kept' | 'discard' | 'cleanup-pending';
export type ManagedWorktreeKind = 'agent' | 'orchestrator' | 'manual';

export interface ManagedWorktreeMeta {
  readonly path: string;
  readonly kind: ManagedWorktreeKind;
  readonly state: ManagedWorktreeState;
  readonly ownerId?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly updatedAt: number;
}

interface WorktreeStore {
  readonly version: 1;
  readonly records: Record<string, ManagedWorktreeMeta>;
}

export interface WorktreeStatusRecord extends ManagedWorktreeMeta {
  readonly branch: string;
  readonly head: string;
}

export interface WorktreeOwnershipSummary {
  readonly total: number;
  readonly active: number;
  readonly paused: number;
  readonly kept: number;
  readonly discard: number;
  readonly cleanupPending: number;
  readonly sessionAttached: number;
  readonly taskAttached: number;
  readonly agentOwned: number;
  readonly orchestratorOwned: number;
  readonly manualOwned: number;
}

export interface WorktreeAttachmentReview {
  readonly targetKind: 'session' | 'task';
  readonly targetId: string;
  readonly total: number;
  readonly active: number;
  readonly paused: number;
  readonly kept: number;
  readonly discard: number;
  readonly cleanupPending: number;
  readonly records: readonly ManagedWorktreeMeta[];
}

export interface WorktreeRegistryPaths {
  readonly workingDirectory: string;
}

function getStorePath(workingDirectory: string): string {
  return join(workingDirectory, '.goodvibes', 'tui', 'worktrees.json');
}

function defaultStore(): WorktreeStore {
  return { version: 1, records: {} };
}

function normalizePath(path: string, workingDirectory: string): string {
  return resolve(workingDirectory, path);
}

function readStore(workingDirectory: string): WorktreeStore {
  try {
    return JSON.parse(readFileSync(getStorePath(workingDirectory), 'utf-8')) as WorktreeStore;
  } catch {
    return defaultStore();
  }
}

export function listPersistedWorktreeMeta(options: WorktreeRegistryPaths): ManagedWorktreeMeta[] {
  return Object.values(readStore(options.workingDirectory).records).sort((a, b) => a.path.localeCompare(b.path));
}

export function getPersistedWorktreeMeta(path: string, options: WorktreeRegistryPaths): ManagedWorktreeMeta | null {
  const normalized = normalizePath(path, options.workingDirectory);
  return readStore(options.workingDirectory).records[normalized] ?? null;
}

export function reviewWorktreeAttachments(
  targetKind: 'session' | 'task',
  targetId: string,
  options: WorktreeRegistryPaths,
): WorktreeAttachmentReview {
  const records = listPersistedWorktreeMeta(options).filter((record) => (
    targetKind === 'session' ? record.sessionId === targetId : record.taskId === targetId
  ));
  return records.reduce<WorktreeAttachmentReview>((summary, record) => ({
    ...summary,
    total: summary.total + 1,
    active: summary.active + (record.state === 'active' ? 1 : 0),
    paused: summary.paused + (record.state === 'paused' ? 1 : 0),
    kept: summary.kept + (record.state === 'kept' ? 1 : 0),
    discard: summary.discard + (record.state === 'discard' ? 1 : 0),
    cleanupPending: summary.cleanupPending + (record.state === 'cleanup-pending' ? 1 : 0),
    records: [...summary.records, record],
  }), {
    targetKind,
    targetId,
    total: 0,
    active: 0,
    paused: 0,
    kept: 0,
    discard: 0,
    cleanupPending: 0,
    records: [],
  });
}

export function summarizeWorktreeOwnership(records: readonly ManagedWorktreeMeta[]): WorktreeOwnershipSummary {
  return records.reduce<WorktreeOwnershipSummary>((summary, record) => ({
    total: summary.total + 1,
    active: summary.active + (record.state === 'active' ? 1 : 0),
    paused: summary.paused + (record.state === 'paused' ? 1 : 0),
    kept: summary.kept + (record.state === 'kept' ? 1 : 0),
    discard: summary.discard + (record.state === 'discard' ? 1 : 0),
    cleanupPending: summary.cleanupPending + (record.state === 'cleanup-pending' ? 1 : 0),
    sessionAttached: summary.sessionAttached + (record.sessionId ? 1 : 0),
    taskAttached: summary.taskAttached + (record.taskId ? 1 : 0),
    agentOwned: summary.agentOwned + (record.kind === 'agent' ? 1 : 0),
    orchestratorOwned: summary.orchestratorOwned + (record.kind === 'orchestrator' ? 1 : 0),
    manualOwned: summary.manualOwned + (record.kind === 'manual' ? 1 : 0),
  }), {
    total: 0,
    active: 0,
    paused: 0,
    kept: 0,
    discard: 0,
    cleanupPending: 0,
    sessionAttached: 0,
    taskAttached: 0,
    agentOwned: 0,
    orchestratorOwned: 0,
    manualOwned: 0,
  });
}

function writeStore(store: WorktreeStore, workingDirectory: string): void {
  const storePath = getStorePath(workingDirectory);
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
}

function classifyWorktreePath(path: string, workingDirectory: string): Pick<ManagedWorktreeMeta, 'kind' | 'ownerId'> {
  const normalized = normalizePath(path, workingDirectory);
  const agentMatch = normalized.match(/[/\\]\.goodvibes[/\\]\.worktrees[/\\]agent-([^/\\]+)$/);
  if (agentMatch) {
    return { kind: 'agent', ownerId: agentMatch[1] };
  }
  if (normalized.includes(`${join('.goodvibes', '.worktrees')}`)) {
    return { kind: 'orchestrator' };
  }
  return { kind: 'manual' };
}

export class WorktreeRegistry {
  private readonly git: GitService;
  private readonly workingDirectory: string;

  public constructor(workingDirectory: string) {
    this.workingDirectory = workingDirectory;
    this.git = new GitService(workingDirectory);
  }

  public async list(): Promise<WorktreeStatusRecord[]> {
    const store = readStore(this.workingDirectory);
    const listed = await this.git.worktreeList();
    const present = new Set(listed.map((entry) => normalizePath(entry.path, this.workingDirectory)));
    const records: WorktreeStatusRecord[] = listed.map((entry) => {
      const path = normalizePath(entry.path, this.workingDirectory);
      const meta = store.records[path];
      const classified = classifyWorktreePath(path, this.workingDirectory);
      return {
        path,
        branch: entry.branch,
        head: entry.head,
        kind: meta?.kind ?? classified.kind,
        state: meta?.state ?? 'active',
        ...(meta?.ownerId ?? classified.ownerId ? { ownerId: meta?.ownerId ?? classified.ownerId } : {}),
        ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
        ...(meta?.taskId ? { taskId: meta.taskId } : {}),
        updatedAt: meta?.updatedAt ?? Date.now(),
      };
    });
    const nextRecords: Record<string, ManagedWorktreeMeta> = {};
    for (const record of records) {
      nextRecords[record.path] = {
        path: record.path,
        kind: record.kind,
        state: record.state,
        ...(record.ownerId ? { ownerId: record.ownerId } : {}),
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        ...(record.taskId ? { taskId: record.taskId } : {}),
        updatedAt: record.updatedAt,
      };
    }
    for (const [path, meta] of Object.entries(store.records)) {
      if (!present.has(path) && meta.state === 'kept') nextRecords[path] = meta;
    }
    writeStore({ version: 1, records: nextRecords }, this.workingDirectory);
    return records.sort((a, b) => a.path.localeCompare(b.path));
  }

  public attach(path: string, target: { sessionId?: string; taskId?: string }): void {
    const store = readStore(this.workingDirectory);
    const normalized = normalizePath(path, this.workingDirectory);
    const existing = store.records[normalized];
    const classified = classifyWorktreePath(normalized, this.workingDirectory);
    store.records[normalized] = {
      path: normalized,
      kind: existing?.kind ?? classified.kind,
      state: existing?.state ?? 'active',
      ...(existing?.ownerId ?? classified.ownerId ? { ownerId: existing?.ownerId ?? classified.ownerId } : {}),
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      ...(target.taskId ? { taskId: target.taskId } : {}),
      updatedAt: Date.now(),
    };
    writeStore(store, this.workingDirectory);
  }

  public setState(path: string, state: ManagedWorktreeState): void {
    const store = readStore(this.workingDirectory);
    const normalized = normalizePath(path, this.workingDirectory);
    const existing = store.records[normalized];
    const classified = classifyWorktreePath(normalized, this.workingDirectory);
    store.records[normalized] = {
      path: normalized,
      kind: existing?.kind ?? classified.kind,
      state,
      ...(existing?.ownerId ?? classified.ownerId ? { ownerId: existing?.ownerId ?? classified.ownerId } : {}),
      ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}),
      ...(existing?.taskId ? { taskId: existing.taskId } : {}),
      updatedAt: Date.now(),
    };
    writeStore(store, this.workingDirectory);
  }

  public async cleanup(path: string): Promise<void> {
    const normalized = isAbsolute(path) ? path : normalizePath(path, this.workingDirectory);
    await this.git.worktreeRemove(normalized);
    const store = readStore(this.workingDirectory);
    delete store.records[normalized];
    writeStore(store, this.workingDirectory);
  }
}
