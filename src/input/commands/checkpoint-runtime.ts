// ---------------------------------------------------------------------------
// checkpoint-runtime.ts — /checkpoints, /checkpoint
//
// UX over WorkspaceCheckpointManager (@pellux/goodvibes-sdk/platform/workspace),
// the whole-workspace, git-backed snapshot engine wired onto RuntimeServices as
// `workspaceCheckpointManager` (src/runtime/services.ts) and threaded through
// CommandContext.workspace exactly like FileUndoManager already is.
//
// Restoring a checkpoint is now done through the unified, message-anchored
// /rewind (rewind-runtime.ts), which rewinds files AND/OR conversation to a
// completed turn — reusing this same checkpoint store for the files half.
// ---------------------------------------------------------------------------

import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { WorkspaceCheckpoint } from '@pellux/goodvibes-sdk/platform/workspace';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Drop the redundant 'wcp_' prefix and cap length for compact listing. Full ids (and any unambiguous prefix of one) are still accepted by /rewind. */
function shortId(id: string): string {
  const stripped = id.startsWith('wcp_') ? id.slice(4) : id;
  return stripped.length > 12 ? stripped.slice(0, 12) : stripped;
}

function formatAge(createdAtMs: number, nowMs: number = Date.now()): string {
  const deltaMs = Math.max(0, nowMs - createdAtMs);
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function registerCheckpointRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'checkpoints',
    aliases: ['ckpts'],
    description: 'List workspace checkpoints, newest first',
    handler: async (_args, ctx: CommandContext) => {
      const mgr = ctx.workspace.workspaceCheckpointManager;
      if (!mgr) {
        ctx.print('Checkpoints are not available in this session.');
        return;
      }
      let checkpoints: WorkspaceCheckpoint[];
      try {
        checkpoints = await mgr.list();
      } catch (err) {
        ctx.print(`Failed to list checkpoints: ${summarizeError(err)}`);
        return;
      }
      if (checkpoints.length === 0) {
        ctx.print('No checkpoints yet. /checkpoint <label> creates one manually; turns and agent runs snapshot automatically.');
        return;
      }
      ctx.print(`Checkpoints (${checkpoints.length}, newest first):`);
      for (const cp of checkpoints) {
        ctx.print(`  ${shortId(cp.id).padEnd(12)} ${cp.kind.padEnd(9)} ${cp.label}  ${formatAge(cp.createdAt)}  ~${formatBytes(cp.sizeBytes)} new`);
      }
      // Files-changed counts are deliberately NOT shown per-row here: getting
      // them would cost one diff spawn per checkpoint (O(checkpoints)), which
      // stops being cheap once there are more than a handful. /rewind <id>
      // loads exactly one diff, so the exact file list is available there.
      ctx.print('Use /rewind to preview and restore a completed turn (files and/or conversation) — it reuses these checkpoints for the files half.');
    },
  });

  registry.register({
    name: 'checkpoint',
    description: 'Create a manual workspace checkpoint (forensic retention)',
    usage: '[label]',
    argsHint: '[label]',
    handler: async (args, ctx: CommandContext) => {
      const mgr = ctx.workspace.workspaceCheckpointManager;
      if (!mgr) {
        ctx.print('Checkpoints are not available in this session.');
        return;
      }
      const label = args.join(' ').trim() || undefined;
      try {
        const checkpoint = await mgr.create({ kind: 'manual', label, retentionClass: 'forensic' });
        if (!checkpoint) {
          ctx.print('No changes since the last checkpoint — nothing to save.');
          return;
        }
        ctx.print(`Checkpoint created: ${shortId(checkpoint.id)} "${checkpoint.label}" (forensic retention).`);
      } catch (err) {
        ctx.print(`Checkpoint failed: ${summarizeError(err)}`);
      }
    },
  });
}
