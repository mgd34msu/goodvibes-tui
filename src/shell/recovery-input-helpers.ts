/**
 * Helper factories for main()'s stdin fast-path: the Ctrl+R recovery
 * persistence/panel-reopen callbacks and the one-key error-retry
 * affordance. Extracted from main.ts so the entrypoint stays under the
 * architecture line ceiling; main() wires these with its live services.
 */

import { copyFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ConversationMessageSnapshot } from '../core/conversation.ts';
import type { SessionReturnContextSummary, SessionSnapshot } from '@/runtime/index.ts';
import {
  checkRecoveryFile,
  deleteRecoveryFile as deleteLiveRecoveryFile,
  getRecoveryDir,
  getRecoveryFilePath,
  loadRecoveryConversation as loadLiveRecoveryConversation,
} from '@/runtime/index.ts';

/**
 * Fixed name of the single dismissed-recovery preserved sibling, kept inside
 * the per-session recovery directory. It is deliberately NOT a
 * `recovery-<sessionId>.jsonl` name, so `checkRecoveryFile` (which only scans
 * the per-session crash files) never mistakes it for a live crash snapshot.
 */
const PRESERVED_RECOVERY_FILENAME = 'recovery-dismissed.preserved.jsonl';

export interface PersistRecoveryDeps {
  readonly sessionManager: {
    save(id: string, msgs: never[], meta: { title: string; model: string; provider: string; timestamp: number }): unknown;
  };
  readonly runtime: { readonly sessionId: string; readonly model: string; readonly provider: string };
  readonly conversation: { readonly title?: string | null };
}

/** Persist a replayed/restored snapshot through the session manager. */
export function createPersistRecoverySnapshot(deps: PersistRecoveryDeps): (msgs: ConversationMessageSnapshot[]) => void {
  return (msgs) => void deps.sessionManager.save(deps.runtime.sessionId, msgs as never[], {
    title: deps.conversation.title ?? '',
    model: deps.runtime.model,
    provider: deps.runtime.provider,
    timestamp: Date.now(),
  });
}

export interface ReopenPanelsDeps {
  readonly panelManager: { open(id: string): void; show(): void };
  readonly render: () => void;
}

/** Reopen the panels recorded in a restored session's return context (capped at 4). */
export function createReopenRecoveryPanels(deps: ReopenPanelsDeps): (snapshot: SessionSnapshot) => void {
  return (snapshot) => {
    for (const panelId of (snapshot.returnContext?.openPanels ?? []).slice(0, 4)) {
      try { deps.panelManager.open(panelId); } catch { /* unknown panel id */ }
    }
    if ((snapshot.returnContext?.openPanels?.length ?? 0) > 0) { deps.panelManager.show(); deps.render(); }
  };
}

// ---------------------------------------------------------------------------
// Preserve the dismissed recovery snapshot.
//
// The SDK now keeps per-session crash snapshots (recovery-<sessionId>.jsonl),
// so this session's autosave no longer clobbers a crashed session's file. But
// checkRecoveryFile only offers a snapshot that is newer than the last clean
// session save — so once THIS session saves cleanly, an older dismissed crash
// snapshot would stop being offered. To keep the dismiss banner's promise
// ("still on disk; you will be asked again next time"), the moment the user
// dismisses (blocking-input.ts) we copy the crashed session's file aside to a
// single fixed preserved sibling in the recovery dir (it is inert — never
// subject to the newer-than-clean-save gate). Startup then checks BOTH the
// newest live crash file and the preserved sibling and offers whichever is
// newer (pickNewestRecoveryInfo), bounded to exactly one preserved file — a
// later dismiss replaces it, reported honestly (replacedPrevious) rather than
// silently dropping the older snapshot.
// ---------------------------------------------------------------------------

export interface RecoveryFileDeps {
  readonly homeDirectory: string;
  readonly surfaceRoot?: string | undefined;
  /**
   * Working directory — needed so the preserve step can resolve, via
   * checkRecoveryFile, WHICH per-session crash file is being dismissed (its
   * sessionId names the file to copy aside). Optional: the read-only preserved
   * helpers (check/load/delete) do not need it.
   */
  readonly workingDirectory?: string | undefined;
}

