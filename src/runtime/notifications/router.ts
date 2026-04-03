/**
 * NotificationRouter — routes incoming notifications to the appropriate
 * surface (conversation, status_bar, panel_only) based on level, per-domain
 * verbosity, quiet-while-typing state, mode-context, burst detection, and
 * batch policy.
 *
 * Policy stack (applied in order):
 * 1. Default policy        — level + domain verbosity → base target
 * 2. Quiet-typing policy   — suppresses non-critical above panel_only while typing
 * 3. Mode-context policy   — HITL-mode-aware suppression (quiet/balanced/operator)
 * 4. Burst policy          — collapses rapid domain:level event floods
 * 5. Batch policy          — collapses repeated events within rolling time window
 *
 * The `adaptive-notification-suppression` feature flag gates policies 3 and 4.
 * When the flag is disabled, only the original policies 1, 2, and 5 are applied.
 */

import type {
  DomainConfig,
  DomainVerbosity,
  Notification,
  RoutingDecision,
} from './types.ts';
import { applyDefaultPolicy } from './policies/default-policy.ts';
import { applyQuietTypingPolicy } from './policies/quiet-typing.ts';
import { applyModeContextPolicy } from './policies/mode-context-policy.ts';
import { BatchPolicy } from './policies/batch-policy.ts';
import { BurstPolicy } from './policies/burst-policy.ts';

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

  /** Default domain verbosity applied to domains with no explicit config. */
  private defaultDomainVerbosity: DomainVerbosity = DEFAULT_VERBOSITY;

  /** Batch deduplication policy instance. */
  private batchPolicy: BatchPolicy;

  /** Burst detection policy instance. */
  private readonly burstPolicy: BurstPolicy;

  /**
   * Whether the adaptive-notification-suppression feature flag is enabled.
   * Controls policies 3 (mode-context) and 4 (burst).
   */
  private adaptiveSuppression: boolean;

  constructor(
    batchWindowMs?: number,
    adaptiveSuppression: boolean = false
  ) {
    const effectiveMs = batchWindowMs !== undefined
      ? Math.max(1, Number.isFinite(batchWindowMs) ? batchWindowMs : DEFAULT_BATCH_WINDOW_MS)
      : undefined;
    this.batchPolicy = new BatchPolicy(effectiveMs);
    this.burstPolicy = new BurstPolicy();
    this.adaptiveSuppression = adaptiveSuppression;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Route a notification through the full policy stack.
   *
   * Returns a RoutingDecision describing where the notification should be
   * delivered and whether it was suppressed or batched.
   *
   * @param notification - The notification to route.
   * @returns A RoutingDecision with target, reasonCode, optional batchKey,
   *          and optional suppressed reason.
   */
  route(notification: Notification): RoutingDecision {
    const verbosity = this.getDomainVerbosity(notification.domain);

    // 1. Apply default level-based routing policy.
    const baseTarget = applyDefaultPolicy(notification.level, verbosity);

    // 2. Apply quiet-while-typing suppression.
    const quietReason = applyQuietTypingPolicy(
      notification.level,
      baseTarget,
      this.quietWhileTyping
    );

    if (quietReason !== undefined) {
      return {
        target: baseTarget,
        suppressed: quietReason,
        reasonCode: 'quiet_while_typing',
      };
    }

    // 3. Apply mode-context suppression (gated by adaptive-notification-suppression flag).
    if (this.adaptiveSuppression) {
      const modeReasonCode = applyModeContextPolicy(
        notification.level,
        baseTarget,
        notification.tag,
        verbosity
      );

      if (modeReasonCode !== undefined) {
        return {
          target: 'panel_only',
          suppressed: modeReasonCode,
          reasonCode: modeReasonCode,
        };
      }

      // 4. Apply burst detection policy (exempt critical, milestone, and alert — they always surface).
      if (notification.level !== 'critical'
          && notification.tag !== 'milestone'
          && notification.tag !== 'alert') {
        const burstKey = this.burstPolicy.evaluate(notification);

        if (burstKey !== undefined) {
          return {
            target: 'panel_only',
            batchKey: burstKey,
            reasonCode: 'burst_collapsed',
          };
        }
      }
    }

    // 5. Apply batch deduplication policy (exempt critical — they always surface).
    if (notification.level !== 'critical') {
      const batchKey = this.batchPolicy.evaluate(notification);

      if (batchKey !== undefined) {
        // Notification collapsed into a batch group — route silently to panel.
        return {
          target: 'panel_only',
          batchKey,
          reasonCode: 'batch_window_collapsed',
        };
      }
    }

    return { target: baseTarget, reasonCode: 'allowed' };
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
   * Set the batch window duration in milliseconds.
   *
   * Replaces the current BatchPolicy instance with a fresh one using the
   * new window. Pending batches from the previous instance are discarded.
   *
   * @param ms - Batch window duration in milliseconds.
   */
  setBatchWindowMs(ms: number): void {
    const effectiveMs = Math.max(1, Number.isFinite(ms) ? ms : DEFAULT_BATCH_WINDOW_MS);
    this.batchPolicy = new BatchPolicy(effectiveMs);
  }

  /**
   * Set the default domain verbosity applied to domains with no explicit config.
   *
   * This verbosity is used by `getDomainVerbosity` when a domain has no
   * per-domain override set via `setDomainVerbosity`.
   *
   * @param verbosity - The default verbosity level.
   */
  setDefaultDomainVerbosity(verbosity: DomainVerbosity): void {
    this.defaultDomainVerbosity = verbosity;
  }

  /**
   * Enable or disable adaptive notification suppression (mode-context + burst policies).
   *
   * This corresponds to the `adaptive-notification-suppression` feature flag.
   * When disabled, only the base default + quiet-typing + batch policies apply.
   *
   * @param enabled - Whether to activate adaptive suppression.
   */
  setAdaptiveSuppression(enabled: boolean): void {
    this.adaptiveSuppression = enabled;
  }

  /**
   * Whether adaptive suppression is currently enabled.
   */
  isAdaptiveSuppressionEnabled(): boolean {
    return this.adaptiveSuppression;
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

  /**
   * Returns the active burst group keys from the burst policy.
   *
   * Useful at flush time to surface burst summaries.
   */
  getActiveBurstGroups(): string[] {
    return this.burstPolicy.getActiveGroups();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Resolve the effective domain verbosity, falling back to the default.
   *
   * @param domain - Domain name to look up.
   * @returns Effective DomainVerbosity for the domain.
   */
  private getDomainVerbosity(domain: string): DomainVerbosity {
    return this.domains.get(domain)?.verbosity ?? this.defaultDomainVerbosity;
  }
}
