// ---------------------------------------------------------------------------
// checkpoint-runtime.ts — /checkpoints, /checkpoint, /rewind
//
// UX over WorkspaceCheckpointManager (@pellux/goodvibes-sdk/platform/workspace),
// the whole-workspace, git-backed rewind engine wired onto RuntimeServices as
// `workspaceCheckpointManager` (src/runtime/services.ts) and threaded through
// CommandContext.workspace exactly like FileUndoManager already is.
//
// Architecture note (why the confirm step lives in DiffPanel, not here):
// SlashCommand.handler(args, ctx) is a single-shot call — there is no "await
// next keypress" primitive in the command layer. So `/rewind <id>` can only
// resolve the target, load the preview, open+focus the diff panel, and arm
// its confirm overlay (DiffPanel.confirmOverlay, a PanelConfirmOverlay —
// see panel-confirm-overlay.ts); the actual y/n/Enter/Esc handling happens
// in DiffPanel.handleInput() via the project's canonical ConfirmState<T>
// contract (confirm-state.ts), which every other destructive-action confirm
// in this codebase already uses (see git-panel.ts).
// ---------------------------------------------------------------------------

import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { WorkspaceCheckpoint, WorkspaceCheckpointManager } from '@pellux/goodvibes-sdk/platform/workspace';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requirePanelManager } from './runtime-services.ts';

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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Checkpoint resolution — shared by /rewind
// ---------------------------------------------------------------------------

type ResolveResult =
  | { checkpoint: WorkspaceCheckpoint }
  | { error: string };

/**
 * Resolve a user-supplied checkpoint reference ('last' or an id / id prefix,
 * as shown by /checkpoints) against the live checkpoint list. Resolution
 * happens entirely against list() results — never against
 * WorkspaceCheckpointManager's own requireCheckpoint() — so an unknown ref is
 * caught here, before anything touches the diff panel or arms a confirm.
 */
async function resolveCheckpointTarget(
  mgr: WorkspaceCheckpointManager,
  ref: string,
): Promise<ResolveResult> {
  const all = await mgr.list();
  if (ref === 'last') {
    const checkpoint = all[0];
    if (!checkpoint) {
      return { error: 'No checkpoints to rewind to. Use /checkpoint <label> to create one.' };
    }
    return { checkpoint };
  }
  const exact = all.find((c) => c.id === ref);
  if (exact) return { checkpoint: exact };

  const prefixMatches = all.filter((c) => c.id.startsWith(ref) || shortId(c.id).startsWith(ref));
  if (prefixMatches.length === 1) return { checkpoint: prefixMatches[0]! };
  if (prefixMatches.length > 1) {
    return {
      error: `Checkpoint id "${ref}" is ambiguous — matches ${prefixMatches.length} checkpoints. Use a longer prefix or run /checkpoints for full ids.`,
    };
  }
  return { error: `Unknown checkpoint id: "${ref}". Run /checkpoints to see available checkpoints.` };
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
      ctx.print('Use /rewind <id|last> to preview the exact file changes and restore a checkpoint.');
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

  registry.register({
    name: 'rewind',
    description: 'Preview and restore a workspace checkpoint (files only — conversation history is unchanged)',
    usage: '<id|last>',
    argsHint: '<id|last>',
    handler: async (args, ctx: CommandContext) => {
      const mgr = ctx.workspace.workspaceCheckpointManager;
      if (!mgr) {
        ctx.print('Checkpoints are not available in this session.');
        return;
      }
      const ref = args[0];
      if (!ref) {
        ctx.print('Usage: /rewind <id|last>. Run /checkpoints to see available checkpoints.');
        return;
      }

      const resolved = await resolveCheckpointTarget(mgr, ref);
      if ('error' in resolved) {
        ctx.print(resolved.error);
        return;
      }
      const { checkpoint } = resolved;

      let diff: Awaited<ReturnType<WorkspaceCheckpointManager['diff']>>;
      try {
        diff = await mgr.diff(checkpoint.id);
      } catch (err) {
        ctx.print(`Could not load checkpoint preview: ${summarizeError(err)}`);
        return;
      }

      const { DiffPanel } = await import('../../panels/diff-panel.ts');
      const pm = requirePanelManager(ctx);
      let panel = pm.getAllOpen().find((p) => p.id === 'diff');
      if (!panel) {
        try {
          panel = pm.open('diff');
        } catch {
          ctx.print('Could not open diff panel.');
          return;
        }
      }
      pm.activateById('diff');
      if (!pm.isVisible()) pm.show();
      // Must focus the panel — otherwise the user is left typing at the
      // prompt while the panel silently shows a pending confirm they never
      // see (the single most likely UX bug in this feature).
      ctx.focusPanels?.();

      const diffPanel = panel as InstanceType<typeof DiffPanel>;
      if (diff.unifiedDiff.trim()) {
        diffPanel.loadRawDiff(diff.unifiedDiff);
      } else {
        diffPanel.showDiff('(no changes)', '@@ -0,0 +0,0 @@\n Working tree already matches this checkpoint.');
      }

      diffPanel.confirmOverlay.arm({
        id: checkpoint.id,
        label: `Restore "${checkpoint.label}" (${plural(diff.files.length, 'file')} differ) — files only, conversation history is unchanged`,
        verb: 'Restore',
        onConfirm: async () => {
          try {
            const result = await mgr.restore(checkpoint.id, { safetyCheckpoint: true });
            ctx.print(
              `Rewind complete: restored ${plural(result.restoredFiles.length, 'file')}, removed ${plural(result.removedFiles.length, 'file')}. ` +
              `Safety checkpoint: ${result.safetyCheckpointId ? shortId(result.safetyCheckpointId) : '(none — working tree already matched)'}.`,
            );
            // Conversation is NOT rewound: addSystemMessage (not ctx.print)
            // persists this note into real turn/session history so it is
            // indexed by getTranscriptEventIndex() and session save/load,
            // while staying a distinct message kind from user/assistant turns.
            ctx.session.conversationManager.addSystemMessage(
              `[Rewind] Restored checkpoint "${checkpoint.label}" (${plural(result.restoredFiles.length, 'file')} restored, ${plural(result.removedFiles.length, 'file')} removed). ` +
              'Files were rewound — conversation history is unchanged. Use /undo to remove turns separately.',
            );
            ctx.renderRequest();
          } catch (err) {
            ctx.print(`Rewind failed: ${summarizeError(err)}`);
          }
        },
        onCancel: () => {
          ctx.print('Rewind cancelled — no files changed.');
        },
      });
      ctx.print(`Previewing checkpoint ${shortId(checkpoint.id)} "${checkpoint.label}". Confirm in the diff panel: Enter/y to restore, n/Esc to cancel.`);
      ctx.renderRequest();
    },
  });
}
