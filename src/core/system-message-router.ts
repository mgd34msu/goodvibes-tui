/**
 * SystemMessageRouter — routes system messages to the appropriate surfaces
 * based on their kind and configured routing target.
 *
 * Delivery is resolved from the message KIND ('system' | 'wrfc' |
 * 'operational'), which maps to a configurable routing target
 * (ui.systemMessages / ui.wrfcMessages / ui.operationalMessages, each
 * 'panel' | 'conversation' | 'both'). resolveSystemMessageDelivery() turns that
 * target — plus whether a panel is attached — into a { toPanel, toConversation }
 * decision. The priority ('high' | 'low') only sets the panel emphasis; it does
 * not by itself decide conversation delivery.
 *
 * Critical override: errors, provider failovers, and compaction/context notices
 * (see FORCE_CONVERSATION_PREFIXES) ALWAYS also reach the main conversation,
 * regardless of target, so the user never has to open the SystemMessagesPanel
 * to discover them.
 *
 * Usage:
 * ```ts
 * const router = createSystemMessageRouter(conversation, panel);
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
import type { SystemMessagesPanel, SystemMessagePriority } from '../panels/system-messages-panel.ts';
import {
  classifySystemMessageKind,
  classifySystemMessagePriority,
  defaultSystemMessageTarget,
  resolveSystemMessageDelivery,
  type SystemMessageKind,
  type SystemMessageTarget,
} from '@/runtime/index.ts';

export type {
  SystemMessageKind,
  SystemMessageTarget,
} from '@/runtime/index.ts';

/**
 * Message categories that are operationally critical enough that the user must
 * see them inline in the main conversation, regardless of the configured
 * routing target (ui.systemMessages defaults to panel-only). Errors, provider
 * failovers, and compaction/context notices fall here: a user should never have
 * to open the SystemMessagesPanel to discover that a turn errored, a provider
 * failed over, or the context was compacted.
 *
 * Detection is by the stable message prefix tag, mirroring how the SDK
 * classifiers key off message content. This deliberately does NOT force every
 * high-priority message inline (model/provider/session confirmations still
 * honour the configured target), so the routing-target config stays meaningful.
 */
const FORCE_CONVERSATION_PREFIXES = ['[Error]', '[Failover]', '[Compaction]', '[Context]'] as const;

function mustReachConversation(message: string): boolean {
  return FORCE_CONVERSATION_PREFIXES.some((prefix) => message.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// SystemMessageRouter
// ---------------------------------------------------------------------------

/**
 * Routes system messages to the conversation and/or the SystemMessagesPanel
 * based on priority level.
 */
export class SystemMessageRouter {
  constructor(
    private readonly conversation: ConversationManager,
    private panel: SystemMessagesPanel | null,
    private readonly getTargetForKind: (kind: SystemMessageKind) => SystemMessageTarget = defaultSystemMessageTarget,
  ) {}

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Route a system message.
   *
   * Delivery is resolved from the kind and its configured target; priority only
   * sets panel emphasis. Critical notices (errors/failover/compaction, see
   * FORCE_CONVERSATION_PREFIXES) are additionally forced into the conversation.
   *
   * @param message  - Message text.
   * @param priority - 'high' | 'low'.
   * @param kind     - Classification kind ('system' | 'wrfc' | 'operational');
   *                   used to resolve routing target and conversation navigability.
   */
  routeTypedSystemMessage(
    message: string,
    priority: SystemMessagePriority,
    kind: SystemMessageKind,
  ): void {
    const target = this.getTargetForKind(kind);
    const delivery = resolveSystemMessageDelivery(target, this.panel !== null);
    if (delivery.toPanel) {
      this.panel?.push(message, priority);
    }
    // Critical notices (errors, failover, compaction) must surface inline even
    // when the configured target is panel-only — otherwise a user without the
    // SystemMessagesPanel open would never see them.
    const toConversation = delivery.toConversation || mustReachConversation(message);
    if (toConversation) {
      // addTypedSystemMessage threads the kind into the conversation so the
      // renderer can use kind-based navigability instead of substring matching.
      this.conversation.addTypedSystemMessage(message, kind);
    }
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

  /**
   * Returns the current panel reference.
   */
  getPanel(): SystemMessagesPanel | null {
    return this.panel;
  }

  /**
   * Replace the panel reference after construction (late binding).
   * Pass null to detach the panel.
   */
  setPanel(panel: SystemMessagesPanel | null): void {
    this.panel = panel;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SystemMessageRouter wired to the given conversation and panel.
 *
 * @param conversation - The ConversationManager for high-priority messages.
 * @param panel        - The SystemMessagesPanel for all messages. Can be null
 *                       (router still works; messages to panel are silently
 *                       dropped until a panel is available).
 */
export function createSystemMessageRouter(
  conversation: ConversationManager,
  panel: SystemMessagesPanel | null = null,
  getTargetForKind: (kind: SystemMessageKind) => SystemMessageTarget = defaultSystemMessageTarget,
): SystemMessageRouter {
  return new SystemMessageRouter(conversation, panel, getTargetForKind);
}
