/**
 * recall-files.ts, `/recall files sync|review|apply`, the git-backed markdown
 * projection surface for standing (project/team-scope) memory records.
 *
 * Round-trip:
 *   sync  , project store records to `<dir>/<id>.md`, git-commit the directory
 *            when it sits inside a repo. Read-only against the store.
 *   review, diff the on-disk projection against the current store and print
 *            the resulting proposals (a file edit -> 'update', a deleted file
 *            for an in-scope record -> 'delete'). PURE, no store writes.
 *   apply , re-diff fresh, then mutate the store ONLY for the proposal ids
 *            the caller explicitly names (or --all), through the memory spine
 *            client's own update/delete. Never a silent write.
 *
 * `apply` re-diffs on every call rather than caching `review`'s output, so it
 * always acts on the current on-disk/store state and never on a stale
 * snapshot from an earlier `review` call.
 *
 * Routes through `getMemorySpine` (not the host-only `knowledgeApi.memory`)
 * per the SDK's memory-wire-full-detach decision, same as every other
 * mutating `/recall` subcommand, so this fully detaches from the local store
 * file when a daemon has been adopted.
 *
 * The memory spine's wire `MemoryUpdatePatch` (SDK platform/runtime/memory-spine)
 * now carries validFrom/validUntil alongside scope/summary/detail/tags, a
 * number sets the bound, `null` clears it, and an omitted field leaves it
 * unchanged, so a proposal whose `desired` changes ONLY the temporal window
 * applies for real over the wire, the same as any other field change.
 */
import { existsSync } from 'node:fs';
import type { CommandContext } from '../command-registry.ts';
import {
  diffProjectionToProposals,
  projectMemoryToFiles,
  readProjectedMemoryFiles,
  type MemoryProjectionProposal,
} from '@pellux/goodvibes-sdk/platform/state';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { requireShellPaths } from './runtime-services.ts';
import { getMemorySpine } from './recall-query.ts';
import { readMemoryProjectionDir } from './recall-files-config.ts';
import { createSyncGitSeam } from './recall-files-git.ts';

const PROJECTION_LIST_LIMIT = 5000;

/** Resolve the projection directory: an explicit --dir argument wins, else the configured setting. */
function resolveProjectionDir(args: string[], context: CommandContext): string {
  const shellPaths = requireShellPaths(context);
  const dirIdx = args.indexOf('--dir');
  const explicit = dirIdx !== -1 ? args[dirIdx + 1] : undefined;
  const configured = readMemoryProjectionDir(context.platform.configManager);
  return shellPaths.resolveWorkspacePath(explicit || configured);
}

export async function handleRecallFilesSync(args: string[], context: CommandContext): Promise<void> {
  const memory = getMemorySpine(context);
  if (!memory) return;

  const dir = resolveProjectionDir(args, context);
  const records = await memory.list({ limit: PROJECTION_LIST_LIMIT });

  try {
    // The SDK's ownership gate commits only to a repository whose toplevel IS
    // the projection directory (initializing one there when needed), never
    // to a checkout the directory merely sits inside.
    const report = projectMemoryToFiles(records, dir, { git: createSyncGitSeam() });
    context.print(`[recall] Projected ${report.written.length} record(s) to ${report.dir}`);
    context.print(report.committed
      ? `  committed in ${report.dir} (the projection's own repository)`
      : '  not committed (git seam did not run)');
  } catch (error) {
    context.print(`[recall] Projection sync failed: ${summarizeError(error)}`);
  }
}

/** Compute the current proposals for `dir` against the live store. Returns null (already printed) when the directory doesn't exist yet. */
async function computeProposals(
  dir: string,
  context: CommandContext,
): Promise<MemoryProjectionProposal[] | null> {
  const memory = getMemorySpine(context);
  if (!memory) return null;
  if (!existsSync(dir)) {
    context.print(`[recall] No projection directory at ${dir}. Run /recall files sync first.`);
    return null;
  }
  const records = await memory.list({ limit: PROJECTION_LIST_LIMIT });
  const files = readProjectedMemoryFiles(dir);
  return diffProjectionToProposals(records, files);
}

