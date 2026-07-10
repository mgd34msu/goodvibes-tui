// ---------------------------------------------------------------------------
// rewind-runtime.ts — /rewind (message-anchored, unified files + conversation),
// plus the /undo rewind and /redo rewind reversals over the last receipt.
//
// The rewind engine is the SDK's UnifiedRewindService (platform/rewind:
// plan() previews + issues a single-use confirm token; apply() is token-gated
// and returns a receipt carrying an undo block). It JOINS the platform's three
// existing history stores — it never adds a fourth. This module wires that
// service to the TUI's in-process stores through the two ports the service
// defines:
//   • RewindWorkspacePort  ← the in-process WorkspaceCheckpointManager (the
//     same store /checkpoints and the daemon's own files-rewind use). The port
//     resolves an anchor's checkpoint by turnId across the session's turn
//     checkpoints; the TUI does not stamp checkpoints with a sessionId, so the
//     adapter returns the full checkpoint list and lets the shared turnId do the
//     join (see rewind-turn-anchors.ts).
//   • RewindConversationPort ← the in-process ConversationManager. preview()
//     reports how many messages truncate to the recorded turn boundary;
//     rewind() truncates and captures the pre- and post-truncation snapshots so
//     /undo rewind and /redo rewind can reverse and re-apply it.
// The undo/redo stacks stay TUI-side: the service reports how to reverse a
// rewind (its receipt's undo block), and this module performs the reversal.
//
// The confirm step reuses the DiffPanel confirm idiom (PanelConfirmOverlay),
// exactly like the former checkpoint-id /rewind this replaces (see the
// architecture note in checkpoint-runtime.ts): the handler resolves the
// anchor, previews the change, and arms the panel's confirm overlay; the actual
// y/n handling lives in DiffPanel.handleInput().
// ---------------------------------------------------------------------------

import {
  UnifiedRewindService,
  type RewindAnchor,
  type RewindCheckpointDiff,
  type RewindCheckpointView,
  type RewindReceipt,
  type RewindRestoreResult,
  type RewindScope as SdkRewindScope,
  type RewindWorkspacePort,
} from '@pellux/goodvibes-sdk/platform/rewind';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { WorkspaceCheckpointManager } from '@pellux/goodvibes-sdk/platform/workspace';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { buildRewindReceiptBlock } from '../../core/rewind-receipt.ts';
import { getTurnAnchors, type TurnAnchor } from '../../core/rewind-turn-anchors.ts';
import { createConversationRewindPort, type ConversationRewindPort } from '../../runtime/conversation-rewind-port.ts';
import { requirePanelManager } from './runtime-services.ts';

export type RewindScope = SdkRewindScope;
const REWIND_SCOPES: readonly RewindScope[] = ['files', 'conversation', 'both'];

// ---------------------------------------------------------------------------
// Ports — bridge the SDK rewind service onto the TUI's in-process stores.
// ---------------------------------------------------------------------------

/**
 * Workspace port over the in-process WorkspaceCheckpointManager. The manager's
 * own list()/diff()/restore() satisfy the port shape; list() drops the
 * service's sessionId filter because TUI turn checkpoints are joined by the
 * shared turnId, not a stamped sessionId.
 */
