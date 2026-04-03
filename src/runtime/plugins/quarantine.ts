/**
 * Plugin Quarantine Engine — §5.9.
 *
 * Quarantine removes a plugin's unsafe contribution effects without fully
 * unloading it. This allows the operator to isolate a suspicious plugin,
 * inspect it, then either restore or permanently disable it.
 *
 * Quarantine effects:
 *   - All high-risk capabilities are revoked in the resolved manifest.
 *   - The plugin is moved to a `quarantined` lifecycle bucket in the store.
 *   - A quarantine record is created with a timestamp and reason.
 *
 * Restore path:
 *   - `lift()` — Restores previously revoked capabilities (if trust was upgraded).
 *   - The caller is responsible for reloading the plugin after lifting.
 */

import { logger } from '../../utils/logger.ts';
import type { PluginCapability, PluginCapabilityManifest } from './types.ts';
import { isHighRiskCapability } from './manifest.ts';

// ── Quarantine Record ─────────────────────────────────────────────────────────

/**
 * A record describing a plugin currently in quarantine.
 */
export interface QuarantineRecord {
  /** Plugin name. */
  readonly pluginName: string;
  /** Unix epoch ms when quarantine was applied. */
  readonly quarantinedAt: number;
  /** Human-readable reason for quarantine. */
  readonly reason: string;
  /** The capabilities that were revoked when quarantine was applied. */
  readonly revokedCapabilities: ReadonlyArray<PluginCapability>;
  /** Whether the quarantine has been lifted. */
  lifted: boolean;
  /** Unix epoch ms when quarantine was lifted, if applicable. */
  liftedAt?: number;
}

// ── Quarantine Engine ─────────────────────────────────────────────────────────

/**
 * PluginQuarantineEngine — Tracks quarantined plugins and applies/revokes
 * capability restrictions.
 *
 * This is intentionally separate from the PluginLifecycleManager so that
 * quarantine can be applied without triggering a full state machine transition.
 * The lifecycle manager delegates to this engine when quarantine is requested.
 */
export class PluginQuarantineEngine {
  private readonly records = new Map<string, QuarantineRecord>();

  /**
   * quarantine — Apply quarantine to a plugin.
   *
   * Revokes all high-risk capabilities from the plugin's resolved manifest
   * and creates a quarantine record. The plugin remains in memory but its
   * unsafe contributions are neutralised.
   *
   * @param pluginName       - Plugin identifier.
   * @param capabilityManifest - The plugin's live capability manifest (mutated in place).
   * @param reason           - Human-readable reason for quarantine.
   * @returns The quarantine record, or null if already quarantined.
   */
  quarantine(
    pluginName: string,
    capabilityManifest: PluginCapabilityManifest,
    reason: string,
  ): QuarantineRecord | null {
    if (this.isQuarantined(pluginName)) {
      logger.warn(`[plugin-quarantine] ${pluginName}: already quarantined — skipping`);
      return null;
    }

    // Identify which currently-granted capabilities are high-risk.
    const revokedCapabilities: PluginCapability[] = capabilityManifest.granted.filter(
      (cap) => isHighRiskCapability(cap),
    );

    // Strip high-risk capabilities from the live manifest.
    capabilityManifest.granted = capabilityManifest.granted.filter(
      (cap) => !isHighRiskCapability(cap),
    );

    // Record denied reason for each revoked cap. Collect first, then assign once.
    const newDenied: PluginCapability[] = [];
    for (const cap of revokedCapabilities) {
      newDenied.push(cap);
      capabilityManifest.denialReasons[cap] = `Capability '${cap}' revoked: plugin quarantined — ${reason}`;
    }
    capabilityManifest.denied = [...capabilityManifest.denied, ...newDenied];

    const record: QuarantineRecord = {
      pluginName,
      quarantinedAt: Date.now(),
      reason,
      revokedCapabilities: Object.freeze(revokedCapabilities),
      lifted: false,
    };

    this.records.set(pluginName, record);

    logger.warn(
      `[plugin-quarantine] ${pluginName}: quarantined — ${reason}` +
      (revokedCapabilities.length > 0
        ? ` (revoked: [${revokedCapabilities.join(', ')}])`
        : ' (no high-risk capabilities were granted)'),
    );

    return record;
  }

  /**
   * lift — Lift quarantine for a plugin.
   *
   * Previously revoked capabilities are NOT automatically restored here;
   * the caller should trigger a re-resolve of the capability manifest
   * (e.g. by reloading the plugin) after lifting so that trust-tier
   * constraints are re-evaluated with the new tier.
   *
   * @returns true if quarantine was successfully lifted; false if not found.
   */
  lift(pluginName: string): boolean {
    const record = this.records.get(pluginName);
    if (!record) {
      logger.debug(`[plugin-quarantine] ${pluginName}: no quarantine record found — nothing to lift`);
      return false;
    }
    if (record.lifted) {
      logger.debug(`[plugin-quarantine] ${pluginName}: quarantine already lifted`);
      return false;
    }

    record.lifted = true;
    record.liftedAt = Date.now();

    logger.info(`[plugin-quarantine] ${pluginName}: quarantine lifted`);
    return true;
  }

  /** Returns whether a plugin is currently quarantined (and not lifted). */
  isQuarantined(pluginName: string): boolean {
    const record = this.records.get(pluginName);
    return record !== undefined && !record.lifted;
  }

  /** Returns the quarantine record for a plugin, or undefined. */
  getRecord(pluginName: string): Readonly<QuarantineRecord> | undefined {
    return this.records.get(pluginName);
  }

  /** Returns all quarantine records (including lifted ones). */
  getAllRecords(): ReadonlyArray<Readonly<QuarantineRecord>> {
    return Array.from(this.records.values());
  }

  /** Returns only active (not-lifted) quarantine records. */
  getActiveQuarantines(): ReadonlyArray<Readonly<QuarantineRecord>> {
    return Array.from(this.records.values()).filter((r) => !r.lifted);
  }

  /**
   * applyToNewManifest — Apply quarantine constraints to a freshly-resolved
   * capability manifest. Used when a plugin is reloaded while under quarantine.
   *
   * Unlike `quarantine()`, this does not create a new record — it reuses the
   * existing one. Call this during manifest re-resolution if `isQuarantined()`
   * is true.
   */
  applyToNewManifest(
    pluginName: string,
    capabilityManifest: PluginCapabilityManifest,
  ): void {
    if (!this.isQuarantined(pluginName)) return;

    const toRevoke: PluginCapability[] = capabilityManifest.granted.filter(
      (cap) => isHighRiskCapability(cap),
    );

    if (toRevoke.length === 0) return;

    capabilityManifest.granted = capabilityManifest.granted.filter(
      (cap) => !isHighRiskCapability(cap),
    );

    // Collect all denied caps first, then assign once to avoid quadratic churn.
    const reason = this.records.get(pluginName)?.reason ?? 'quarantined';
    const newDenied: PluginCapability[] = [];
    for (const cap of toRevoke) {
      newDenied.push(cap);
      capabilityManifest.denialReasons[cap] = `Capability '${cap}' blocked: plugin is quarantined — ${reason}`;
    }
    capabilityManifest.denied = [...capabilityManifest.denied, ...newDenied];

    logger.debug(
      `[plugin-quarantine] ${pluginName}: quarantine re-applied to reloaded manifest` +
      ` (blocked: [${toRevoke.join(', ')}])`,
    );
  }
}
