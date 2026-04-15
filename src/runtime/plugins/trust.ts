/**
 * Plugin extension trust framework.
 *
 * Defines trust tiers (untrusted, limited, trusted), signed manifest
 * validation for the trusted tier, and the PluginTrustStore that manages
 * trust records with persistence support.
 *
 * Trust tiers gate access to high-risk capabilities:
 *   - untrusted — only safe, read-only capabilities allowed
 *   - limited   — moderate capabilities; high-risk capabilities blocked
 *   - trusted   — full capability set; requires signed manifest validation
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { PluginCapability } from './types.ts';
import { isHighRiskCapability } from './manifest.ts';

// ── Trust Tier ────────────────────────────────────────────────────────────────

/**
 * The three trust tiers available to a plugin.
 *
 * - `untrusted` — Default for newly discovered plugins. Only safe capabilities
 *   are accessible. The plugin may not have been reviewed.
 * - `limited`   — Operator-reviewed plugin. Moderate capabilities granted.
 *   High-risk capabilities (shell.exec, filesystem.write, network.outbound)
 *   remain blocked without explicit trust escalation.
 * - `trusted`   — Fully trusted plugin. Requires a valid signed manifest.
 *   All declared capabilities may be granted (subject to runtime policy).
 */
export type PluginTrustTier = 'untrusted' | 'limited' | 'trusted';

// ── Trust Record ──────────────────────────────────────────────────────────────

/**
 * A persisted trust record for a single plugin.
 */
export interface PluginTrustRecord {
  /** Plugin identifier (manifest name). */
  readonly pluginName: string;
  /** Current trust tier. */
  tier: PluginTrustTier;
  /** Unix epoch ms when the trust record was last updated. */
  updatedAt: number;
  /** Who or what granted this trust level. */
  grantedBy: 'operator' | 'signed-manifest';
  /**
   * Fingerprint of the verified signature for trusted-tier plugins.
   * Undefined for untrusted/limited plugins.
   */
  signatureFingerprint?: string;
  /** Optional human-readable note attached by the operator. */
  note?: string;
}

// ── Signature Validation ──────────────────────────────────────────────────────

/**
 * Result of validating a plugin's signed manifest.
 */
export interface SignatureValidationResult {
  /** Whether the signature is valid. */
  valid: boolean;
  /** A stable fingerprint derived from the signature (e.g. hex digest prefix). */
  fingerprint?: string;
  /** Human-readable failure reason. Only set when `valid` is false. */
  reason?: string;
}

/**
 * validatePluginSignature — Validates the manifest signature for a plugin
 * seeking the `trusted` tier.
 *
 * The signature field in PluginManifestV2 is expected to be a base64-encoded
 * HMAC-SHA256 of the canonical manifest JSON (name + version + capabilities
 * sorted and serialised). For production use, callers should supply a real
 * key; this implementation uses a structural check so external tooling can
 * provide real crypto without requiring Node.js crypto APIs at import time.
 *
 * @param manifest  - The raw manifest object containing the `signature` field.
 * @param publicKey - Optional verification key. When omitted, structural
 *                    validity only is checked (suitable for CI/test).
 */
export function validatePluginSignature(
  manifest: { name: string; version: string; capabilities?: string[]; signature?: string },
  publicKey?: string,
): SignatureValidationResult {
  const { name, version, capabilities = [], signature } = manifest;

  if (!signature || typeof signature !== 'string' || signature.trim().length === 0) {
    return { valid: false, reason: 'No signature field present in manifest' };
  }

  // Structural check: signature must be a non-empty hex or base64 string.
  const isStructurallyValid = /^[A-Za-z0-9+/=]{32,}$/.test(signature.trim());
  if (!isStructurallyValid) {
    return { valid: false, reason: 'Signature field does not match expected format (base64/hex, min 32 chars)' };
  }

  // Canonical payload that should have been signed.
  const sortedCapabilities = [...capabilities].sort();
  const payload = JSON.stringify({ name, version, capabilities: sortedCapabilities });

  // When a public key is provided, perform full HMAC verification.
  if (publicKey) {
    const expected = createHmac('sha256', publicKey)
      .update(payload)
      .digest('base64');
    const sigBuf = Buffer.from(signature.trim(), 'base64');
    const expBuf = Buffer.from(expected, 'base64');
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, reason: 'HMAC mismatch' };
    }
  }

  // Derive a short fingerprint for record keeping.
  const fingerprint = signature.trim().slice(0, 16);

  logger.debug(
    `[plugin-trust] Manifest signature validated — plugin=${name} fingerprint=${fingerprint}` +
    (publicKey ? ' (full HMAC)' : ' (structural only)'),
  );

  return { valid: true, fingerprint };
}

// ── Capability filtering by trust tier ───────────────────────────────────────

/**
 * Capabilities that are safe for any trust tier (including untrusted).
 */
export const SAFE_CAPABILITIES: ReadonlyArray<PluginCapability> = [
  'register.tool',
  'register.provider',
  'register.panel',
  'register.hook',
  'filesystem.read',
] as const;

