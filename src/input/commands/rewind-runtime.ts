// ---------------------------------------------------------------------------
// rewind-runtime.ts — /rewind (message-anchored, unified files + conversation),
// plus the /undo rewind and /redo rewind reversals over the last receipt.
//
// The SDK ships a unified rewind service (platform/rewind: rewind.plan +
// rewind.apply, REWIND_PLANNED/REWIND_APPLIED workspace events). It is,
// however, NOT reachable from this repo: registerGatewayVerbGroups constructs
// the service with `conversation: null` and exposes no conversation-port
// parameter, AND UnifiedRewindService is not exported through any public
// package subpath (there is no `@pellux/goodvibes-sdk/platform/rewind` entry in
// the SDK exports map, and the root export omits it). So the TUI can neither
// thread a conversation port into the SDK service nor construct its own.
//
// To still make rewind work END-TO-END here — files AND conversation, in the
// running TUI, with no daemon round-trip — this module implements a small
// TUI-local coordinator that faithfully mirrors the SDK service's contract:
// plan() previews exactly what would change and issues a single-use confirm
// token; apply() is token-gated and returns a receipt carrying an undo block.
// Files reuse the in-process WorkspaceCheckpointManager (the same store
// /checkpoints and the SDK's own files-rewind use — never a fourth history
// system); conversation reuses the in-process ConversationManager. The anchor
// is a completed turn; the conversation truncation boundary is the message
// count recorded for that turnId at TURN_COMPLETED (core/rewind-turn-anchors.ts),
// the join key that lines conversation up against the workspace checkpoint the
// turn engine stamped with the same turnId.
//
// The confirm step reuses the DiffPanel confirm idiom (PanelConfirmOverlay),
// exactly like the former checkpoint-id /rewind this replaces (see the
// architecture note in checkpoint-runtime.ts): the handler resolves the
// anchor, previews the change, and arms the panel's confirm overlay; the actual
// y/n handling lives in DiffPanel.handleInput().
// ---------------------------------------------------------------------------

import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { WorkspaceCheckpoint, WorkspaceCheckpointManager } from '@pellux/goodvibes-sdk/platform/workspace';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { ConversationManager } from '../../core/conversation.ts';
import { buildRewindReceiptBlock } from '../../core/rewind-receipt.ts';
import { getTurnAnchors, resolveTurnAnchor, type TurnAnchor } from '../../core/rewind-turn-anchors.ts';
import { requirePanelManager } from './runtime-services.ts';

// ---------------------------------------------------------------------------
// Contract types (mirror the SDK's platform/rewind shapes, which are not
// exported for the TUI to import — see the header note).
// ---------------------------------------------------------------------------

export type RewindScope = 'files' | 'conversation' | 'both';
const REWIND_SCOPES: readonly RewindScope[] = ['files', 'conversation', 'both'];

interface RewindAnchor {
  readonly sessionId: string;
  readonly turnId: string;
}

interface RewindPlan {
  readonly anchor: RewindAnchor;
  readonly scope: RewindScope;
  readonly token: string;
  /** Resolved workspace checkpoint for this anchor, when files scope is available. */
  readonly checkpoint: WorkspaceCheckpoint | null;
  readonly filesAvailable: boolean;
  readonly affectedFileCount: number;
  readonly conversationAvailable: boolean;
  readonly messagesToDrop: number;
  readonly messagesRemaining: number;
  readonly warnings: string[];
}

interface RewindReceipt {
  readonly scope: RewindScope;
  readonly turnId: string | null;
  readonly files: {
    readonly restored: boolean;
    readonly checkpointId: string | null;
    readonly safetyCheckpointId: string | null;
    readonly restoredFileCount: number;
    readonly removedFileCount: number;
  } | null;
  readonly conversation: {
    readonly rewound: boolean;
    readonly droppedMessages: number;
    readonly undoSnapshotId: string | null;
  } | null;
  readonly undo: {
    readonly files: { readonly restoreCheckpointId: string } | null;
    readonly conversation: { readonly undoSnapshotId: string } | null;
  };
  readonly undoAvailable: boolean;
  readonly warnings: readonly string[];
}

