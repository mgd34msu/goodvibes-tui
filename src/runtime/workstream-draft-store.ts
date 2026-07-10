// ---------------------------------------------------------------------------
// workstream-draft-store.ts — durable journal for not-yet-launched proposals
//
// A /workstream proposal (WorkstreamDraft, workstream-services.ts) is TUI-owned
// state the OrchestrationEngine has no concept of — its only creation entry
// point materializes a real, ticking workstream with no pre-launch "draft"
// stage (see that module's REALITY-WINS header). Earlier waves therefore held
// drafts in memory only, and a restart between create and launch silently lost
// them. This store journals each draft to disk so the plan-review gate survives
// a restart and is resumable: the same reshaped, approved proposal is still
// there to launch afterward.
//
// This is TUI-side persistence, NOT an engine feature — it sits ALONGSIDE the
// engine's own .goodvibes/orchestration/<id>.json workstream snapshots, under a
// drafts/ subdirectory, and is loaded by the command facade at construction the
// same way the engine's resumeAllFromDisk() reloads live workstreams. A draft
// is a pure-data object (id/task/spec/gate/proposal/provenance/approved), so a
// plain JSON round-trip is lossless.
//
// Every operation is guarded and NEVER throws: a missing directory, an
// unreadable or malformed file, or a write failure degrades to "that draft
// isn't there" rather than crashing session startup — mirroring the engine
// persistence layer's own quarantine-don't-propagate discipline.
// ---------------------------------------------------------------------------

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkstreamDraft } from './workstream-draft-types.ts';

export interface WorkstreamDraftStore {
  /** Every valid draft on disk, oldest first. A directory that doesn't exist yet ⇒ []. Malformed files are skipped, never fatal. */
  loadAll(): WorkstreamDraft[];
  /** Write (or overwrite) one draft's snapshot. Silently no-ops on any I/O failure — a lost journal write must never break the in-memory flow. */
  save(draft: WorkstreamDraft): void;
  /** Delete one draft's snapshot (on launch or cancel). Missing file ⇒ no-op. */
  remove(id: string): void;
}

/** Draft ids are `wsd_<hex>`; this refuses anything else so a crafted id can never escape the drafts directory. */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function isDraftShape(value: unknown): value is WorkstreamDraft {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.id === 'string'
    && typeof d.task === 'string'
    && typeof d.approved === 'boolean'
    && typeof d.createdAt === 'number'
    && typeof d.spec === 'object' && d.spec !== null
    && Array.isArray((d.spec as Record<string, unknown>).items)
  );
}

export function createWorkstreamDraftStore(projectRoot: string): WorkstreamDraftStore {
  const dir = join(projectRoot, '.goodvibes', 'orchestration', 'drafts');
  const fileFor = (id: string): string => join(dir, `${id}.json`);

  return {
    loadAll(): WorkstreamDraft[] {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return []; // directory not created yet, or unreadable — nothing to resume
      }
      const drafts: WorkstreamDraft[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
          const parsed: unknown = JSON.parse(readFileSync(join(dir, entry), 'utf8'));
          if (isDraftShape(parsed) && isSafeId(parsed.id)) drafts.push(parsed);
        } catch {
          // A malformed or half-written snapshot is skipped, never fatal.
        }
      }
      return drafts.sort((a, b) => a.createdAt - b.createdAt);
    },
    save(draft: WorkstreamDraft): void {
      if (!isSafeId(draft.id)) return;
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(fileFor(draft.id), JSON.stringify(draft), 'utf8');
      } catch {
        // A failed journal write leaves the in-memory draft intact and usable;
        // only its restart-durability is lost, which is strictly better than
        // failing the edit the user just made.
      }
    },
    remove(id: string): void {
      if (!isSafeId(id)) return;
      try {
        rmSync(fileFor(id), { force: true });
      } catch {
        // Already gone, or unremovable — nothing more to do.
      }
    },
  };
}
