/**
 * Security: Plugin capability enforcement.
 *
 * Verifies that the capability manifest system enforces capability policies:
 * - Capabilities are granted per the runtime policy callback
 * - Custom restrictive policies correctly deny capabilities
 * - hasCapability correctly reflects resolved manifest
 * - validateManifestV2 rejects malformed manifests
 *
 * Note: The default policy is permissive (grants all valid capabilities).
 * However, the default trust tier is 'untrusted', which blocks high-risk
 * capabilities (filesystem.write, network.outbound, shell.exec) regardless of
 * the policy callback. Pass trustTier='trusted' to enable full capability grants.
 * See also: src/test/security/plugin-trust.test.ts for trust tier coverage.
 */

import { describe, test, expect } from 'bun:test';
import {
  resolveCapabilityManifest,
  hasCapability,
  validateManifestV2,
} from '@pellux/goodvibes-sdk/platform/runtime/plugins/manifest';
import { ALL_CAPABILITIES } from '@pellux/goodvibes-sdk/platform/runtime/plugins/types';
import type { PluginManifestV2, PluginCapability } from '@pellux/goodvibes-sdk/platform/runtime/plugins/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(requested: PluginCapability[]): PluginManifestV2 {
  return {
    name: 'test-plugin',
    version: '1.0.0',
    description: 'test',
    capabilities: requested,
    minRuntimeVersion: '0.1.0',
  } as PluginManifestV2;
}

// Policy that denies a specific capability
function denyCapabilityPolicy(denied: PluginCapability) {
  return (_name: string, cap: PluginCapability) => cap !== denied;
}

// Policy that denies ALL capabilities (strict deny-by-default)
function denyAllPolicy() {
  return (_name: string, _cap: PluginCapability) => false;
}

// Policy that allows only one specific capability
function allowOnlyPolicy(allowed: PluginCapability) {
  return (_name: string, cap: PluginCapability) => cap === allowed;
}

// ---------------------------------------------------------------------------
// resolveCapabilityManifest — default permissive policy
// ---------------------------------------------------------------------------

