/**
 * approval-raiser.ts — how a permission ask leaves this surface now.
 *
 * ── What changed ───────────────────────────────────────────────────────────
 *
 * The terminal app used to construct its OWN `ApprovalBroker`, and every ask
 * went into it: raised in-process, prompted at this terminal, decided here,
 * stored here. When the app also hosted the daemon that was coherent. Once the
 * daemon is a separate process it is not — an ask raised here was invisible to
 * every other surface, to the daemon's attention machinery, and to the phone
 * that was supposed to be able to answer it.
 *
 * So the ask goes to the daemon (`approvals.raise`) AND prompts here, and the
 * first real answer wins. The daemon owns the record; this terminal is one
 * participant that happens to be sitting in front of the user.
 *
 * ── The shape, precisely ───────────────────────────────────────────────────
 *
 * 1. Raise the ask on the daemon. The verb returns the pending record
 *    immediately — it deliberately does not park an HTTP request across a
 *    person's attention span.
 * 2. Prompt locally at the same time.
 * 3. Watch the raised id for a decision made elsewhere, by polling
 *    `approvals.list` on a short interval. (The `control.approval_update`
 *    stream carries the same transitions; polling is what this seam uses
 *    because a permission ask blocks a tool call for seconds, not hours, and a
 *    poll needs no long-lived connection to survive a laptop lid.)
 * 4. Whichever answers first is the decision. If the local prompt answered, the
 *    daemon is TOLD (`approvals.approve`/`approvals.deny`) so its record — the
 *    one every other surface reads — matches what happened here.
 *
 * ── When the daemon is not reachable ───────────────────────────────────────
 *
 * The ask is prompted locally and answered locally, and that is the honest
 * outcome: a user in front of a terminal can still approve their own tool call
 * with no daemon running. Nothing is silently swallowed and nothing pretends a
 * remote record exists. The refusal reason is logged once per process so a
 * misconfigured control plane is visible without a line per ask.
 *
 * ── The local prompt is not cancelled ──────────────────────────────────────
 *
 * A remote decision resolves the ask; the terminal prompt this surface already
 * drew stays on screen until the user dismisses it, and its answer is ignored
 * (the decision has been taken). This mirrors what the in-process broker did
 * with a `localPrompt` racing a wire decision — there is no cancel channel into
 * a drawn prompt, and inventing one is a renderer change, not a client-seam
 * change.
 */
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { PermissionPromptDecision, PermissionPromptRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import type { ApprovalRaiser } from '@pellux/goodvibes-sdk/platform/runtime/client-services';
import type { DaemonVerbCaller } from './operator-endpoint.ts';

/** The local ask: draw a prompt at this terminal and resolve with what the user chose. */
export type LocalPermissionPrompt = (request: PermissionPromptRequest) => Promise<PermissionPromptDecision>;

/** How often the raised id is re-read while the local prompt is open. */
const DEFAULT_POLL_INTERVAL_MS = 750;

export interface ClientApprovalRaiserOptions {
  readonly verbs: DaemonVerbCaller;
  /** The prompt this surface draws. Late-bound: the UI layer patches it in after boot. */
  readonly localPrompt: () => LocalPermissionPrompt;
  /** The live session id an ask belongs to, when there is one. */
  readonly sessionId?: () => string | null | undefined;
  /** Poll interval override (tests). */
  readonly pollIntervalMs?: number;
  /** Injectable sleep (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface RaisedRecord {
  readonly id: string;
  readonly status?: string;
  readonly decision?: { readonly approved?: boolean; readonly remember?: boolean; readonly note?: string } | undefined;
}

/** A record the daemon considers answered, mapped to the decision this surface returns. */
function readRemoteDecision(record: RaisedRecord | null | undefined): PermissionPromptDecision | null {
  if (!record) return null;
  const status = record.status;
  if (status === 'approved') return { approved: true, remember: record.decision?.remember === true };
  if (status === 'denied' || status === 'expired' || status === 'cancelled') {
    return { approved: false, remember: record.decision?.remember === true };
  }
  return null;
}

let unreachableLogged = false;

export function createClientApprovalRaiser(options: ClientApprovalRaiserOptions): ApprovalRaiser {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));

  const raiseOnDaemon = async (input: {
    request: PermissionPromptRequest;
    routeId?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<string | null> => {
    const probe = options.verbs.probe();
    if (!probe.available) {
      if (!unreachableLogged) {
        unreachableLogged = true;
        logger.info(`[approvals] asks are answered at this terminal only: ${probe.reason}`);
      }
      return null;
    }
    const sessionId = options.sessionId?.() ?? undefined;
    try {
      const raised = await options.verbs.invoke<{ approval?: RaisedRecord }>('approvals.raise', {
        request: input.request,
        ...(sessionId ? { sessionId } : {}),
        ...(input.routeId === undefined ? {} : { routeId: input.routeId }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
      return raised?.approval?.id ?? null;
    } catch (error) {
      logger.warn('[approvals] raising the ask on the daemon failed; prompting locally only', { error: summarizeError(error) });
      return null;
    }
  };

  const readRaised = async (approvalId: string): Promise<RaisedRecord | null> => {
    try {
      const listed = await options.verbs.invoke<unknown>('approvals.list', { includeResolved: true });
      const records: readonly RaisedRecord[] = Array.isArray(listed)
        ? listed as readonly RaisedRecord[]
        : ((listed as { approvals?: readonly RaisedRecord[] } | null)?.approvals ?? []);
      return records.find((entry) => entry.id === approvalId) ?? null;
    } catch (error) {
      logger.debug('[approvals] reading the raised ask back failed', { error: summarizeError(error) });
      return null;
    }
  };

  /** Resolve when the daemon's record for this id is answered. Never rejects. */
  const watchRemote = async (approvalId: string, done: () => boolean): Promise<PermissionPromptDecision | null> => {
    while (!done()) {
      await sleep(pollIntervalMs);
      if (done()) return null;
      const decision = readRemoteDecision(await readRaised(approvalId));
      if (decision) return decision;
    }
    return null;
  };

  /** Tell the daemon what this terminal decided, so its record is the truth. */
  const reportLocalDecision = async (approvalId: string, decision: PermissionPromptDecision): Promise<void> => {
    try {
      await options.verbs.invoke(decision.approved ? 'approvals.approve' : 'approvals.deny', {
        approvalId,
        actor: 'tui',
        actorSurface: 'tui',
        ...(decision.remember ? { remember: true } : {}),
      });
    } catch (error) {
      // The user has already been served; a failed write-back is a
      // record-consistency problem, not a reason to re-ask them.
      logger.warn('[approvals] recording this terminal\'s decision on the daemon failed', {
        approvalId,
        error: summarizeError(error),
      });
    }
  };

  return async (input) => {
    const approvalId = await raiseOnDaemon(input);
    const prompt = options.localPrompt();
    if (approvalId === null) return await prompt(input.request);

    let settled = false;
    const local = prompt(input.request).then((decision) => {
      settled = true;
      return { source: 'local' as const, decision };
    });
    const remote = watchRemote(approvalId, () => settled).then((decision) => {
      if (decision) settled = true;
      return decision ? { source: 'remote' as const, decision } : null;
    });

    const winner = await Promise.race([
      local,
      remote.then(async (result) => result ?? await local),
    ]);
    if (winner.source === 'local') void reportLocalDecision(approvalId, winner.decision);
    return winner.decision;
  };
}