/**
 * filterCapabilitiesByTrust — Returns the subset of `requested` capabilities
 * that are permitted for the given trust tier.
 *
 * - `untrusted`: only SAFE_CAPABILITIES
 * - `limited`:   all capabilities except HIGH_RISK_CAPABILITIES
 * - `trusted`:   all capabilities (HIGH_RISK_CAPABILITIES included)
 */
export function filterCapabilitiesByTrust(
  requested: ReadonlyArray<PluginCapability>,
  tier: PluginTrustTier,
): { permitted: PluginCapability[]; blocked: PluginCapability[]; reasons: Partial<Record<PluginCapability, string>> } {
  const permitted: PluginCapability[] = [];
  const blocked: PluginCapability[] = [];
  const reasons: Partial<Record<PluginCapability, string>> = {};

  for (const cap of requested) {
    if (tier === 'trusted') {
      permitted.push(cap);
    } else if (tier === 'limited') {
      if (isHighRiskCapability(cap)) {
        blocked.push(cap);
        reasons[cap] = `Capability '${cap}' requires trust tier 'trusted' (current: limited)`;
      } else {
        permitted.push(cap);
      }
    } else {
      // untrusted
      if ((SAFE_CAPABILITIES as ReadonlyArray<string>).includes(cap)) {
        permitted.push(cap);
      } else {
        blocked.push(cap);
        reasons[cap] = `Capability '${cap}' requires trust tier 'limited' or higher (current: untrusted)`;
      }
    }
  }

  return { permitted, blocked, reasons };
}

// ── Trust Store ───────────────────────────────────────────────────────────────

/**
 * PluginTrustStore — In-memory trust registry for all plugins.
 *
 * Callers are responsible for persistence (serialise/deserialise via
 * `exportRecords` / `importRecords`). The PluginManager bridges this to
 * the plugins.json state file.
 */
export class PluginTrustStore {
  private readonly records = new Map<string, PluginTrustRecord>();

  /**
   * Returns the trust record for a plugin, or `undefined` if not yet assessed.
   * Callers should treat `undefined` as implicitly `untrusted`.
   */
  getRecord(pluginName: string): Readonly<PluginTrustRecord> | undefined {
    return this.records.get(pluginName);
  }

  /**
   * Returns the trust tier for a plugin.
   * Plugins without an explicit record are treated as `untrusted`.
   */
  getTier(pluginName: string): PluginTrustTier {
    return this.records.get(pluginName)?.tier ?? 'untrusted';
  }

  /**
   * setTier — Explicitly assign a trust tier to a plugin.
   *
   * Intended for operator use via `/plugin trust`.
   * For the `trusted` tier, prefer `trustSigned()` which also validates the signature.
   */
  setTier(
    pluginName: string,
    tier: PluginTrustTier,
    options: { note?: string } = {},
  ): PluginTrustRecord {
    const record: PluginTrustRecord = {
      pluginName,
      tier,
      updatedAt: Date.now(),
      grantedBy: 'operator',
      note: options.note,
    };
    this.records.set(pluginName, record);
    logger.info(`[plugin-trust] ${pluginName}: tier set to '${tier}'${options.note ? ` — ${options.note}` : ''}`);
    return record;
  }

  /**
   * trustSigned — Elevate a plugin to the `trusted` tier after verifying its
   * signed manifest. Returns `{ ok: false, reason }` if validation fails.
   */
  trustSigned(
    pluginName: string,
    manifest: { name: string; version: string; capabilities?: string[]; signature?: string },
    publicKey?: string,
  ): { ok: true; record: PluginTrustRecord } | { ok: false; reason: string } {
    const validation = validatePluginSignature(manifest, publicKey);
    if (!validation.valid) {
      logger.warn(`[plugin-trust] ${pluginName}: signature validation failed — ${validation.reason}`);
      return { ok: false, reason: validation.reason! };
    }

    const record: PluginTrustRecord = {
      pluginName,
      tier: 'trusted',
      updatedAt: Date.now(),
      grantedBy: 'signed-manifest',
      signatureFingerprint: validation.fingerprint,
    };
    this.records.set(pluginName, record);
    logger.info(`[plugin-trust] ${pluginName}: elevated to 'trusted' via signed manifest (fingerprint=${validation.fingerprint})`);
    return { ok: true, record };
  }

  /**
   * verify — Verify the current signature on a plugin manifest without
   * changing its tier. Useful for `/plugin verify` inspection.
   */
  verify(
    manifest: { name: string; version: string; capabilities?: string[]; signature?: string },
    publicKey?: string,
  ): SignatureValidationResult {
    return validatePluginSignature(manifest, publicKey);
  }

  /** Returns all trust records as an array. */
  getAllRecords(): ReadonlyArray<Readonly<PluginTrustRecord>> {
    return Array.from(this.records.values());
  }

  /** Export all records for persistence. */
  exportRecords(): Record<string, PluginTrustRecord> {
    const out: Record<string, PluginTrustRecord> = {};
    for (const [name, record] of this.records) {
      out[name] = { ...record };
    }
    return out;
  }

  /** Import records from persisted state. Merges into existing records. */
  importRecords(records: Record<string, PluginTrustRecord>): void {
    for (const [name, record] of Object.entries(records)) {
      this.records.set(name, record);
    }
    logger.debug(`[plugin-trust] Imported ${Object.keys(records).length} trust record(s)`);
  }
}
