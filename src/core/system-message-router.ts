/**
 * SystemMessageRouter — routes system messages to the appropriate surfaces
 * based on their kind and configured routing target.
 *
 * Delivery is resolved from the message KIND ('system' | 'wrfc' |
 * 'operational'), which maps to a configurable routing target
 * (ui.systemMessages / ui.wrfcMessages / ui.operationalMessages, each
 * 'panel' | 'conversation' | 'both'). resolveSystemMessageDelivery() turns
 * that target — plus whether a panel is attached — into a { toPanel,
 * toConversation } decision.
 *
 * W6.1 (the purge): the SystemMessagesPanel this router used to optionally
 * push into was DELETE-disposition (no surviving human surface — a picker
 * over the old panel registry, not something worth a dedicated console) and
 * has been removed entirely, so this router now always resolves with
 * `hasPanel = false`. Per resolveSystemMessageDelivery's own contract that
 * means EVERY kind/target combination (including 'panel'-only) falls back
 * to `toConversation: true` — nothing this router routes can vanish; it all
 * reaches conversation.addTypedSystemMessage(), which the transcript
 * renders as a navigable system line. This is deliberate, not a regression:
 * operational chatter that used to be tucked away in a rarely-opened panel
 * now surfaces inline, same as the messages that were already forced there
 * (see FORCE_CONVERSATION_PREFIXES below).
 *
 * Usage:
 * ```ts
 * const router = createSystemMessageRouter(conversation);
 * router.routeSystemMessage('[Provider] anthropic registered', 'low');
 * router.routeSystemMessage('[Session] Saved session abc123', 'high');
 * ```
 *
 * routeAuto() can be used as a drop-in replacement for
 * conversation.addSystemMessage(): it classifies the message kind and priority
 * automatically before routing.
 *
 * @remarks
 * This router handles system messages (operational status, errors). It is
 * distinct from NotificationRouter which handles domain-specific typed
 * notifications with policy-based routing.
 */

import type { ConversationManager } from './conversation';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import {
  classifySystemMessageKind,
  classifySystemMessagePriority,
  defaultSystemMessageTarget,
  resolveSystemMessageDelivery,
  type SystemMessageKind,
  type SystemMessageTarget,
} from '@/runtime/index.ts';
import {
  classifyNoise,
  foldProviderReplayLines,
  providerNameFromReplay,
  type NoiseGateDeps,
} from './system-message-noise.ts';

export type {
  SystemMessageKind,
  SystemMessageTarget,
} from '@/runtime/index.ts';

/** Panel emphasis level. Panel delivery was removed in W6.1 (see file doc); kept as the priority vocabulary for callers and for the SDK's delivery-resolution signature. */
export type SystemMessagePriority = 'high' | 'low';

/**
 * Message categories that are operationally critical enough that the user must
 * see them inline in the main conversation, regardless of the configured
 * routing target. Errors, provider failovers, and compaction/context notices
 * fall here: a user should never have to go hunting to discover that a turn
 * errored, a provider failed over, or the context was compacted.
 *
 * Detection is by the stable message prefix tag, mirroring how the SDK
 * classifiers key off message content. This deliberately does NOT force every
 * high-priority message inline (model/provider/session confirmations still
 * honour the configured target), so the routing-target config stays meaningful.
 */
const FORCE_CONVERSATION_PREFIXES = ['[Error]', '[Failover]', '[Routing]', '[Compaction]', '[Context]'] as const;

