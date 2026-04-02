/**
 * MCP schema freshness tracking (v3 §11.2).
 *
 * Tracks per-server schema cache freshness with TTL-based staleness detection.
 * Used by McpLifecycleManager to decide when to trigger background re-fetches.
 */
import type { SchemaFreshness, McpSchemaRecord } from './types.ts';
import { logger } from '../../utils/logger.ts';

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Default TTL in ms after which a fresh record becomes stale (5 minutes). */
const DEFAULT_TTL_MS = 5 * 60 * 1_000;

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
 */
export class McpSchemaFreshnessTracker {
  private readonly records = new Map<string, McpSchemaRecord>();
  private readonly ttlMs: number;

  /**
   * @param ttlMs - TTL in ms before a fresh record becomes stale (default 5 min)
   */
  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
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
    record.freshness = 'fetch_failed';
    record.lastFetchError = error;
    record.consecutiveFailures += 1;
    logger.debug('McpSchemaFreshnessTracker: fetch failed', { serverName, error, consecutiveFailures: record.consecutiveFailures });
  }

  /**
   * Mark a server's schemas as stale (e.g. after reconnect or explicit invalidation).
   *
   * @param serverName - Server identifier
   */
  markStale(serverName: string): void {
    const record = this._getOrCreate(serverName);
    if (record.freshness === 'fresh') {
      record.freshness = 'stale';
      delete record.expiresAt;
      logger.debug('McpSchemaFreshnessTracker: marked stale', { serverName });
    }
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
}