function printProposal(context: CommandContext, proposal: MemoryProjectionProposal): void {
  context.print(`  ${proposal.id} [${proposal.kind}] ${proposal.reason}`);
  if (proposal.kind === 'update' && proposal.changedFields && proposal.changedFields.length > 0) {
    context.print(`    changed: ${proposal.changedFields.join(', ')}`);
  }
}

export async function handleRecallFilesReview(args: string[], context: CommandContext): Promise<void> {
  const dir = resolveProjectionDir(args, context);
  const proposals = await computeProposals(dir, context);
  if (proposals === null) return;

  if (proposals.length === 0) {
    context.print(`[recall] No changes: ${dir} matches the store.`);
    return;
  }
  context.print(`[recall] ${proposals.length} proposal(s) from ${dir}:`);
  for (const proposal of proposals) printProposal(context, proposal);
  context.print('[recall] Nothing has been applied. Run /recall files apply <id> [<id> ...] | --all to confirm.');
}

export async function handleRecallFilesApply(args: string[], context: CommandContext): Promise<void> {
  const memory = getMemorySpine(context);
  if (!memory) return;

  const applyAll = args.includes('--all') || args.includes('all');
  const ids = new Set(args.filter((a) => a !== '--all' && a !== 'all' && a !== '--dir' && !a.startsWith('.') && !a.startsWith('/')));
  // --dir's value (the token right after it) is not a proposal id, drop it.
  const dirIdx = args.indexOf('--dir');
  if (dirIdx !== -1 && args[dirIdx + 1]) ids.delete(args[dirIdx + 1]!);

  if (!applyAll && ids.size === 0) {
    context.print('[recall] Usage: /recall files apply <id> [<id> ...] | --all [--dir <path>]');
    context.print('[recall] Run /recall files review first to see the current proposal ids.');
    return;
  }

  const dir = resolveProjectionDir(args, context);
  const proposals = await computeProposals(dir, context);
  if (proposals === null) return;

  const targeted = applyAll ? proposals : proposals.filter((p) => ids.has(p.id));
  if (targeted.length === 0) {
    context.print('[recall] No matching proposals. Run /recall files review to see the current list.');
    return;
  }
  const targetedIds = new Set(targeted.map((p) => p.id));

  const applied: MemoryProjectionProposal[] = [];
  const skipped: MemoryProjectionProposal[] = [];
  const failed: { proposal: MemoryProjectionProposal; reason: string }[] = [];

  for (const proposal of proposals) {
    if (!targetedIds.has(proposal.id)) {
      skipped.push(proposal);
      continue;
    }
    try {
      if (proposal.kind === 'delete') {
        const ok = await memory.delete(proposal.id);
        if (ok) applied.push(proposal);
        else failed.push({ proposal, reason: 'store delete returned false (record already gone?)' });
        continue;
      }
      const desired = proposal.desired ?? {};
      const patch: {
        scope?: typeof desired.scope;
        summary?: string;
        detail?: string;
        tags?: string[];
        validFrom?: number | null;
        validUntil?: number | null;
      } = {};
      if (desired.scope !== undefined) patch.scope = desired.scope;
      if (desired.summary !== undefined) patch.summary = desired.summary;
      if (desired.detail !== undefined) patch.detail = desired.detail;
      if (desired.tags !== undefined) patch.tags = [...desired.tags];
      if (desired.validFrom !== undefined) patch.validFrom = desired.validFrom;
      if (desired.validUntil !== undefined) patch.validUntil = desired.validUntil;
      const result = await memory.update(proposal.id, patch);
      if (result) applied.push(proposal);
      else failed.push({ proposal, reason: 'store update returned null (record not found?)' });
    } catch (error) {
      failed.push({ proposal, reason: summarizeError(error) });
    }
  }

  context.print(`[recall] Applied ${applied.length}, skipped ${skipped.length}, failed ${failed.length}.`);
  for (const proposal of applied) context.print(`  applied  ${proposal.id} [${proposal.kind}]`);
  for (const { proposal, reason } of failed) context.print(`  failed   ${proposal.id} [${proposal.kind}]: ${reason}`);
}