function makeWorkspacePort(mgr: WorkspaceCheckpointManager): RewindWorkspacePort {
  return {
    async list(): Promise<readonly RewindCheckpointView[]> {
      return mgr.list();
    },
    async diff(id: string): Promise<RewindCheckpointDiff> {
      return mgr.diff(id);
    },
    async restore(id: string, opts?: { readonly safetyCheckpoint?: boolean | undefined }): Promise<RewindRestoreResult> {
      return mgr.restore(id, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// Per-session rewind state — the SDK service (with its wired ports) plus the
// TUI-owned undo/redo stacks of applied receipts.
// ---------------------------------------------------------------------------

interface RewindSessionState {
  readonly service: UnifiedRewindService;
  readonly convPort: ConversationRewindPort;
  readonly undo: RewindReceipt[];
  readonly redo: RewindReceipt[];
}

const sessions = new Map<string, RewindSessionState>();

/** Get or build the per-session service, capturing the session's live stores. */
function stateFor(ctx: CommandContext): RewindSessionState {
  const sessionId = ctx.session.runtime.sessionId;
  let state = sessions.get(sessionId);
  if (!state) {
    const mgr = ctx.workspace.workspaceCheckpointManager;
    const conv = ctx.session.conversationManager;
    const convPort = createConversationRewindPort(() => conv);
    const service = new UnifiedRewindService({
      workspace: mgr ? makeWorkspacePort(mgr) : null,
      conversation: convPort,
    });
    state = { service, convPort, undo: [], redo: [] };
    sessions.set(sessionId, state);
  }
  return state;
}

/** Reset a session's rewind state. Exposed for tests and session reset. */
export function resetRewindState(sessionId: string): void {
  sessions.delete(sessionId);
}

function wants(scope: RewindScope, part: 'files' | 'conversation'): boolean {
  return scope === 'both' || scope === part;
}

function undoAvailable(receipt: RewindReceipt): boolean {
  return receipt.undo.files !== null || receipt.undo.conversation !== null;
}

// ---------------------------------------------------------------------------
// /undo rewind & /redo rewind — reversal over the last receipt's undo points.
// Called from session-content.ts so the /undo and /redo commands stay single.
// ---------------------------------------------------------------------------

export interface RewindReversalResult {
  readonly handled: boolean;
  readonly message: string;
}

export async function undoLastRewind(ctx: CommandContext): Promise<RewindReversalResult> {
  const state = stateFor(ctx);
  const receipt = state.undo.pop();
  if (!receipt) return { handled: false, message: 'No applied rewind to undo. (Bare /undo removes the last conversation turn.)' };

  const mgr = ctx.workspace.workspaceCheckpointManager;
  const parts: string[] = [];
  try {
    if (receipt.undo.files && mgr) {
      await mgr.restore(receipt.undo.files.restoreCheckpointId, { safetyCheckpoint: false });
      parts.push('files restored to pre-rewind state');
    }
    if (receipt.undo.conversation && state.convPort.restoreBefore(receipt.undo.conversation.undoSnapshotId)) {
      parts.push('conversation restored to pre-rewind state');
    }
  } catch (err) {
    state.undo.push(receipt);
    return { handled: true, message: `Undo rewind failed: ${summarizeError(err)}` };
  }
  state.redo.push(receipt);
  ctx.renderRequest();
  return { handled: true, message: `Rewind undone: ${parts.join(', ') || 'nothing to reverse'}. Use /redo rewind to re-apply.` };
}

export async function redoLastRewind(ctx: CommandContext): Promise<RewindReversalResult> {
  const state = stateFor(ctx);
  const receipt = state.redo.pop();
  if (!receipt) return { handled: false, message: 'No undone rewind to redo. (Bare /redo restores the last conversation turn.)' };

  const mgr = ctx.workspace.workspaceCheckpointManager;
  const parts: string[] = [];
  try {
    if (receipt.files?.checkpointId && mgr) {
      await mgr.restore(receipt.files.checkpointId, { safetyCheckpoint: false });
      parts.push('files re-applied');
    }
    if (receipt.undo.conversation && state.convPort.restoreAfter(receipt.undo.conversation.undoSnapshotId)) {
      parts.push('conversation re-applied');
    }
  } catch (err) {
    state.redo.push(receipt);
    return { handled: true, message: `Redo rewind failed: ${summarizeError(err)}` };
  }
  state.undo.push(receipt);
  ctx.renderRequest();
  return { handled: true, message: `Rewind re-applied: ${parts.join(', ') || 'nothing to re-apply'}.` };
}

// ---------------------------------------------------------------------------
// Recent-turns picker + anchor resolution
// ---------------------------------------------------------------------------

function formatAge(atMs: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.floor((nowMs - atMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Recent turns, NEWEST first, numbered 1..N for the picker. */
function recentTurnsNewestFirst(sessionId: string): TurnAnchor[] {
  return [...getTurnAnchors(sessionId)].reverse();
}

function renderTurnList(sessionId: string): string {
  const turns = recentTurnsNewestFirst(sessionId);
  if (turns.length === 0) {
    return 'No completed turns recorded this run yet. /rewind targets turns completed in the current session run.';
  }
  const lines = ['Recent turns (newest first) — /rewind <n> [files|conversation|both]:'];
  turns.slice(0, 20).forEach((t, i) => {
    lines.push(`  ${String(i + 1).padStart(2)}. ${t.label}  (${formatAge(t.at)}, ${t.messageCount} msgs)`);
  });
  lines.push('Default scope is "both" (files + conversation). Files resolve only for turns that changed files.');
  return lines.join('\n');
}

/** Resolve a user ref ('1'..'N' newest-first, or a turnId / turnId prefix) to an anchor turn. */
function resolveRef(sessionId: string, ref: string): TurnAnchor | { error: string } {
  const turns = recentTurnsNewestFirst(sessionId);
  if (turns.length === 0) return { error: 'No completed turns recorded this run yet.' };
  if (/^\d+$/.test(ref)) {
    const idx = Number(ref) - 1;
    const turn = turns[idx];
    return turn ? turn : { error: `No turn #${ref}. Run /rewind to list recent turns (1–${turns.length}).` };
  }
  const exact = turns.find((t) => t.turnId === ref);
  if (exact) return exact;
  const prefix = turns.filter((t) => t.turnId.startsWith(ref));
  if (prefix.length === 1) return prefix[0]!;
  if (prefix.length > 1) return { error: `Turn ref "${ref}" is ambiguous (${prefix.length} matches). Use the list number instead.` };
  return { error: `Unknown turn ref "${ref}". Run /rewind to list recent turns.` };
}

function parseScope(token: string | undefined): RewindScope | null {
  if (token === undefined) return 'both';
  const lower = token.toLowerCase();
  return (REWIND_SCOPES as readonly string[]).includes(lower) ? (lower as RewindScope) : null;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerRewindRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'rewind',
    description: 'Rewind files, conversation, or both to a completed turn (preview + confirm)',
    usage: '[<n|turnId> [files|conversation|both]]',
    argsHint: '[<n> [files|conversation|both]]',
    handler: async (args, ctx: CommandContext) => {
      const sessionId = ctx.session.runtime.sessionId;

      if (args.length === 0) {
        ctx.print(renderTurnList(sessionId));
        return;
      }

      const scope = parseScope(args[1]);
      if (scope === null) {
        ctx.print(`Unknown scope "${args[1]}". Use one of: files | conversation | both.`);
        return;
      }
      const resolved = resolveRef(sessionId, args[0]!);
      if ('error' in resolved) {
        ctx.print(resolved.error);
        return;
      }
      const anchor: RewindAnchor = { sessionId, turnId: resolved.turnId };

      if (wants(scope, 'files') && !ctx.workspace.workspaceCheckpointManager) {
        ctx.print('Checkpoints are not available in this session — files rewind cannot run. Try /rewind <n> conversation.');
        return;
      }

      const state = stateFor(ctx);
      const plan = await state.service.plan(anchor, scope).catch((err) => {
        ctx.print(`Could not plan rewind: ${summarizeError(err)}`);
        return null;
      });
      if (!plan) return;

      const filesAvailable = plan.files?.available ?? false;
      const conversationAvailable = plan.conversation?.available ?? false;
      if (!filesAvailable && !conversationAvailable) {
        ctx.print(`Nothing to rewind for turn "${resolved.label}" at scope ${scope}.`);
        for (const w of plan.warnings) ctx.print(`  note: ${w}`);
        return;
      }

      // Preview in the DiffPanel + arm its confirm overlay (same idiom the
      // former checkpoint-id /rewind used — see checkpoint-runtime.ts).
      const { DiffPanel } = await import('../../panels/diff-panel.ts');
      const pm = requirePanelManager(ctx);
      let panel = pm.getAllOpen().find((p) => p.id === 'diff');
      if (!panel) {
        try { panel = pm.open('diff'); } catch { ctx.print('Could not open diff panel.'); return; }
      }
      pm.activateById('diff');
      if (!pm.isVisible()) pm.show();
      ctx.focusPanels?.();
      const diffPanel = panel as InstanceType<typeof DiffPanel>;

      const checkpointId = plan.files?.checkpointId ?? null;
      if (filesAvailable && checkpointId && ctx.workspace.workspaceCheckpointManager) {
        try {
          const diff = await ctx.workspace.workspaceCheckpointManager.diff(checkpointId);
          if (diff.unifiedDiff.trim()) diffPanel.loadRawDiff(diff.unifiedDiff);
          else diffPanel.showDiff('(no file changes)', '@@ -0,0 +0,0 @@\n Working tree already matches this checkpoint.');
        } catch {
          diffPanel.showDiff('(preview unavailable)', '@@ -0,0 +0,0 @@\n Could not load the checkpoint diff.');
        }
      } else {
        const drop = plan.conversation?.messagesToDrop ?? 0;
        const remaining = plan.conversation?.messagesRemaining ?? 0;
        diffPanel.showDiff(
          `Conversation rewind — drop ${drop} message(s)`,
          `@@ rewind @@\n Keep ${remaining} message(s), drop ${drop} after this turn. No files change.`,
        );
      }

      const summaryParts: string[] = [];
      if (wants(scope, 'files')) summaryParts.push(filesAvailable ? `${plan.files?.affectedFileCount ?? 0} file(s)` : 'files: none');
      if (wants(scope, 'conversation')) summaryParts.push(conversationAvailable ? `${plan.conversation?.messagesToDrop ?? 0} message(s)` : 'conversation: unavailable');

      diffPanel.confirmOverlay.arm({
        id: anchor.turnId ?? sessionId,
        label: `${resolved.label} — rewind ${scope} (${summaryParts.join(', ')})`,
        verb: 'Rewind',
        onConfirm: async () => {
          try {
            const result = await state.service.apply(anchor, scope, { confirmToken: plan.token });
            const receipt = result.receipt;
            if (!receipt) {
              ctx.print(`Rewind not applied: ${result.refusal?.reason ?? 'confirmation was refused.'}`);
              return;
            }
            if (undoAvailable(receipt)) {
              state.undo.push(receipt);
              state.redo.length = 0; // a fresh apply invalidates the redo stack
            }
            // addTypedSystemMessage persists the receipt into real session
            // history (indexed by getTranscriptEventIndex + save/load), and the
            // [Rewind] prefix is force-surfaced inline (system-message-router.ts).
            ctx.session.conversationManager.addTypedSystemMessage(
              buildRewindReceiptBlock({ ...receipt, undoAvailable: undoAvailable(receipt) }),
              'operational',
            );
            pm.close('diff');
            ctx.focusPrompt?.();
            ctx.renderRequest();
          } catch (err) {
            ctx.print(`Rewind failed: ${summarizeError(err)}`);
          }
        },
        onCancel: () => {
          ctx.print('Rewind cancelled — nothing changed.');
          pm.close('diff');
          ctx.focusPrompt?.();
          ctx.renderRequest();
        },
      });

      ctx.print(`Previewing rewind of turn "${resolved.label}" (${scope}: ${summaryParts.join(', ')}). Confirm in the diff panel: Enter/y to rewind, n/Esc to cancel.`);
      for (const w of plan.warnings) ctx.print(`  note: ${w}`);
      ctx.renderRequest();
    },
  });
}