describe('security: plugin capabilities', () => {
  describe('resolveCapabilityManifest — default policy (permissive)', () => {
    test('default policy grants all valid requested capabilities when trust is trusted', () => {
      // The default trust tier is 'untrusted', which blocks high-risk capabilities.
      // Pass 'trusted' explicitly to verify the permissive policy path.
      const manifest = makeManifest([...ALL_CAPABILITIES]);
      const resolved = resolveCapabilityManifest('test-plugin', manifest, undefined, 'trusted');
      expect(resolved.granted.length).toBe(ALL_CAPABILITIES.length);
      expect(resolved.denied.length).toBe(0);
    });

    test('default trust tier (untrusted) blocks high-risk capabilities even with permissive policy', () => {
      const manifest = makeManifest([...ALL_CAPABILITIES]);
      const resolved = resolveCapabilityManifest('test-plugin', manifest);
      // 3 high-risk capabilities blocked: filesystem.write, network.outbound, shell.exec
      expect(resolved.denied.length).toBe(3);
      expect(resolved.granted.length).toBe(ALL_CAPABILITIES.length - 3);
    });

    test('only requested capabilities appear in granted list', () => {
      const manifest = makeManifest(['filesystem.read']);
      const resolved = resolveCapabilityManifest('test-plugin', manifest);
      expect(resolved.granted).toContain('filesystem.read');
      // Non-requested capabilities are not granted
      expect(resolved.granted).not.toContain('shell.exec');
    });

    test('empty capabilities results in empty granted and denied lists', () => {
      const manifest = makeManifest([]);
      const resolved = resolveCapabilityManifest('test-plugin', manifest);
      expect(resolved.granted).toHaveLength(0);
      expect(resolved.denied).toHaveLength(0);
    });
  });

  describe('resolveCapabilityManifest — deny-all policy enforcement', () => {
    test('deny-all policy denies every requested capability', () => {
      const manifest = makeManifest([...ALL_CAPABILITIES]);
      const resolved = resolveCapabilityManifest('test-plugin', manifest, denyAllPolicy());
      expect(resolved.granted.length).toBe(0);
      expect(resolved.denied.length).toBe(ALL_CAPABILITIES.length);
    });

    test('plugin requesting capabilities beyond policy is denied', () => {
      // Plugin requests shell.exec but policy denies it
      const manifest = makeManifest(['filesystem.read', 'shell.exec']);
      const resolved = resolveCapabilityManifest('attacker-plugin', manifest, denyCapabilityPolicy('shell.exec'));

      expect(hasCapability(resolved, 'shell.exec')).toBe(false);
      expect(resolved.denied).toContain('shell.exec');

      // filesystem.read IS allowed by the policy
      expect(hasCapability(resolved, 'filesystem.read')).toBe(true);
    });

    test('capabilities beyond the policy limit are denied regardless of request count', () => {
      // Plugin requests all capabilities but policy only allows filesystem.read
      const manifest = makeManifest([...ALL_CAPABILITIES]);
      const policy = allowOnlyPolicy('filesystem.read');
      const resolved = resolveCapabilityManifest('greedy-plugin', manifest, policy);

      // Only filesystem.read should be granted
      expect(resolved.granted).toHaveLength(1);
      expect(resolved.granted[0]).toBe('filesystem.read');

      // Everything else must be denied
      const deniedExpected = ALL_CAPABILITIES.filter((c) => c !== 'filesystem.read');
      for (const cap of deniedExpected) {
        expect(hasCapability(resolved, cap)).toBe(false);
      }
    });

    test('denial reasons are recorded for denied capabilities', () => {
      const manifest = makeManifest(['filesystem.write', 'network.outbound']);
      const policy = denyCapabilityPolicy('network.outbound');
      const resolved = resolveCapabilityManifest('my-plugin', manifest, policy);
      expect(resolved.denialReasons).toBeDefined();
      expect(resolved.denialReasons!['network.outbound']).toBeTruthy();
    });
  });

  describe('hasCapability', () => {
    test('returns false for capability not in granted list', () => {
      const manifest = makeManifest([...ALL_CAPABILITIES]);
      const resolved = resolveCapabilityManifest('test-plugin', manifest, denyAllPolicy());
      for (const cap of ALL_CAPABILITIES) {
        expect(hasCapability(resolved, cap)).toBe(false);
      }
    });

    test('returns true only for explicitly granted capabilities', () => {
      const manifest = makeManifest(['filesystem.read', 'filesystem.write']);
      const policy = (_name: string, cap: PluginCapability) => cap === 'filesystem.read';
      const resolved = resolveCapabilityManifest('my-plugin', manifest, policy);
      expect(hasCapability(resolved, 'filesystem.read')).toBe(true);
      expect(hasCapability(resolved, 'filesystem.write')).toBe(false);
    });

    test('returns false for capability that was not requested at all', () => {
      const manifest = makeManifest(['filesystem.read']);
      const resolved = resolveCapabilityManifest('my-plugin', manifest);
      // shell.exec was never requested
      expect(hasCapability(resolved, 'shell.exec')).toBe(false);
    });
  });

  describe('validateManifestV2 — manifest integrity', () => {
    test('null manifest returns error string', () => {
      const result = validateManifestV2(null);
      expect(typeof result).toBe('string');
    });

    test('non-object manifest returns error string', () => {
      expect(typeof validateManifestV2('string')).toBe('string');
      expect(typeof validateManifestV2(42)).toBe('string');
      // Array is not a valid manifest object
      expect(typeof validateManifestV2([])).toBe('string');
    });

    test('manifest missing name returns error', () => {
      const result = validateManifestV2({ version: '1.0.0', description: 'test' });
      expect(typeof result).toBe('string');
    });

    test('manifest missing version returns error', () => {
      const result = validateManifestV2({ name: 'my-plugin', description: 'test' });
      expect(typeof result).toBe('string');
    });

    test('manifest missing description returns error', () => {
      const result = validateManifestV2({ name: 'my-plugin', version: '1.0.0' });
      expect(typeof result).toBe('string');
    });

    test('capabilities with non-string entries returns error', () => {
      const result = validateManifestV2({
        name: 'my-plugin',
        version: '1.0.0',
        description: 'test',
        capabilities: [123, 456],
      });
      expect(typeof result).toBe('string');
    });

    test('valid manifest with empty capabilities returns null', () => {
      const result = validateManifestV2({
        name: 'my-plugin',
        version: '1.0.0',
        description: 'A test plugin',
        capabilities: [],
      });
      expect(result).toBeNull();
    });

    test('valid manifest with known capabilities returns null', () => {
      const result = validateManifestV2({
        name: 'my-plugin',
        version: '1.0.0',
        description: 'A test plugin',
        capabilities: ['filesystem.read', 'register.tool'],
        minRuntimeVersion: '0.9.0',
      });
      // validateManifestV2 does not check for unknown capability strings (those are filtered at resolve time)
      expect(result).toBeNull();
    });
  });
});