export interface PreservedRecoveryInfo {
  readonly title: string;
  readonly timestamp: number;
  readonly sessionId: string;
  readonly returnContext?: SessionReturnContextSummary | undefined;
}

export interface PreserveRecoveryResult {
  /** True if a live recovery.jsonl existed and was copied to the preserved sibling. */
  readonly preserved: boolean;
  /** True if an existing preserved sibling (from an earlier dismiss) was overwritten. */
  readonly replacedPrevious: boolean;
}

function preservedRecoveryPath(deps: RecoveryFileDeps): string {
  return join(getRecoveryDir(deps.homeDirectory, deps.surfaceRoot), PRESERVED_RECOVERY_FILENAME);
}

function readRecoveryMetaLine(path: string): { title?: string; timestamp?: number; sessionId?: string; returnContext?: SessionReturnContextSummary } | null {
  try {
    if (!existsSync(path)) return null;
    const firstLine = readFileSync(path, 'utf-8').split('\n')[0];
    if (!firstLine) return null;
    return JSON.parse(firstLine) as { title?: string; timestamp?: number; sessionId?: string; returnContext?: SessionReturnContextSummary };
  } catch {
    return null;
  }
}

/**
 * Copy the dismissed session's crash file aside to the preserved sibling.
 * Called once, at dismiss. The source is resolved live via checkRecoveryFile —
 * whose RecoveryFileInfo.sessionId names the per-session file to copy — so the
 * preserve captures exactly the snapshot the banner is offering, before any
 * clean save this session performs could supersede it by timestamp.
 */
export function createPreserveRecoveryFile(deps: RecoveryFileDeps): () => PreserveRecoveryResult {
  return () => {
    const info = checkRecoveryFile({ workingDirectory: deps.workingDirectory, homeDirectory: deps.homeDirectory, surfaceRoot: deps.surfaceRoot });
    if (!info) return { preserved: false, replacedPrevious: false };
    const live = getRecoveryFilePath(deps.homeDirectory, info.sessionId, deps.surfaceRoot);
    const preserved = preservedRecoveryPath(deps);
    if (!existsSync(live)) return { preserved: false, replacedPrevious: false };
    const replacedPrevious = existsSync(preserved);
    try {
      copyFileSync(live, preserved);
      return { preserved: true, replacedPrevious };
    } catch {
      return { preserved: false, replacedPrevious: false };
    }
  };
}

/**
 * Startup check for the preserved sibling — mirrors the SDK's
 * checkRecoveryFile meta read, but for the fixed preserved path. No
 * mtime-vs-last-clean-save gate: the preserved file is inert (never
 * autosaved-over) until explicitly replaced or cleared, so its mere
 * existence is actionable.
 */
export function checkPreservedRecoveryFile(deps: RecoveryFileDeps): PreservedRecoveryInfo | null {
  const meta = readRecoveryMetaLine(preservedRecoveryPath(deps));
  if (!meta) return null;
  return { title: meta.title ?? '', timestamp: meta.timestamp ?? 0, sessionId: meta.sessionId ?? '', returnContext: meta.returnContext };
}

/** Load the preserved sibling's full snapshot — same JSONL shape as recovery.jsonl since it's a byte-identical copy. */
export function loadPreservedRecoveryConversation(deps: RecoveryFileDeps): SessionSnapshot | null {
  const path = preservedRecoveryPath(deps);
  try {
    if (!existsSync(path)) return null;
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    if (lines.length < 2) return { messages: [] };
    const metaLine = JSON.parse(lines[0]!) as { title?: string; titleSource?: SessionSnapshot['titleSource']; returnContext?: SessionSnapshot['returnContext'] };
    return {
      title: metaLine.title,
      titleSource: metaLine.titleSource,
      returnContext: metaLine.returnContext,
      messages: lines.slice(1).map((line) => {
        const { type: _type, ...rest } = JSON.parse(line) as { type: string } & Record<string, unknown>;
        return rest;
      }),
    };
  } catch {
    return null;
  }
}

