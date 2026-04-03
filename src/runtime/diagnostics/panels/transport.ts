/**
 * Transport diagnostics panel data provider.
 *
 * Stores the history of protocol version negotiations for remote substrate
 * connections. Populated by calling `record()` after each handshake attempt,
 * whether successful or not.
 *
 * The panel exposes:
 * - The latest negotiated version/mode per connection
 * - Downgrade events with explicit reason codes
 * - Incompatibility failures so incompatible peers are surfaced to operators
 */
import type { TransportNegotiationEntry, PanelConfig } from '../types.ts';
import { DEFAULT_PANEL_CONFIG, appendBounded } from '../types.ts';
import type { NegotiatedProtocol, VersionNegotiationResult } from '../../remote/types.ts';

/**
 * Snapshot of the transport panel for a single connection.
 */
export interface TransportPanelSnapshot {
  /** Connection ID (local tracking ID). */
  readonly connectionId: string;
  /** Remote endpoint. */
  readonly endpoint: string;
  /** Most recent negotiation entry for this connection. */
  readonly latest: TransportNegotiationEntry;
  /** Full negotiation history for this connection, most recent first. */
  readonly history: readonly TransportNegotiationEntry[];
}

/**
 * TransportPanel — diagnostics data provider for transport protocol negotiations.
 *
 * Usage:
 * ```ts
 * const panel = new TransportPanel();
 *
 * // On handshake success:
 * panel.record(connectionId, endpoint, negotiationResult, offeredVersion, peerVersion);
 *
 * // In the diagnostics UI:
 * const snaps = panel.getAll();
 * const latest = panel.getLatest(connectionId);
 * const downgrades = panel.getDowngrades();
 * const failures = panel.getIncompatibilityFailures();
 * ```
 */
export class TransportPanel {
  private readonly _config: PanelConfig;
  /** Per-connection negotiation history (oldest-first within each list). */
  private readonly _histories = new Map<string, TransportNegotiationEntry[]>();
  /** Subscribers notified on any change. */
  private readonly _subscribers = new Set<() => void>();

  constructor(config: PanelConfig = DEFAULT_PANEL_CONFIG) {
    this._config = config;
  }

  /**
   * Record the result of a version negotiation.
   *
   * Call this from the ReconnectEngine's `onVersionNegotiated` callback
   * (success) or from the failure path when `incompatibilityCode` is present.
   *
   * @param connectionId - Local connection tracking ID.
   * @param endpoint - Remote endpoint URL or address.
   * @param result - The VersionNegotiationResult from `negotiateProtocolVersion()`.
   * @param offeredVersionLabel - The version label this side offered.
   * @param peerVersionLabel - The version label the peer advertised.
   */
  public record(
    connectionId: string,
    endpoint: string,
    result: VersionNegotiationResult,
    offeredVersionLabel: string,
    peerVersionLabel: string,
  ): void {
    const entry = this._toEntry(
      connectionId,
      endpoint,
      result,
      offeredVersionLabel,
      peerVersionLabel,
    );
    this._append(connectionId, entry);
    this._notify();
  }

  /**
   * Record a successful negotiation directly from a NegotiatedProtocol object.
   *
   * Convenience overload for callers that already have the NegotiatedProtocol
   * from a ConnectOutcome (skips re-running the matrix lookup).
   *
   * @param connectionId - Local connection tracking ID.
   * @param endpoint - Remote endpoint URL or address.
   * @param protocol - The NegotiatedProtocol from the successful ConnectOutcome.
   */
  public recordSuccess(
    connectionId: string,
    endpoint: string,
    protocol: NegotiatedProtocol,
  ): void {
    const entry: TransportNegotiationEntry = {
      connectionId,
      endpoint,
      success: true,
      negotiatedVersion: protocol.version.label,
      downgraded: protocol.downgraded,
      downgradeReason: protocol.downgradeReason,
      offeredVersion: protocol.offeredVersion.label,
      peerVersion: protocol.peerVersion.label,
      negotiatedAt: protocol.negotiatedAt,
    };
    this._append(connectionId, entry);
    this._notify();
  }

  /**
   * Record an incompatibility failure.
   *
   * Call this when a ConnectOutcome returns `incompatibilityCode`.
   *
   * @param connectionId - Local connection tracking ID.
   * @param endpoint - Remote endpoint URL or address.
   * @param incompatibilityCode - The structured code from the outcome.
   * @param incompatibilityReason - Human-readable explanation.
   * @param offeredVersionLabel - The version label this side offered.
   * @param peerVersionLabel - The version label the peer advertised.
   */
  public recordIncompatibility(
    connectionId: string,
    endpoint: string,
    incompatibilityCode:
      | 'major_version_mismatch'
      | 'peer_version_too_old'
      | 'peer_version_unsupported',
    incompatibilityReason: string,
    offeredVersionLabel: string,
    peerVersionLabel: string,
  ): void {
    const entry: TransportNegotiationEntry = {
      connectionId,
      endpoint,
      success: false,
      downgraded: false,
      offeredVersion: offeredVersionLabel,
      peerVersion: peerVersionLabel,
      incompatibilityCode,
      incompatibilityReason,
      negotiatedAt: Date.now(),
    };
    this._append(connectionId, entry);
    this._notify();
  }

