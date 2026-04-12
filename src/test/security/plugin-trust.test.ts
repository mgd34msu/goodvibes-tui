/**
 * Security: Plugin Extension Trust Framework (§5.9).
 *
 * Covers:
 * - Trust tier assignment and retrieval via PluginTrustStore
 * - Signed manifest validation (structural and fingerprint)
 * - Capability filtering by trust tier
 * - Quarantine: apply, lift, re-apply on reload
 * - resolveCapabilityManifest trust-tier integration
 * - HIGH_RISK_CAPABILITIES are blocked at untrusted/limited tier
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  PluginTrustStore,
  validatePluginSignature,
  filterCapabilitiesByTrust,
  SAFE_CAPABILITIES,
} from '../../runtime/plugins/trust.ts';
import { PluginQuarantineEngine } from '../../runtime/plugins/quarantine.ts';
import {
  resolveCapabilityManifest,
  isHighRiskCapability,
} from '../../runtime/plugins/manifest.ts';
import {
  HIGH_RISK_CAPABILITIES,
  ALL_CAPABILITIES,
} from '../../runtime/plugins/types.ts';
import type { PluginCapability, PluginCapabilityManifest, PluginManifestV2 } from '../../runtime/plugins/types.ts';
import type { PluginTrustTier } from '../../runtime/plugins/trust.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeManifest(caps: PluginCapability[], signature?: string): PluginManifestV2 {
  return {
    name: 'test-plugin',
    version: '1.0.0',
    description: 'A test plugin',
    capabilities: caps,
    signature,
  } as PluginManifestV2;
}

function makeCapManifest(caps: PluginCapability[]): PluginCapabilityManifest {
  return {
    requested: caps,
    granted: [...caps],
    denied: [],
    denialReasons: {},
  };
}

// ── PluginTrustStore ──────────────────────────────────────────────────────────

describe('security: PluginTrustStore', () => {
  let store: PluginTrustStore;

  beforeEach(() => {
    store = new PluginTrustStore();
  });

  test('unknown plugin defaults to untrusted tier', () => {
    expect(store.getTier('unknown-plugin')).toBe('untrusted');
  });

  test('getRecord returns undefined for untracked plugins', () => {
    expect(store.getRecord('missing')).toBeUndefined();
  });

  test('setTier assigns limited tier by operator', () => {
    const record = store.setTier('my-plugin', 'limited', { note: 'reviewed' });
    expect(record.tier).toBe('limited');
    expect(record.grantedBy).toBe('operator');
    expect(record.note).toBe('reviewed');
    expect(store.getTier('my-plugin')).toBe('limited');
  });

  test('setTier assigns trusted tier by operator', () => {
    const record = store.setTier('trusted-plugin', 'trusted');
    expect(record.tier).toBe('trusted');
    expect(store.getTier('trusted-plugin')).toBe('trusted');
  });

  test('setTier assigns untrusted tier', () => {
    store.setTier('my-plugin', 'limited');
    store.setTier('my-plugin', 'untrusted');
    expect(store.getTier('my-plugin')).toBe('untrusted');
  });

  test('trustSigned rejects manifest without signature', () => {
    const result = store.trustSigned('no-sig-plugin', {
      name: 'no-sig-plugin',
      version: '1.0.0',
    });
    expect(result.ok).toBe(false);
    expect(store.getTier('no-sig-plugin')).toBe('untrusted');
  });

  test('trustSigned accepts structurally valid base64 signature', () => {
    const validSig = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // 40 chars base64
    const result = store.trustSigned('signed-plugin', {
      name: 'signed-plugin',
      version: '1.0.0',
      capabilities: ['register.tool'],
      signature: validSig,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.tier).toBe('trusted');
      expect(result.record.grantedBy).toBe('signed-manifest');
      expect(result.record.signatureFingerprint).toBeTruthy();
      expect(store.getTier('signed-plugin')).toBe('trusted');
    }
  });

  test('trustSigned rejects short/invalid signature format', () => {
    const result = store.trustSigned('bad-sig-plugin', {
      name: 'bad-sig-plugin',
      version: '1.0.0',
      signature: 'short',
    });
    expect(result.ok).toBe(false);
  });

  test('verify returns valid for structurally correct signature', () => {
    const result = store.verify({
      name: 'x',
      version: '1.0.0',
      signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(result.valid).toBe(true);
    expect(result.fingerprint).toBeTruthy();
  });

  test('verify returns invalid for missing signature', () => {
    const result = store.verify({ name: 'x', version: '1.0.0' });
    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  test('exportRecords and importRecords round-trip', () => {
    store.setTier('plugin-a', 'limited');
    store.setTier('plugin-b', 'trusted');
    const exported = store.exportRecords();

    const store2 = new PluginTrustStore();
    store2.importRecords(exported);
    expect(store2.getTier('plugin-a')).toBe('limited');
    expect(store2.getTier('plugin-b')).toBe('trusted');
  });
});

// ── validatePluginSignature ───────────────────────────────────────────────────

describe('security: validatePluginSignature', () => {
  test('returns invalid for missing signature', () => {
    const result = validatePluginSignature({ name: 'p', version: '1.0.0' });
    expect(result.valid).toBe(false);
  });

  test('returns invalid for empty signature string', () => {
    const result = validatePluginSignature({ name: 'p', version: '1.0.0', signature: '   ' });
    expect(result.valid).toBe(false);
  });

  test('returns invalid for too-short signature', () => {
    const result = validatePluginSignature({ name: 'p', version: '1.0.0', signature: 'abc123' });
    expect(result.valid).toBe(false);
  });

  test('returns valid for base64 string of 40+ chars', () => {
    const sig = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn';
    const result = validatePluginSignature({ name: 'p', version: '1.0.0', signature: sig });
    expect(result.valid).toBe(true);
    expect(result.fingerprint).toBe(sig.slice(0, 16));
  });

  test('fingerprint is first 16 chars of signature', () => {
    const sig = 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
    const result = validatePluginSignature({ name: 'p', version: '1.0.0', signature: sig });
    expect(result.fingerprint).toBe('ZZZZZZZZZZZZZZZZ');
  });
});

// ── filterCapabilitiesByTrust ─────────────────────────────────────────────────

describe('security: filterCapabilitiesByTrust', () => {
  const allCaps = [...ALL_CAPABILITIES];
  const highRisk = [...HIGH_RISK_CAPABILITIES];

  test('untrusted tier: only safe capabilities permitted', () => {
    const { permitted, blocked } = filterCapabilitiesByTrust(allCaps, 'untrusted');
    for (const cap of permitted) {
      expect((SAFE_CAPABILITIES as ReadonlyArray<string>).includes(cap)).toBe(true);
    }
    for (const cap of highRisk) {
      expect(blocked).toContain(cap);
    }
  });

  test('untrusted tier: no high-risk capabilities permitted', () => {
    const { permitted } = filterCapabilitiesByTrust(highRisk, 'untrusted');
    expect(permitted).toHaveLength(0);
  });

  test('limited tier: blocks high-risk capabilities', () => {
    const { permitted, blocked } = filterCapabilitiesByTrust(allCaps, 'limited');
    for (const cap of highRisk) {
      expect(blocked).toContain(cap);
      expect(permitted).not.toContain(cap);
    }
  });

  test('limited tier: permits safe capabilities', () => {
    const { permitted } = filterCapabilitiesByTrust(['register.tool', 'filesystem.read'], 'limited');
    expect(permitted).toContain('register.tool');
    expect(permitted).toContain('filesystem.read');
  });

  test('trusted tier: permits all capabilities including high-risk', () => {
    const { permitted, blocked } = filterCapabilitiesByTrust(allCaps, 'trusted');
    expect(blocked).toHaveLength(0);
    for (const cap of allCaps) {
      expect(permitted).toContain(cap);
    }
  });

  test('denial reasons populated for blocked capabilities', () => {
    const { reasons, blocked } = filterCapabilitiesByTrust(['shell.exec', 'filesystem.read'], 'untrusted');
    expect(blocked).toContain('shell.exec');
    expect(reasons['shell.exec']).toBeTruthy();
    expect(reasons['filesystem.read']).toBeUndefined();
  });
});

// ── resolveCapabilityManifest with trust tier ─────────────────────────────────

describe('security: resolveCapabilityManifest trust integration', () => {
  test('untrusted plugin: high-risk capabilities are denied', () => {
    const manifest = makeManifest(['shell.exec', 'filesystem.write', 'network.outbound', 'register.tool']);
    const resolved = resolveCapabilityManifest('test-plugin', manifest, () => true, 'untrusted');
    expect(resolved.granted).not.toContain('shell.exec');
    expect(resolved.granted).not.toContain('filesystem.write');
    expect(resolved.granted).not.toContain('network.outbound');
    expect(resolved.granted).toContain('register.tool');
    expect(resolved.denied).toContain('shell.exec');
  });

  test('limited plugin: high-risk capabilities are denied', () => {
    const manifest = makeManifest(['shell.exec', 'filesystem.read']);
    const resolved = resolveCapabilityManifest('test-plugin', manifest, () => true, 'limited');
    expect(resolved.granted).not.toContain('shell.exec');
    expect(resolved.granted).toContain('filesystem.read');
    expect(resolved.denied).toContain('shell.exec');
  });

  test('trusted plugin: high-risk capabilities are granted (policy permitting)', () => {
    const manifest = makeManifest(['shell.exec', 'filesystem.write', 'network.outbound']);
    const resolved = resolveCapabilityManifest('test-plugin', manifest, () => true, 'trusted');
    expect(resolved.granted).toContain('shell.exec');
    expect(resolved.granted).toContain('filesystem.write');
    expect(resolved.granted).toContain('network.outbound');
    expect(resolved.denied).toHaveLength(0);
  });

  test('trusted plugin: policy can still deny high-risk capabilities', () => {
    const manifest = makeManifest(['shell.exec', 'filesystem.write']);
    const policy = (_name: string, cap: PluginCapability) => cap !== 'shell.exec';
    const resolved = resolveCapabilityManifest('test-plugin', manifest, policy, 'trusted');
    expect(resolved.granted).not.toContain('shell.exec');
    expect(resolved.granted).toContain('filesystem.write');
    expect(resolved.denied).toContain('shell.exec');
    expect(resolved.denialReasons['shell.exec']).toContain('policy');
  });

  test('default tier (omitted) behaves as untrusted', () => {
    const manifest = makeManifest(['shell.exec', 'register.hook']);
    const resolved = resolveCapabilityManifest('test-plugin', manifest);
    expect(resolved.granted).not.toContain('shell.exec');
    expect(resolved.granted).toContain('register.hook');
  });
});

// ── HIGH_RISK_CAPABILITIES constant ──────────────────────────────────────────

describe('security: HIGH_RISK_CAPABILITIES', () => {
  test('shell.exec is high-risk', () => {
    expect(isHighRiskCapability('shell.exec')).toBe(true);
  });

  test('filesystem.write is high-risk', () => {
    expect(isHighRiskCapability('filesystem.write')).toBe(true);
  });

  test('network.outbound is high-risk', () => {
    expect(isHighRiskCapability('network.outbound')).toBe(true);
  });

  test('register.tool is not high-risk', () => {
    expect(isHighRiskCapability('register.tool')).toBe(false);
  });

  test('filesystem.read is not high-risk', () => {
    expect(isHighRiskCapability('filesystem.read')).toBe(false);
  });
});

// ── PluginQuarantineEngine ────────────────────────────────────────────────────

describe('security: PluginQuarantineEngine', () => {
  let engine: PluginQuarantineEngine;

  beforeEach(() => {
    engine = new PluginQuarantineEngine();
  });

  test('isQuarantined returns false for untracked plugin', () => {
    expect(engine.isQuarantined('unknown')).toBe(false);
  });

  test('quarantine revokes high-risk capabilities from manifest', () => {
    const manifest = makeCapManifest(['shell.exec', 'filesystem.write', 'register.tool']);
    engine.quarantine('dangerous-plugin', manifest, 'security concern');

    expect(engine.isQuarantined('dangerous-plugin')).toBe(true);
    expect(manifest.granted).not.toContain('shell.exec');
    expect(manifest.granted).not.toContain('filesystem.write');
    expect(manifest.granted).toContain('register.tool');
    expect(manifest.denied).toContain('shell.exec');
    expect(manifest.denied).toContain('filesystem.write');
  });

  test('quarantine records the reason and revoked capabilities', () => {
    const manifest = makeCapManifest(['network.outbound', 'filesystem.read']);
    const record = engine.quarantine('plugin', manifest, 'suspicious network activity');

    expect(record).not.toBeNull();
    expect(record!.reason).toBe('suspicious network activity');
    expect(record!.revokedCapabilities).toContain('network.outbound');
    expect(record!.revokedCapabilities).not.toContain('filesystem.read');
    expect(record!.lifted).toBe(false);
  });

  test('quarantine on already-quarantined plugin returns null', () => {
    const manifest = makeCapManifest(['shell.exec']);
    engine.quarantine('plugin', manifest, 'first');
    const second = engine.quarantine('plugin', manifest, 'second');
    expect(second).toBeNull();
  });

  test('quarantine plugin with no high-risk capabilities creates record with empty revokedCapabilities', () => {
    const manifest = makeCapManifest(['register.tool', 'filesystem.read']);
    const record = engine.quarantine('safe-plugin', manifest, 'precaution');
    expect(record).not.toBeNull();
    expect(record!.revokedCapabilities).toHaveLength(0);
    expect(manifest.granted).toContain('register.tool');
  });

  test('lift removes active quarantine', () => {
    const manifest = makeCapManifest(['shell.exec']);
    engine.quarantine('plugin', manifest, 'test');
    expect(engine.isQuarantined('plugin')).toBe(true);

    const lifted = engine.lift('plugin');
    expect(lifted).toBe(true);
    expect(engine.isQuarantined('plugin')).toBe(false);
  });

  test('lift returns false for non-quarantined plugin', () => {
    expect(engine.lift('not-quarantined')).toBe(false);
  });

  test('lift sets liftedAt timestamp', () => {
    const manifest = makeCapManifest(['network.outbound']);
    engine.quarantine('plugin', manifest, 'test');
    engine.lift('plugin');
    const record = engine.getRecord('plugin')!;
    expect(record.liftedAt).toBeGreaterThan(0);
    expect(record.lifted).toBe(true);
  });

  test('getActiveQuarantines excludes lifted records', () => {
    const manifest1 = makeCapManifest(['shell.exec']);
    const manifest2 = makeCapManifest(['network.outbound']);
    engine.quarantine('plugin-a', manifest1, 'test');
    engine.quarantine('plugin-b', manifest2, 'test');
    engine.lift('plugin-a');

    const active = engine.getActiveQuarantines();
    expect(active.some((r) => r.pluginName === 'plugin-a')).toBe(false);
    expect(active.some((r) => r.pluginName === 'plugin-b')).toBe(true);
  });

  test('applyToNewManifest re-applies quarantine constraints on reload', () => {
    // Initial quarantine
    const manifest = makeCapManifest(['shell.exec', 'register.tool']);
    engine.quarantine('plugin', manifest, 'security concern');

    // Simulate reload: fresh manifest with full capabilities
    const reloadedManifest = makeCapManifest(['shell.exec', 'register.tool']);
    engine.applyToNewManifest('plugin', reloadedManifest);

    expect(reloadedManifest.granted).not.toContain('shell.exec');
    expect(reloadedManifest.granted).toContain('register.tool');
    expect(reloadedManifest.denied).toContain('shell.exec');
  });

  test('applyToNewManifest is no-op when quarantine is lifted', () => {
    const manifest = makeCapManifest(['shell.exec']);
    engine.quarantine('plugin', manifest, 'test');
    engine.lift('plugin');

    const reloadedManifest = makeCapManifest(['shell.exec', 'register.tool']);
    engine.applyToNewManifest('plugin', reloadedManifest);

    // After lift, applyToNewManifest should not revoke anything.
    expect(reloadedManifest.granted).toContain('shell.exec');
  });
});

// ── PluginManager layer: trust + quarantine integration ───────────────────────
//
// PluginManager discovery is filesystem-dependent. These tests
// exercise the trust/quarantine delegation through the underlying engines in a
// coordinated integration scenario that mirrors PluginManager's internal logic.

describe('security: PluginManager layer — trust/quarantine integration', () => {
  let trustStore: PluginTrustStore;
  let quarantineEngine: PluginQuarantineEngine;

  beforeEach(() => {
    trustStore = new PluginTrustStore();
    quarantineEngine = new PluginQuarantineEngine();
  });

  test('trust tier flows from store through capability resolution', () => {
    // Simulates PluginManager.trust() setting tier then resolveCapabilityManifest
    // applying trust-gated filtering during plugin load.
    const pluginName = 'integration-plugin';
    trustStore.setTier(pluginName, 'limited');

    const manifest = makeManifest(['shell.exec', 'filesystem.read', 'network.outbound']);
    const tier = trustStore.getTier(pluginName);
    const resolved = resolveCapabilityManifest(pluginName, manifest, () => true, tier);

    // Limited tier: safe caps granted, high-risk blocked
    expect(resolved.granted).toContain('filesystem.read');
    expect(resolved.granted).not.toContain('shell.exec');
    expect(resolved.granted).not.toContain('network.outbound');
    expect(resolved.denied).toContain('shell.exec');
    expect(resolved.denied).toContain('network.outbound');
  });

  test('quarantine revokes capabilities from manifest built by PluginManager stub pattern', () => {
    // Simulates the resolved capability manifest PluginManager.quarantine() uses
    // discovered.manifest.capabilities before passing to the quarantine engine.
    const pluginName = 'dangerous-plugin';
    const rawCaps = ['shell.exec', 'network.outbound', 'register.tool'] as PluginCapability[];
    const stubManifest: PluginCapabilityManifest = {
      requested: rawCaps,
      granted: [...rawCaps],
      denied: [],
      denialReasons: {},
    };

    const record = quarantineEngine.quarantine(pluginName, stubManifest, 'security audit');

    expect(record).not.toBeNull();
    expect(quarantineEngine.isQuarantined(pluginName)).toBe(true);
    expect(stubManifest.granted).not.toContain('shell.exec');
    expect(stubManifest.granted).not.toContain('network.outbound');
    expect(stubManifest.granted).toContain('register.tool');
    expect(record!.revokedCapabilities).toContain('shell.exec');
    expect(record!.revokedCapabilities).toContain('network.outbound');
  });

  test('liftQuarantine and re-resolve path restores capabilities for trusted plugins', () => {
    // Simulates PluginManager.liftQuarantine() followed by a reload that
    // re-resolves capabilities with the updated trust tier.
    const pluginName = 'restored-plugin';

    // Step 1: quarantine
    const quarantineManifest = makeCapManifest(['shell.exec', 'register.tool']);
    quarantineEngine.quarantine(pluginName, quarantineManifest, 'initial quarantine');
    expect(quarantineEngine.isQuarantined(pluginName)).toBe(true);

    // Step 2: operator upgrades trust and lifts quarantine
    trustStore.setTier(pluginName, 'trusted');
    quarantineEngine.lift(pluginName);
    expect(quarantineEngine.isQuarantined(pluginName)).toBe(false);

    // Step 3: plugin reloads — fresh manifest resolved with trusted tier
    const freshManifest = makeManifest(['shell.exec', 'register.tool']);
    const tier = trustStore.getTier(pluginName);
    const resolved = resolveCapabilityManifest(pluginName, freshManifest, () => true, tier);

    // Trusted tier: all capabilities granted
    expect(resolved.granted).toContain('shell.exec');
    expect(resolved.granted).toContain('register.tool');
    expect(resolved.denied).toHaveLength(0);
  });
});
