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
  routeSystemMessage(message: string, priority: SystemMessagePriority): void {
    // Always send to panel
    this.panel?.push(message, priority);

    // Only send high-priority messages to the conversation
    if (priority === 'high') {
      this.conversation.addSystemMessage(message);
    }
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
    this.routeSystemMessage(message, priority);
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
): SystemMessageRouter {
  return new SystemMessageRouter(conversation, panel);
}