/** Remove the preserved sibling — called after it has been restored or discarded. */
export function deletePreservedRecoveryFile(deps: RecoveryFileDeps): void {
  try {
    unlinkSync(preservedRecoveryPath(deps));
  } catch {
    // missing file is fine
  }
}

/**
 * Pick the newer of the live vs. preserved recovery info for the startup
 * prompt, tagging which source it came from so the caller knows which
 * load/delete pair to use. Null when neither exists.
 */
export function pickNewestRecoveryInfo<T extends { readonly timestamp: number }>(
  live: T | null,
  preserved: T | null,
): (T & { readonly source: 'live' | 'preserved' }) | null {
  if (!live && !preserved) return null;
  if (!live) return { ...(preserved as T), source: 'preserved' };
  if (!preserved) return { ...live, source: 'live' };
  return preserved.timestamp > live.timestamp
    ? { ...(preserved as T), source: 'preserved' }
    : { ...live, source: 'live' };
}

/**
 * Startup entry point: resolve which recovery prompt (if any) main.ts should
 * show — the live recovery.jsonl, or an earlier dismiss's preserved sibling,
 * whichever is newer. Bundles checkRecoveryFile + checkPreservedRecoveryFile
 * + pickNewestRecoveryInfo so main.ts's entrypoint stays a one-liner.
 */
export function resolveStartupRecoveryInfo(
  deps: RecoveryFileDeps & { readonly workingDirectory: string },
): (PreservedRecoveryInfo & { readonly source: 'live' | 'preserved' }) | null {
  const live = checkRecoveryFile({ workingDirectory: deps.workingDirectory, homeDirectory: deps.homeDirectory });
  const preserved = checkPreservedRecoveryFile(deps);
  return pickNewestRecoveryInfo(live, preserved);
}

export interface RecoveryFileOps {
  readonly loadRecoveryConversation: () => SessionSnapshot | null;
  readonly deleteRecoveryFile: () => void;
  readonly preserveRecoveryFile?: () => PreserveRecoveryResult;
}

/**
 * Build the three source-aware recovery callbacks main.ts's stdin handler
 * wires into handleBlockingShellInput. `getSource` is read fresh by
 * load/delete on every call (main.ts's recoverySource can change between
 * events); preserveRecoveryFile is only ever wired when the CURRENT prompt
 * came from the live file (see createPreserveRecoveryFile's doc comment).
 */
export function createRecoveryFileOps(getSource: () => 'live' | 'preserved', deps: RecoveryFileDeps): RecoveryFileOps {
  return {
    loadRecoveryConversation: () => (getSource() === 'preserved' ? loadPreservedRecoveryConversation(deps) : loadLiveRecoveryConversation(deps)),
    deleteRecoveryFile: () => (getSource() === 'preserved' ? deletePreservedRecoveryFile(deps) : deleteLiveRecoveryFile(deps)),
    preserveRecoveryFile: getSource() === 'live' ? createPreserveRecoveryFile(deps) : undefined,
  };
}

export interface ErrorAffordanceDeps {
  /** True when the failover retry context is armed (a retry is actually possible). */
  readonly retryArmed: boolean;
  /** Re-submit the failed turn via the shared failover retry path (no duplicate user messages). */
  readonly retry: () => void;
  readonly openModelPicker: () => void;
  readonly render: () => void;
}

/**
 * Handle one keypress while the error-retry affordance is active.
 * 'r' retries on the current provider when armed; 'm' opens the model
 * picker. Returns true when the key was consumed; any other key returns
 * false so the caller routes it as normal input.
 */
export function handleErrorAffordanceKey(data: string, deps: ErrorAffordanceDeps): boolean {
  if (data === 'r' && deps.retryArmed) {
    deps.retry();
    deps.render();
    return true;
  }
  if (data === 'm') {
    deps.openModelPicker();
    deps.render();
    return true;
  }
  return false;
}
