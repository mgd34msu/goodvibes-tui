/**
 * resume-notice.ts — the boot-time "previous session found" transcript notice.
 *
 * UX-D item 1: a supervision-journey audit of 1.7.0 found that the TUI
 * accumulates rich resumable state on disk (a saved conversation, workspace
 * checkpoints, WRFC chain history) but never surfaces any of it at startup —
 * an operator has no way to know it exists short of already knowing the
 * right command. This module builds ONE compact, honest system-message block
 * printed after the splash and before the first prompt, summarizing exactly
 * what real state exists and how to reach it.
 *
 * Honesty constraints (verified against the actual runtime, not assumed):
 *   - There is no bare `/resume` command and no `/sessions` command (a
 *     pre-existing typo already lives in the splash's own hint at
 *     utils/splash-lines.ts — out of scope here, splash stays byte-identical).
 *     The real, working command is `/session resume <id|name>` — it always
 *     requires an explicit target. So this notice advertises
 *     `/session resume <id>` with the real last-session id substituted in,
 *     never a bare `/resume`.
 *   - `/checkpoints` works with zero arguments and behaves correctly at any
 *     checkpoint count (including zero) — advertised whenever the checkpoint
 *     manager is available in this session.
 *   - `/recall` (memory) is only advertised when the memory API is actually
 *     wired up in this session (context.clients?.knowledgeApi?.memory) —
 *     some runtimes don't have it, and claiming it works there would not be
 *     honest.
 *   - Every clause is independently gated on real data: a claim about
 *     checkpoints/chain history is only made when that data is known; "no
 *     chain history" means no chain clause is printed, not a fabricated one.
 */