  /**
   * Get the most recent negotiation entry for a connection.
   *
   * @param connectionId - The connection ID to look up.
   * @returns The latest entry, or undefined if no negotiation has been recorded.
   */
  public getLatest(connectionId: string): TransportNegotiationEntry | undefined {
    const history = this._histories.get(connectionId);
    return history?.[history.length - 1];
  }

  /**
   * Get the full negotiation history for a connection, most recent first.
   *
   * @param connectionId - The connection ID to look up.
   * @returns Array of entries, most recent first. Empty if unknown connection.
   */
  public getHistory(connectionId: string): readonly TransportNegotiationEntry[] {
    const history = this._histories.get(connectionId);
    if (!history || history.length === 0) return [];
    return [...history].reverse();
  }

  /**
   * Get a snapshot for every tracked connection, most recently updated first.
   */
  public getAll(): TransportPanelSnapshot[] {
    const snapshots: TransportPanelSnapshot[] = [];
    for (const [connectionId, history] of this._histories) {
      if (history.length === 0) continue;
      const latest = history[history.length - 1]!;
      snapshots.push({
        connectionId,
        endpoint: latest.endpoint,
        latest,
        history: [...history].reverse(),
      });
    }
    // Sort by most recently negotiated
    snapshots.sort((a, b) => b.latest.negotiatedAt - a.latest.negotiatedAt);
    return snapshots;
  }

  /**
   * Get all connections that experienced a protocol downgrade.
   * Includes only the latest negotiation per connection.
   */
  public getDowngrades(): TransportNegotiationEntry[] {
    const result: TransportNegotiationEntry[] = [];
    for (const history of this._histories.values()) {
      if (history.length === 0) continue;
      const latest = history[history.length - 1]!;
      if (latest.success && latest.downgraded) result.push(latest);
    }
    return result;
  }

  /**
   * Get all connections with recorded incompatibility failures.
   * These represent peers that could NOT proceed — surfaced explicitly
   * so operators know an incompatible peer attempted connection.
   */
  public getIncompatibilityFailures(): TransportNegotiationEntry[] {
    const result: TransportNegotiationEntry[] = [];
    for (const history of this._histories.values()) {
      for (const entry of history) {
        if (!entry.success && entry.incompatibilityCode) result.push(entry);
      }
    }
    // Most recent first
    result.sort((a, b) => b.negotiatedAt - a.negotiatedAt);
    return result;
  }

  /**
   * Summary counts across all connections.
   */
  public getSummary(): {
    totalConnections: number;
    successfulNegotiations: number;
    downgradedConnections: number;
    incompatibilityFailures: number;
  } {
    let successfulNegotiations = 0;
    let downgradedConnections = 0;
    let incompatibilityFailures = 0;

    for (const history of this._histories.values()) {
      for (const entry of history) {
        if (entry.success) {
          successfulNegotiations++;
          if (entry.downgraded) downgradedConnections++;
        } else if (entry.incompatibilityCode) {
          incompatibilityFailures++;
        }
      }
    }

    return {
      totalConnections: this._histories.size,
      successfulNegotiations,
      downgradedConnections,
      incompatibilityFailures,
    };
  }

  /**
   * Register a callback invoked whenever the data changes.
   * @returns An unsubscribe function.
   */
  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  /**
   * Remove all data for a specific connection.
   *
   * @param connectionId - The connection ID to remove.
   */
  public untrack(connectionId: string): void {
    if (this._histories.delete(connectionId)) {
      this._notify();
    }
  }

  /**
   * Release all subscriptions and clear internal state.
   */
  public dispose(): void {
    this._subscribers.clear();
    this._histories.clear();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _toEntry(
    connectionId: string,
    endpoint: string,
    result: VersionNegotiationResult,
    offeredVersionLabel: string,
    peerVersionLabel: string,
  ): TransportNegotiationEntry {
    if (result.proceed) {
      return {
        connectionId,
        endpoint,
        success: true,
        negotiatedVersion: result.protocol.version.label,
        downgraded: result.protocol.downgraded,
        downgradeReason: result.protocol.downgradeReason,
        offeredVersion: offeredVersionLabel,
        peerVersion: peerVersionLabel,
        negotiatedAt: result.protocol.negotiatedAt,
      };
    }

    return {
      connectionId,
      endpoint,
      success: false,
      downgraded: false,
      offeredVersion: offeredVersionLabel,
      peerVersion: peerVersionLabel,
      incompatibilityCode: result.incompatibilityCode,
      incompatibilityReason: result.incompatibilityReason,
      negotiatedAt: Date.now(),
    };
  }

  private _append(connectionId: string, entry: TransportNegotiationEntry): void {
    let history = this._histories.get(connectionId);
    if (!history) {
      history = [];
      this._histories.set(connectionId, history);
    }
    appendBounded(history, entry, this._config.bufferLimit);
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch (err) {
        // Non-fatal: subscriber errors must not crash the provider
        console.debug('[TransportPanel] subscriber error:', err);
      }
    }
  }
}
