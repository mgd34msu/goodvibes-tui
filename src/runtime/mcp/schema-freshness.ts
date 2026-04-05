/**
 * MCP schema freshness tracking.
 *
 * Tracks per-server schema cache freshness with TTL-based staleness detection.
 * Used by McpLifecycleManager to decide when to trigger background re-fetches.
 */
import type { SchemaFreshness, McpSchemaRecord, QuarantineReason } from './types.ts';
import { logger } from '../../utils/logger.ts';

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Default TTL in ms after which a fresh record becomes stale (5 minutes). */
const DEFAULT_TTL_MS = 5 * 60 * 1_000;

/**
 * Default consecutive failure threshold before auto-quarantine is applied.
 * After this many consecutive fetch failures the schema is quarantined.
 */
const DEFAULT_QUARANTINE_THRESHOLD = 3;

// ── Tracker ───────────────────────────────────────────────────────────────────

/**
 * Tracks schema freshness for every registered MCP server.
 *
 * Lifecycle:
 *   1. `registerServer(name)` — initialised with `unknown` freshness.
 *   2. `markFresh(name)`      — called after a successful schema fetch.
 *   3. `markFailed(name, err)` — called after a failed fetch attempt.
 *   4. `markStale(name)`      — called when a server reconnects (cache invalidated).
 *   5. `getFreshness(name)`   — returns current freshness, accounting for TTL.
 *   6. `removeServer(name)`   — drops the record on permanent disconnection.
 *   7. `markQuarantined(name, reason, detail)` — places schema into quarantine;
 *      execution is blocked until `approveQuarantine` or a successful refresh.
 *   8. `approveQuarantine(name, operatorId)` — operator override: acknowledges
 *      the quarantine and temporarily unblocks execution.
 */
export class McpSchemaFreshnessTracker {
  private readonly records = new Map<string, McpSchemaRecord>();
  private readonly ttlMs: number;
  private readonly quarantineThreshold: number;

  /**
   * @param ttlMs               - TTL in ms before a fresh record becomes stale (default 5 min)
   * @param quarantineThreshold - consecutive failures before auto-quarantine (default 3)
   */
  constructor(ttlMs = DEFAULT_TTL_MS, quarantineThreshold = DEFAULT_QUARANTINE_THRESHOLD) {
    this.ttlMs = ttlMs;
    this.quarantineThreshold = quarantineThreshold;
  }

  // ── Registration ─────────────────────────────────────────────────────────

  /**
   * Register a new server with `unknown` freshness.
   * Idempotent — calling again for an already-registered server is a no-op.
   *
   * @param serverName - Server identifier
   */
  registerServer(serverName: string): void {
    if (this.records.has(serverName)) return;
    this.records.set(serverName, {
      serverName,
      freshness: 'unknown',
      consecutiveFailures: 0,
    });
  }

