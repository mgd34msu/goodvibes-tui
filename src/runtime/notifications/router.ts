/**
 * NotificationRouter — routes incoming notifications to the appropriate
 * surface (conversation, status_bar, panel_only) based on level, per-domain
 * verbosity, quiet-while-typing state, and batch policy.
 *
 * Implements v3 Section 18.2 (conversation noise routing) and Section 18.4
 * (notification routing and policy).
 */

import type {
  DomainConfig,
  DomainVerbosity,
  Notification,
  RoutingDecision,
} from './types.ts';
import { applyDefaultPolicy } from './policies/default-policy.ts';
import { applyQuietTypingPolicy } from './policies/quiet-typing.ts';
import { BatchPolicy } from './policies/batch-policy.ts';

/** Default batch window passed through when batchWindowMs is invalid. */
const DEFAULT_BATCH_WINDOW_MS = 2_000;

/** Default verbosity applied to domains with no explicit configuration. */
const DEFAULT_VERBOSITY: DomainVerbosity = 'normal';

/**
 * NotificationRouter applies a layered policy stack to each notification:
 *
 * 1. **Default policy** — maps level + domain verbosity to a base target.
 * 2. **Quiet-typing policy** — suppresses non-critical above panel_only while typing.
 * 3. **Batch policy** — collapses repeated domain:level pairs within a time window.
 *
 * @example
 * ```ts
 * const router = createNotificationRouter();
 * router.setDomainVerbosity('tools', 'minimal');
 * router.setQuietWhileTyping(true);
 *
 * const decision = router.route(notification);
 * if (!decision.suppressed) {
 *   deliver(notification, decision.target);
 * }
 * ```
 */
export class NotificationRouter {
  /** Per-domain configuration (verbosity + optional panel overrides). */
  private readonly domains = new Map<string, DomainConfig>();

  /** Whether quiet-while-typing suppression is active. */
  private quietWhileTyping = false;

  /** Batch deduplication policy instance. */
  private readonly batchPolicy: BatchPolicy;

  constructor(batchWindowMs?: number) {
    const effectiveMs = batchWindowMs !== undefined
      ? Math.max(1, Number.isFinite(batchWindowMs) ? batchWindowMs : DEFAULT_BATCH_WINDOW_MS)
      : undefined;
    this.batchPolicy = new BatchPolicy(effectiveMs);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Route a notification through the full policy stack.
   *
   * Returns a RoutingDecision describing where the notification should be
   * delivered and whether it was suppressed or batched.
   *
   * @param notification - The notification to route.
   * @returns A RoutingDecision with target, optional batchKey, and optional suppressed reason.
   */
  route(notification: Notification): RoutingDecision {
    const verbosity = this.getDomainVerbosity(notification.domain);

    // 1. Apply default level-based routing policy.
    const baseTarget = applyDefaultPolicy(notification.level, verbosity);

    // 2. Apply quiet-while-typing suppression.
    const suppressReason = applyQuietTypingPolicy(
      notification.level,
      baseTarget,
      this.quietWhileTyping
    );

    if (suppressReason !== undefined) {
      return { target: baseTarget, suppressed: suppressReason };
    }

    // 3. Apply batch deduplication policy.
    const batchKey = this.batchPolicy.evaluate(notification);

    if (batchKey !== undefined) {
      // Notification collapsed into a batch group — route silently to panel.
      return { target: 'panel_only', batchKey };
    }

    return { target: baseTarget };
  }

  /**
   * Set the verbosity level for a specific domain.
   *
   * @param domain    - Domain name (e.g. 'tools', 'agents', 'git').
   * @param verbosity - Desired verbosity level.
   */
  setDomainVerbosity(domain: string, verbosity: DomainVerbosity): void {
    const existing = this.domains.get(domain);
    this.domains.set(domain, { ...existing, verbosity });
  }

  /**
   * Enable or disable quiet-while-typing suppression.
   *
   * When enabled, `info` and `warning` notifications that would surface above
   * `panel_only` are suppressed with reason `'quiet_while_typing'`.
   * `critical` notifications are never suppressed.
   *
   * @param enabled - Whether to activate quiet-while-typing mode.
   */
  setQuietWhileTyping(enabled: boolean): void {
    this.quietWhileTyping = enabled;
  }

  /**
   * Flush all pending batched notifications.
   *
   * Call this when a batch window expires (e.g. on a periodic timer) or when
   * quiet-typing mode deactivates, to surface any held notifications.
   *
   * @returns Array of notifications (with batch count) that were held in batch groups and are now ready for delivery.
   */
  flush(): Array<{ notification: Notification; batchCount: number }> {
    return this.batchPolicy.flush();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Resolve the effective domain verbosity, falling back to the default.
   *
   * @param domain - Domain name to look up.
   * @returns Effective DomainVerbosity for the domain.
   */
  private getDomainVerbosity(domain: string): DomainVerbosity {
    return this.domains.get(domain)?.verbosity ?? DEFAULT_VERBOSITY;
  }
}