import { readLastSessionPointer } from '@/runtime/index.ts';
import type { WrfcChain } from '@pellux/goodvibes-sdk/platform/agents';
import type { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import type { WorkspaceCheckpointManager } from '@pellux/goodvibes-sdk/platform/workspace';
import type { SystemMessageRouter } from '../core/system-message-router.ts';

// ─── Chain outcome ───────────────────────────────────────────────────────────

/**
 * Honest, human-facing outcome of a WRFC chain, derived from real chain
 * state rather than guessed. `chain.state` alone cannot distinguish a
 * user-cancelled chain from an ordinary review/gate failure. The SDK now
 * records that distinction first-class as `chain.failureKind` ('cancelled'
 * vs 'transport'/'other'), set by cancelChain()/failChain(), so that field
 * is the primary source of truth. Snapshots persisted before the field
 * existed lack it; for those we fall back to the owner-decision log, where
 * cancelChain() also records a `chain_cancelled` decision. A chain still
 * non-terminal after rehydrate's zombie-reap check (see wrfc-persistence.ts)
 * is reported as 'interrupted' — re-imported and live again, not history.
 */
export type ChainOutcome = 'passed' | 'failed' | 'cancelled' | 'interrupted';

/** Terminal WRFC states (mirrors wrfc-persistence.ts's own TERMINAL_STATES). */
function isTerminalState(state: WrfcChain['state']): boolean {
  return state === 'passed' || state === 'failed';
}

export function describeChainOutcome(chain: WrfcChain): ChainOutcome {
  if (!isTerminalState(chain.state)) return 'interrupted';
  if (chain.state === 'passed') return 'passed';
  // Primary: the SDK's first-class failureKind, authoritative for chains
  // failed/cancelled under the current SDK.
  if (chain.failureKind === 'cancelled') return 'cancelled';
  // Fallback for pre-failureKind snapshots: consult the owner-decision log,
  // where cancelChain() records a chain_cancelled decision.
  if (chain.failureKind === undefined) {
    const lastAction = chain.ownerDecisions.length > 0 ? chain.ownerDecisions[chain.ownerDecisions.length - 1]?.action : undefined;
    if (lastAction === 'chain_cancelled') return 'cancelled';
  }
  return 'failed';
}

/** Pick the most recently completed (or, if still interrupted, most recently created) chain from a set. Null if the set is empty. */
export function mostRecentChain(chains: readonly WrfcChain[]): WrfcChain | null {
  if (chains.length === 0) return null;
  return [...chains].sort((a, b) => (b.completedAt ?? b.createdAt ?? 0) - (a.completedAt ?? a.createdAt ?? 0))[0]!;
}

// ─── Notice text ─────────────────────────────────────────────────────────────

export interface ResumeNoticeFacts {
  /** Number of user turns in the last saved session. Null when there is no prior session (or it could not be read). */
  readonly turnCount: number | null;
  /** Session id of the last saved session — needed to build a truthful, directly-runnable resume hint. Null when there is no prior session. */
  readonly lastSessionId: string | null;
  /** Number of workspace checkpoints. Null when the checkpoint manager is unavailable in this session (not the same as zero). */
  readonly checkpointCount: number | null;
  /** Outcome of the most recently known WRFC chain. Null when there is no chain history at all. */
  readonly lastChainOutcome: ChainOutcome | null;
  /** Whether /recall (memory) is wired up in this session. */
  readonly memoryAvailable: boolean;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Build the boot resume notice text, or null when there is nothing to
 * report (no prior session, no checkpoints ever taken, no chain history —
 * a clean/new working directory prints nothing, respecting quiet startup).
 */
export function buildResumeNotice(facts: ResumeNoticeFacts): string | null {
  const hasSession = facts.lastSessionId !== null && facts.turnCount !== null;
  const checkpointsKnown = facts.checkpointCount !== null;
  const checkpointCount = facts.checkpointCount ?? 0;
  const hasCheckpoints = checkpointsKnown && checkpointCount > 0;
  const hasChainHistory = facts.lastChainOutcome !== null;

  if (!hasSession && !hasCheckpoints && !hasChainHistory) return null;

  const summary: string[] = [];
  if (hasSession) summary.push(plural(facts.turnCount!, 'turn'));
  // Show the checkpoint count whenever it's knowable and there's a reason to
  // (anchored to an existing session, or checkpoints genuinely exist even
  // without one) — never guessed when the manager is unavailable.
  if (checkpointsKnown && (hasSession || hasCheckpoints)) summary.push(plural(checkpointCount, 'checkpoint'));
  if (hasChainHistory) summary.push(`last chain: ${facts.lastChainOutcome}`);

  const lead = hasSession ? 'Previous session found' : 'Workspace history found';
  let notice = `${lead}: ${summary.join(', ')}`;

  const hints: string[] = [];
  // No bare `/resume` exists — /session resume always requires a target.
  if (hasSession) hints.push(`/session resume ${facts.lastSessionId} to continue`);
  if (hasCheckpoints) hints.push('/checkpoints to browse');
  if (facts.memoryAvailable) hints.push('/recall for memory');
  if (hints.length > 0) notice += ` — ${hints.join(' · ')}`;

  return notice;
}

// ─── Fact gathering (I/O) ────────────────────────────────────────────────────

export interface ResumeNoticeDeps {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /** Surface root used by session persistence — the TUI always uses 'tui'. */
  readonly surfaceRoot: string;
  /** Only `load()` is needed — kept narrow for testability. */
  readonly sessionManager: Pick<SessionManager, 'load'>;
  /** Undefined when checkpoints are not wired up in this session at all. Only `list()` is needed. */
  readonly checkpointManager: Pick<WorkspaceCheckpointManager, 'list'> | undefined;
  /** The full known-chain set from WrfcPersistence.knownChains, gathered post-rehydrate. */
  readonly chainHistory: readonly WrfcChain[];
  readonly memoryAvailable: boolean;
  readonly router: Pick<SystemMessageRouter, 'high'>;
}

/**
 * Read the last session's real turn count from its saved JSONL file. A user
 * turn is one stored message with role 'user' — the number of times the
 * operator spoke, which is what "N turns" means to a human reading the
 * notice (as opposed to a raw message count, which double-counts replies).
 * Returns null when there is no last-session pointer, or the pointed-to
 * session file is missing/corrupt — never a claim about a session that
 * cannot actually be resumed.
 */
function readLastSessionTurns(deps: Pick<ResumeNoticeDeps, 'workingDirectory' | 'homeDirectory' | 'surfaceRoot' | 'sessionManager'>): { turnCount: number; lastSessionId: string } | null {
  const lastSessionId = readLastSessionPointer({
    workingDirectory: deps.workingDirectory,
    homeDirectory: deps.homeDirectory,
    surfaceRoot: deps.surfaceRoot,
  });
  if (!lastSessionId) return null;
  try {
    const { messages } = deps.sessionManager.load(lastSessionId);
    const turnCount = messages.filter((m) => (m as { role?: unknown }).role === 'user').length;
    return { turnCount, lastSessionId };
  } catch {
    // Pointer file present but the session it points to is gone/corrupt —
    // there is nothing truthful to resume.
    return null;
  }
}

async function readCheckpointCount(mgr: ResumeNoticeDeps['checkpointManager']): Promise<number | null> {
  if (!mgr) return null;
  try {
    return (await mgr.list()).length;
  } catch {
    // Checkpoint manager present but its cached init() rejection makes every
    // call fail forever (see services.ts) — treat as "unknown", not zero.
    return null;
  }
}

/**
 * Gather real facts from disk/services and, if there is anything to report,
 * print ONE compact system message via `deps.router.high`. No-op (and no
 * message) when there is no prior session, no checkpoints, and no chain
 * history — a fresh working directory stays quiet.
 */
export async function announceResumeState(deps: ResumeNoticeDeps): Promise<void> {
  const session = readLastSessionTurns(deps);
  const checkpointCount = await readCheckpointCount(deps.checkpointManager);
  const lastChain = mostRecentChain(deps.chainHistory);

  const notice = buildResumeNotice({
    turnCount: session?.turnCount ?? null,
    lastSessionId: session?.lastSessionId ?? null,
    checkpointCount,
    lastChainOutcome: lastChain ? describeChainOutcome(lastChain) : null,
    memoryAvailable: deps.memoryAvailable,
  });

  if (notice) deps.router.high(notice);
}
