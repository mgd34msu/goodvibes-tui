/**
 * SystemMessageRouter — routes system messages to the appropriate surfaces
 * based on priority.
 *
 * Two tiers:
 *   - 'high' — appears in both the main conversation AND the SystemMessagesPanel.
 *     Use for: fatal errors, model/provider confirmations, session save/load,
 *     compaction events (e.g. [Compaction] completed).
 *   - 'low'  — appears in the SystemMessagesPanel only (panel-only routing).
 *     Use for: scan results, provider discovery, plugin load/unload, feature
 *     flag changes, tool execution status, permission decisions,
 *     health/cascade events, debug/operational info.
 *
 * Usage:
 * ```ts
 * const router = createSystemMessageRouter(conversation, panel);
 * router.routeSystemMessage('[Provider] anthropic registered', 'low');
 * router.routeSystemMessage('[Session] Saved session abc123', 'high');
 * ```
 *
 * The router can also be used as a drop-in replacement for
 * conversation.addSystemMessage() calls — it classifies messages by priority
 * automatically when using routeAuto().
 *
 * @remarks
 * This router handles system messages (operational status, errors). It is
 * distinct from NotificationRouter which handles domain-specific typed
 * notifications with policy-based routing.
 */

import { getConfigSnapshot } from '../config/index.ts';
import type { ConfigManager } from '../config/manager.ts';
import type { ConversationManager } from './conversation.ts';
import type { SystemMessagesPanel, SystemMessagePriority } from '../panels/system-messages-panel.ts';

// ---------------------------------------------------------------------------
// Priority classification patterns
// ---------------------------------------------------------------------------

/**
 * Patterns that identify HIGH-priority messages:
 * fatal errors, model/provider switches, session save/load, compaction.
 */
const HIGH_PRIORITY_RE =
  /\bfatal\b|\bcrash\w*|\bunhandled exception\b|\[Model\]|\[Provider\].*switch|\[Session\].*(?:saved|loaded|restored)|\[Compaction\]|\[Recovery\].*Failed/i;

/**
 * Classify a message as high or low priority based on content.
 * Used by routeAuto() when the caller doesn't specify priority.
 *
 * @internal
 */
function classifyPriority(message: string): SystemMessagePriority {
  return HIGH_PRIORITY_RE.test(message) ? 'high' : 'low';
}

export type SystemMessageKind = 'system' | 'operational' | 'wrfc';
export type SystemMessageTarget = 'conversation' | 'panel' | 'both';

function defaultTargetForKind(kind: SystemMessageKind): SystemMessageTarget {
  if (kind === 'wrfc') return 'both';
  return 'panel';
}

function classifyKind(message: string): SystemMessageKind {
  if (/^\[WRFC\]/i.test(message)) return 'wrfc';
  if (/^\[(Scan|Local|Agents|MCP|Plugin|Hook|Tool|Exec|Remote|Bridge|Approval)\]/i.test(message)) {
    return 'operational';
  }
  return 'system';
}

function targetForKind(
  configManager: Pick<ConfigManager, 'getRaw'>,
  kind: SystemMessageKind,
): SystemMessageTarget {
  const ui = getConfigSnapshot(configManager).ui;
  if (kind === 'wrfc') return ui.wrfcMessages;
  if (kind === 'operational') return ui.operationalMessages;
  return ui.systemMessages;
}

function resolveDelivery(
  target: SystemMessageTarget,
  hasPanel: boolean,
): { readonly toPanel: boolean; readonly toConversation: boolean } {
  if (target === 'both') {
    return { toPanel: hasPanel, toConversation: true };
  }
  if (target === 'conversation') {
    return { toPanel: false, toConversation: true };
  }
  return hasPanel
    ? { toPanel: true, toConversation: false }
    : { toPanel: false, toConversation: true };
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
    private readonly getTargetForKind: (kind: SystemMessageKind) => SystemMessageTarget = defaultTargetForKind,
  ) {}

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Route a system message with explicit priority.
   *
   * - 'high': delivered to both conversation AND panel.
   * - 'low':  delivered to panel only (conversation is not touched).
   *
   * @param message  - Message text.
   * @param priority - 'high' | 'low'.
   */
  routeTypedSystemMessage(
    message: string,
    priority: SystemMessagePriority,
    kind: SystemMessageKind,
  ): void {
    const target = this.getTargetForKind(kind);
    const delivery = resolveDelivery(target, this.panel !== null);
    if (delivery.toPanel) {
      this.panel?.push(message, priority);
    }
    if (delivery.toConversation) {
      this.conversation.addSystemMessage(message);
    }
  }

  routeSystemMessage(message: string, priority: SystemMessagePriority): void {
    this.routeTypedSystemMessage(message, priority, classifyKind(message));
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
    const priority = classifyPriority(message);
    this.routeTypedSystemMessage(message, priority, classifyKind(message));
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
  getTargetForKind: (kind: SystemMessageKind) => SystemMessageTarget = defaultTargetForKind,
): SystemMessageRouter {
  return new SystemMessageRouter(conversation, panel, getTargetForKind);
}