/** An applied rewind on the reversal stack, with the post-apply snapshot for redo. */
interface RewindHistoryEntry {
  readonly receipt: RewindReceipt;
  /** Conversation snapshot captured AFTER truncation, so /redo can re-apply. */
  readonly convAfterId: string | null;
}

type ConversationJson = Parameters<ConversationManager['fromJSON']>[0];

/** Per-session rewind state: single-use tokens, captured snapshots, undo/redo stacks. */
interface RewindSessionState {
  readonly tokens: Map<string, { fingerprint: string; expiresAt: number }>;
  readonly snapshots: Map<string, ConversationJson>;
  readonly undo: RewindHistoryEntry[];
  readonly redo: RewindHistoryEntry[];
}

const sessions = new Map<string, RewindSessionState>();
const TOKEN_TTL_MS = 120_000;

function stateFor(sessionId: string): RewindSessionState {
  let state = sessions.get(sessionId);
  if (!state) {
    state = { tokens: new Map(), snapshots: new Map(), undo: [], redo: [] };
    sessions.set(sessionId, state);
  }
  return state;
}

/** Reset a session's rewind state. Exposed for tests. */
export function resetRewindState(sessionId: string): void {
  sessions.delete(sessionId);
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function fingerprint(anchor: RewindAnchor, scope: RewindScope): string {
  return `${anchor.sessionId}|${anchor.turnId}|${scope}`;
}

function wants(scope: RewindScope, part: 'files' | 'conversation'): boolean {
  return scope === 'both' || scope === part;
}

// ---------------------------------------------------------------------------
// Coordinator — plan / apply, mirroring the SDK service's semantics.
// ---------------------------------------------------------------------------

async function findCheckpointForTurn(mgr: WorkspaceCheckpointManager, turnId: string): Promise<WorkspaceCheckpoint | null> {
  const all = await mgr.list();
  return all.find((c) => c.turnId === turnId) ?? null;
}

async function planRewind(
  ctx: CommandContext,
  anchor: RewindAnchor,
  scope: RewindScope,
): Promise<RewindPlan> {
  const mgr = ctx.workspace.workspaceCheckpointManager;
  const conv = ctx.session.conversationManager;
  const warnings: string[] = [];

  let checkpoint: WorkspaceCheckpoint | null = null;
  let affectedFileCount = 0;
  let filesAvailable = false;
  if (wants(scope, 'files')) {
    checkpoint = mgr ? await findCheckpointForTurn(mgr, anchor.turnId) : null;
    if (mgr && checkpoint) {
      try {
        affectedFileCount = (await mgr.diff(checkpoint.id)).files.length;
        filesAvailable = true;
      } catch (err) {
        warnings.push(`files preview failed: ${summarizeError(err)}`);
      }
    } else {
      warnings.push(mgr ? 'files rewind: no workspace checkpoint was recorded for this turn (it changed no files).' : 'files rewind unavailable: no checkpoint store in this session.');
    }
  }

  let conversationAvailable = false;
  let messagesToDrop = 0;
  let messagesRemaining = 0;
  if (wants(scope, 'conversation')) {
    const rec = resolveTurnAnchor(anchor.sessionId, anchor.turnId);
    if (rec) {
      const total = conv.getMessageCount();
      messagesRemaining = Math.min(rec.messageCount, total);
      messagesToDrop = Math.max(0, total - rec.messageCount);
      conversationAvailable = true;
    } else {
      warnings.push('conversation rewind unavailable: no conversation boundary was recorded for this turn in the current run.');
    }
  }

  const token = newId('rwt');
  stateFor(anchor.sessionId).tokens.set(token, { fingerprint: fingerprint(anchor, scope), expiresAt: Date.now() + TOKEN_TTL_MS });

  return { anchor, scope, token, checkpoint, filesAvailable, affectedFileCount, conversationAvailable, messagesToDrop, messagesRemaining, warnings };
}

/** Consume a single-use plan token; throws when invalid/expired/mismatched. */
function consumeToken(state: RewindSessionState, token: string, expected: string): void {
  const record = state.tokens.get(token);
  state.tokens.delete(token);
  if (!record || record.fingerprint !== expected || record.expiresAt < Date.now()) {
    throw new Error('confirm token is invalid, already used, expired, or was issued for a different rewind. Re-run /rewind.');
  }
}

async function applyRewind(ctx: CommandContext, plan: RewindPlan): Promise<RewindReceipt> {
  const mgr = ctx.workspace.workspaceCheckpointManager;
  const conv = ctx.session.conversationManager;
  const state = stateFor(plan.anchor.sessionId);
  consumeToken(state, plan.token, fingerprint(plan.anchor, plan.scope));

  const warnings: string[] = [...plan.warnings];

  let filesReceipt: RewindReceipt['files'] = null;
  let undoFiles: { restoreCheckpointId: string } | null = null;
  if (wants(plan.scope, 'files')) {
    if (mgr && plan.checkpoint) {
      try {
        const result = await mgr.restore(plan.checkpoint.id, { safetyCheckpoint: true });
        filesReceipt = {
          restored: true,
          checkpointId: result.checkpointId,
          safetyCheckpointId: result.safetyCheckpointId,
          restoredFileCount: result.restoredFiles.length,
          removedFileCount: result.removedFiles.length,
        };
        undoFiles = result.safetyCheckpointId ? { restoreCheckpointId: result.safetyCheckpointId } : null;
      } catch (err) {
        warnings.push(`files rewind failed: ${summarizeError(err)}`);
        filesReceipt = { restored: false, checkpointId: plan.checkpoint.id, safetyCheckpointId: null, restoredFileCount: 0, removedFileCount: 0 };
      }
    } else {
      filesReceipt = { restored: false, checkpointId: plan.checkpoint?.id ?? null, safetyCheckpointId: null, restoredFileCount: 0, removedFileCount: 0 };
    }
  }

  let convReceipt: RewindReceipt['conversation'] = null;
  let undoConversation: { undoSnapshotId: string } | null = null;
  let convAfterId: string | null = null;
  if (wants(plan.scope, 'conversation')) {
    const rec = resolveTurnAnchor(plan.anchor.sessionId, plan.anchor.turnId);
    if (rec) {
      const total = conv.getMessageCount();
      const keep = Math.min(rec.messageCount, total);
      const dropped = Math.max(0, total - keep);
      const undoSnapshotId = newId('rwc');
      state.snapshots.set(undoSnapshotId, conv.toJSON() as ConversationJson);
      conv.removeMessagesAfter(keep);
      conv.rebuildHistory();
      convAfterId = newId('rwc');
      state.snapshots.set(convAfterId, conv.toJSON() as ConversationJson);
      convReceipt = { rewound: true, droppedMessages: dropped, undoSnapshotId };
      undoConversation = { undoSnapshotId };
    } else {
      convReceipt = { rewound: false, droppedMessages: 0, undoSnapshotId: null };
    }
  }

  const undoAvailable = undoFiles !== null || undoConversation !== null;
  const receipt: RewindReceipt = {
    scope: plan.scope,
    turnId: plan.anchor.turnId,
    files: filesReceipt,
    conversation: convReceipt,
    undo: { files: undoFiles, conversation: undoConversation },
    undoAvailable,
    warnings,
  };

  if (undoAvailable) {
    state.undo.push({ receipt, convAfterId });
    state.redo.length = 0; // a fresh apply invalidates the redo stack
  }
  return receipt;
}

// ---------------------------------------------------------------------------
// /undo rewind & /redo rewind — reversal over the last receipt's undo points.
// Called from session-content.ts so the /undo and /redo commands stay single.
// ---------------------------------------------------------------------------

export interface RewindReversalResult {
  readonly handled: boolean;
  readonly message: string;
}

function restoreSnapshot(conv: ConversationManager, snapshot: ConversationJson | undefined): boolean {
  if (!snapshot) return false;
  conv.fromJSON(snapshot);
  conv.rebuildHistory();
  return true;
}

export async function undoLastRewind(ctx: CommandContext): Promise<RewindReversalResult> {
  const state = stateFor(ctx.session.runtime.sessionId);
  const entry = state.undo.pop();
  if (!entry) return { handled: false, message: 'No applied rewind to undo. (Bare /undo removes the last conversation turn.)' };

  const mgr = ctx.workspace.workspaceCheckpointManager;
  const parts: string[] = [];
  try {
    if (entry.receipt.undo.files && mgr) {
      await mgr.restore(entry.receipt.undo.files.restoreCheckpointId, { safetyCheckpoint: false });
      parts.push('files restored to pre-rewind state');
    }
    if (entry.receipt.undo.conversation) {
      if (restoreSnapshot(ctx.session.conversationManager, state.snapshots.get(entry.receipt.undo.conversation.undoSnapshotId))) {
        parts.push('conversation restored to pre-rewind state');
      }
    }
  } catch (err) {
    state.undo.push(entry);
    return { handled: true, message: `Undo rewind failed: ${summarizeError(err)}` };
  }
  state.redo.push(entry);
  ctx.renderRequest();
  return { handled: true, message: `Rewind undone: ${parts.join(', ') || 'nothing to reverse'}. Use /redo rewind to re-apply.` };
}

export async function redoLastRewind(ctx: CommandContext): Promise<RewindReversalResult> {
  const state = stateFor(ctx.session.runtime.sessionId);
  const entry = state.redo.pop();
  if (!entry) return { handled: false, message: 'No undone rewind to redo. (Bare /redo restores the last conversation turn.)' };

  const mgr = ctx.workspace.workspaceCheckpointManager;
  const parts: string[] = [];
  try {
    if (entry.receipt.files?.checkpointId && mgr) {
      await mgr.restore(entry.receipt.files.checkpointId, { safetyCheckpoint: false });
      parts.push('files re-applied');
    }
    if (entry.convAfterId && restoreSnapshot(ctx.session.conversationManager, state.snapshots.get(entry.convAfterId))) {
      parts.push('conversation re-applied');
    }
  } catch (err) {
    state.redo.push(entry);
    return { handled: true, message: `Redo rewind failed: ${summarizeError(err)}` };
  }
  state.undo.push(entry);
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

      let plan: RewindPlan;
      try {
        plan = await planRewind(ctx, anchor, scope);
      } catch (err) {
        ctx.print(`Could not plan rewind: ${summarizeError(err)}`);
        return;
      }

      if (!plan.filesAvailable && !plan.conversationAvailable) {
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

      if (plan.filesAvailable && plan.checkpoint && ctx.workspace.workspaceCheckpointManager) {
        try {
          const diff = await ctx.workspace.workspaceCheckpointManager.diff(plan.checkpoint.id);
          if (diff.unifiedDiff.trim()) diffPanel.loadRawDiff(diff.unifiedDiff);
          else diffPanel.showDiff('(no file changes)', '@@ -0,0 +0,0 @@\n Working tree already matches this checkpoint.');
        } catch {
          diffPanel.showDiff('(preview unavailable)', '@@ -0,0 +0,0 @@\n Could not load the checkpoint diff.');
        }
      } else {
        diffPanel.showDiff(
          `Conversation rewind — drop ${plan.messagesToDrop} message(s)`,
          `@@ rewind @@\n Keep ${plan.messagesRemaining} message(s), drop ${plan.messagesToDrop} after this turn. No files change.`,
        );
      }

      const summaryParts: string[] = [];
      if (wants(scope, 'files')) summaryParts.push(plan.filesAvailable ? `${plan.affectedFileCount} file(s)` : 'files: none');
      if (wants(scope, 'conversation')) summaryParts.push(plan.conversationAvailable ? `${plan.messagesToDrop} message(s)` : 'conversation: unavailable');

      diffPanel.confirmOverlay.arm({
        id: anchor.turnId,
        label: `${resolved.label} — rewind ${scope} (${summaryParts.join(', ')})`,
        verb: 'Rewind',
        onConfirm: async () => {
          try {
            const receipt = await applyRewind(ctx, plan);
            // addTypedSystemMessage persists the receipt into real session
            // history (indexed by getTranscriptEventIndex + save/load), and the
            // [Rewind] prefix is force-surfaced inline (system-message-router.ts).
            ctx.session.conversationManager.addTypedSystemMessage(buildRewindReceiptBlock(receipt), 'operational');
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