  /**
   * Remove a server's freshness record.
   *
   * @param serverName - Server identifier
   */
  removeServer(serverName: string): void {
    this.records.delete(serverName);
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  /**
   * Mark a server's schemas as freshly fetched.
   * Resets the consecutive failure counter and sets the expiry timestamp.
   *
   * @param serverName - Server identifier
   */
  markFresh(serverName: string): void {
    const record = this._getOrCreate(serverName);
    const now = Date.now();
    record.freshness = 'fresh';
    record.fetchedAt = now;
    record.expiresAt = now + this.ttlMs;
    record.consecutiveFailures = 0;
    delete record.lastFetchError;
    delete record.quarantine;
    logger.debug('McpSchemaFreshnessTracker: marked fresh', { serverName, expiresAt: record.expiresAt });
  }

  /**
   * Mark a schema fetch as failed.
   * Increments consecutive failure counter.
   *
   * @param serverName - Server identifier
   * @param error      - Error message from the failed attempt
   */
  markFailed(serverName: string, error: string): void {
    const record = this._getOrCreate(serverName);
    record.lastFetchError = error;
    record.consecutiveFailures += 1;

    if (record.consecutiveFailures >= this.quarantineThreshold) {
      // Auto-quarantine after threshold exceeded
      this._applyQuarantine(record, 'stale_threshold',
        `Schema fetch failed ${record.consecutiveFailures} consecutive times: ${error}`);
      logger.warn('McpSchemaFreshnessTracker: auto-quarantined after repeated failures', {
        serverName,
        consecutiveFailures: record.consecutiveFailures,
      });
    } else {
      record.freshness = 'fetch_failed';
      logger.debug('McpSchemaFreshnessTracker: fetch failed', { serverName, error, consecutiveFailures: record.consecutiveFailures });
    }
  }

  /**
   * Mark a server's schemas as stale (e.g. after reconnect or explicit invalidation).
   *
   * @param serverName - Server identifier
   */
  markStale(serverName: string): void {
    const record = this._getOrCreate(serverName);
    // Explicit guard: quarantined records must be released via approveQuarantine or markFresh.
    if (record.freshness === 'quarantined') return;
    if (record.freshness === 'fresh') {
      record.freshness = 'stale';
      delete record.expiresAt;
      logger.debug('McpSchemaFreshnessTracker: marked stale', { serverName });
    }
  }

  /**
   * Place a server's schema into quarantine.
   *
   * Quarantine blocks all tool execution on the server until the operator
   * approves an override (`approveQuarantine`) or a successful schema refresh
   * occurs (`markFresh`).
   *
   * @param serverName - Server identifier
   * @param reason     - Why quarantine is being applied
   * @param detail     - Optional human-readable detail shown in the MCP panel
   */
  markQuarantined(serverName: string, reason: QuarantineReason, detail?: string): void {
    const record = this._getOrCreate(serverName);
    this._applyQuarantine(record, reason, detail);
    logger.warn('McpSchemaFreshnessTracker: schema quarantined', { serverName, reason, detail });
  }

  /**
   * Operator override: acknowledge a quarantined schema and temporarily unblock
   * tool execution without refreshing the schema.
   *
   * The quarantine record is preserved (with override metadata) so auditors can
   * see that execution was approved under a quarantined schema. Freshness
   * transitions back to `stale` to signal a refresh is still needed.
   *
   * @param serverName - Server identifier
   * @param operatorId - Identifier of the operator acknowledging the override
   */
  approveQuarantine(serverName: string, operatorId: string): void {
    const record = this.records.get(serverName);
    if (!record) {
      logger.debug('McpSchemaFreshnessTracker: approveQuarantine called on unknown server', { serverName });
      return;
    }
    if (record.freshness !== 'quarantined') {
      logger.debug('McpSchemaFreshnessTracker: approveQuarantine called but not quarantined', { serverName, freshness: record.freshness });
      return;
    }

    const now = Date.now();
    if (record.quarantine) {
      record.quarantine.overrideAcknowledgedBy = operatorId;
      record.quarantine.overrideAcknowledgedAt = now;
    }

    // Transition to stale — fresh requires a real schema fetch.
    // Reset consecutiveFailures so the next transient error does not immediately
    // re-quarantine and undo the operator's override.
    record.freshness = 'stale';
    record.consecutiveFailures = 0;
    delete record.expiresAt;
    logger.warn('McpSchemaFreshnessTracker: quarantine override approved', { serverName, operatorId });
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /**
   * Return the current freshness of a server's schema cache.
   *
   * If the stored state is `fresh` but the TTL has elapsed, returns `stale`
   * and updates the record in-place.
   *
   * @param serverName - Server identifier
   */
  getFreshness(serverName: string): SchemaFreshness {
    const record = this.records.get(serverName);
    if (!record) return 'unknown';

    // Quarantine is sticky — it takes precedence over any TTL check
    if (record.freshness === 'quarantined') return 'quarantined';

    if (record.freshness === 'fresh' && record.expiresAt !== undefined) {
      if (Date.now() > record.expiresAt) {
        // TTL elapsed — transition to stale in-place
        record.freshness = 'stale';
        delete record.expiresAt;
        logger.debug('McpSchemaFreshnessTracker: TTL elapsed, marked stale', { serverName });
      }
    }

    return record.freshness;
  }

  /**
   * Returns `true` if the server's schema is quarantined and tool execution
   * should be blocked.
   *
   * @param serverName - Server identifier
   */
  isQuarantined(serverName: string): boolean {
    return this.records.get(serverName)?.freshness === 'quarantined';
  }

  /**
   * Return the full schema record for a server, or `null` if not registered.
   *
   * @param serverName - Server identifier
   */
  getRecord(serverName: string): McpSchemaRecord | null {
    return this.records.get(serverName) ?? null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _getOrCreate(serverName: string): McpSchemaRecord {
    let record = this.records.get(serverName);
    if (!record) {
      record = { serverName, freshness: 'unknown', consecutiveFailures: 0 };
      this.records.set(serverName, record);
    }
    return record;
  }

  private _applyQuarantine(record: McpSchemaRecord, reason: QuarantineReason, detail?: string): void {
    record.freshness = 'quarantined';
    delete record.expiresAt;
    record.quarantine = {
      reason,
      quarantinedAt: Date.now(),
      ...(detail !== undefined ? { detail } : {}),
    };
  }
}
