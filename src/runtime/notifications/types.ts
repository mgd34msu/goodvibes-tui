/**
 * Notification system types — core interfaces for the conversation noise
 * routing model (v3 Section 18.2). Operational noise is routed to dedicated
 * panels; the main conversation receives only critical failures, milestones,
 * and condensed summaries.
 */

/** Severity level of a notification. Controls routing priority. */
export type NotificationLevel = 'critical' | 'warning' | 'info' | 'debug';

/**
 * Surface target for a routed notification.
 * - `conversation` — inline in the main conversation (high-signal only)
 * - `status_bar`   — ephemeral status bar display
 * - `panel_only`   — routed silently to a dedicated panel
 */
export type NotificationTarget = 'conversation' | 'status_bar' | 'panel_only';

/**
 * Per-domain verbosity setting.
 * - `minimal` — only critical notifications surface above panel_only
 * - `normal`  — warnings surface to conversation/status_bar
 * - `verbose` — info notifications also surface above panel_only
 */
export type DomainVerbosity = 'minimal' | 'normal' | 'verbose';

/** An action that can be triggered when the user interacts with a notification. */
export interface NotificationAction {
  /** Human-readable label (e.g. "Jump to panel"). */
  label: string;
  /** The type of action to perform. */
  type: 'jump_to_panel' | 'dismiss' | 'custom';
  /** Panel ID to focus when type is `jump_to_panel`. */
  panelId?: string;
  /** Arbitrary payload for `custom` action types. */
  payload?: Record<string, unknown>;
}

/** A single notification to be routed and potentially displayed. */
export interface Notification {
  /** Unique identifier for this notification. */
  id: string;
  /**
   * Domain that produced this notification (e.g. 'tools', 'agents',
   * 'session', 'git'). Used for per-domain verbosity and routing policy.
   */
  domain: string;
  /** Severity level — determines base routing target. */
  level: NotificationLevel;
  /** Short human-readable title. */
  title: string;
  /** Optional extended body text. */
  body?: string;
  /** Unix timestamp in milliseconds when the notification was created. */
  timestamp: number;
  /** Panel ID that should display this notification when routed to panel_only. */
  panelId?: string;
  /** Optional action (e.g. jump to panel) presented alongside the notification. */
  action?: NotificationAction;
}

/**
 * The result of routing a single notification.
 * Contains the target surface and optional metadata about batching/suppression.
 */
export interface RoutingDecision {
  /** The surface where this notification should be delivered. */
  target: NotificationTarget;
  /**
   * Batch group key when this notification has been collapsed into a batch.
   * Consumers should coalesce all notifications sharing the same batchKey.
   */
  batchKey?: string;
  /**
   * When set, this notification was suppressed and should not be displayed.
   * The string value describes the suppression reason (e.g. 'quiet_while_typing').
   */
  suppressed?: string;
}

/** A notification paired with its routing decision. */
export interface RoutedNotification {
  /** The original notification. */
  notification: Notification;
  /** The routing decision applied to it. */
  decision: RoutingDecision;
}

/**
 * Per-domain routing configuration, merging domain verbosity with any
 * domain-specific panel target overrides.
 */
export interface DomainConfig {
  /** Verbosity level controlling how aggressively noise is suppressed. */
  verbosity: DomainVerbosity;
  /** Override the default panel target for panel_only notifications. */
  defaultPanelId?: string;
}