function mustReachConversation(message: string): boolean {
  return FORCE_CONVERSATION_PREFIXES.some((prefix) => message.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// SystemMessageRouter
// ---------------------------------------------------------------------------

/**
 * Routes system messages to the conversation based on priority level and
 * configured target. See file doc for the W6.1 panel removal.
 */
export class SystemMessageRouter {
  /** Buffered provider "from last session" replay lines, folded on a microtask. */
  private providerReplayBuffer: string[] = [];
  private providerReplayScheduled = false;

  constructor(
    private readonly conversation: ConversationManager,
    private readonly getTargetForKind: (kind: SystemMessageKind) => SystemMessageTarget = defaultSystemMessageTarget,
    /** Noise-gate dependencies (WRFC terminal-chain lookup). See system-message-noise.ts. */
    private readonly noiseDeps: NoiseGateDeps = {},
  ) {}

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Route a system message.
   *
   * Delivery is resolved from the kind and its configured target. Critical
   * notices (errors/failover/compaction, see FORCE_CONVERSATION_PREFIXES)
   * are additionally forced into the conversation.
   *
   * @param message  - Message text.
   * @param priority - 'high' | 'low' (kept for callers; no longer changes
   *                   delivery now that there is no panel to emphasize on).
   * @param kind     - Classification kind ('system' | 'wrfc' | 'operational');
   *                   used to resolve routing target and conversation navigability.
   */
  routeTypedSystemMessage(
    message: string,
    _priority: SystemMessagePriority,
    kind: SystemMessageKind,
  ): void {
    // Noise gate — keep first-run plumbing out of the transcript while the
    // information stays reachable via other live surfaces. (UX-B item 1.)
    const verdict = classifyNoise(message, this.noiseDeps);
    if (verdict.action === 'drop') return;
    if (verdict.action === 'foldProviderReplay') {
      this.bufferProviderReplay(message);
      return;
    }

    this.deliver(message, kind);
  }

  /** Post-noise-gate delivery: resolve target and append to the conversation. */
  private deliver(message: string, kind: SystemMessageKind): void {
    const target = this.getTargetForKind(kind);
    // hasPanel is always false post-W6.1 — resolveSystemMessageDelivery's own
    // contract means every target ('panel' | 'conversation' | 'both')
    // resolves toConversation: true in that case (see file doc).
    const delivery = resolveSystemMessageDelivery(target, false);
    const toConversation = delivery.toConversation || mustReachConversation(message);
    if (toConversation) {
      // addTypedSystemMessage threads the kind into the conversation so the
      // renderer can use kind-based navigability instead of substring matching.
      this.conversation.addTypedSystemMessage(message, kind);
    }
  }

  /**
   * Buffer a provider "from last session" replay line and schedule a microtask
   * flush. The SDK emits the whole persisted-provider burst synchronously, so a
   * single microtask captures the full burst and folds it to one quiet line.
   * (UX-B item 1b.)
   */
  private bufferProviderReplay(message: string): void {
    this.providerReplayBuffer.push(message);
    if (this.providerReplayScheduled) return;
    this.providerReplayScheduled = true;
    queueMicrotask(() => this.flushProviderReplay());
  }

  /**
   * Record the folded provider-replay summary and reset the buffer.
   *
   * Papercut sweep item 2: this used to `deliver()` the folded line into the
   * transcript — one line instead of a burst, but still boot plumbing the
   * user never asked to see there ("the transcript at boot shows product
   * signal only"). The persisted-provider set this summarizes is reachable
   * on demand via `/health provider` (providers-modal lists every registered
   * provider, discovered/local ones included) and `/model` (lists every
   * selectable model, discovered ones included) — so nothing is lost by
   * keeping it out of the transcript. It still goes to the activity log
   * (.goodvibes/logs/activity.md) for diagnosis. Only this boot-only "— from
   * last session" burst moves; unrelated provider-discovery lines emitted
   * mid-session (e.g. "[Scan] Found …", "[Scan] … no longer reachable") are
   * untouched — they never match PROVIDER_REPLAY_RE, so they never enter this
   * buffer/fold path and keep reaching the transcript as live product signal.
   */
  flushProviderReplay(): void {
    this.providerReplayScheduled = false;
    if (this.providerReplayBuffer.length === 0) return;
    const summary = foldProviderReplayLines(this.providerReplayBuffer);
    const providerNames = this.providerReplayBuffer.map(providerNameFromReplay);
    this.providerReplayBuffer = [];
    logger.info(summary, { count: providerNames.length, providers: providerNames });
  }

  routeSystemMessage(message: string, priority: SystemMessagePriority): void {
    this.routeTypedSystemMessage(message, priority, classifySystemMessageKind(message));
  }

  /**
   * Automatically classify the message priority by content and route.
   *
   * Useful as a drop-in replacement for conversation.addSystemMessage()
   * when you want the router to determine priority.
   *
   * @param message - Message text.
   */
  routeAuto(message: string): void {
    const priority: SystemMessagePriority = classifySystemMessagePriority(message);
    this.routeTypedSystemMessage(message, priority, classifySystemMessageKind(message));
  }

  /**
   * High-priority convenience shortcut.
   * Equivalent to routeSystemMessage(message, 'high').
   */
  high(message: string): void {
    this.routeSystemMessage(message, 'high');
  }

  /**
   * Low-priority convenience shortcut.
   * Equivalent to routeSystemMessage(message, 'low').
   */
  low(message: string): void {
    this.routeSystemMessage(message, 'low');
  }

  wrfc(message: string, priority: SystemMessagePriority = 'high'): void {
    this.routeTypedSystemMessage(message, priority, 'wrfc');
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SystemMessageRouter wired to the given conversation.
 *
 * @param conversation - The ConversationManager all routed messages reach.
 */
export function createSystemMessageRouter(
  conversation: ConversationManager,
  getTargetForKind: (kind: SystemMessageKind) => SystemMessageTarget = defaultSystemMessageTarget,
  noiseDeps: NoiseGateDeps = {},
): SystemMessageRouter {
  return new SystemMessageRouter(conversation, getTargetForKind, noiseDeps);
}
