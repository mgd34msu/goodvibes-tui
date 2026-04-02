/**
 * Plugin capability manifest validation and resolution — v3 §9.1.
 *
 * Implements deny-by-default capability enforcement:
 * 1. Parse raw manifest capabilities (unknown → typed)
 * 2. Validate that each requested capability is a known capability
 * 3. Run the runtime's capability policy to grant or deny each capability
 * 4. Return a resolved PluginCapabilityManifest
 */

import { logger } from '../../utils/logger.ts';
import {
  ALL_CAPABILITIES,
  type PluginCapability,
  type PluginCapabilityManifest,
  type PluginManifestV2,
} from './types.ts';

/**
 * Default capability policy: grant all valid capabilities.
 *
 * Callers can supply a stricter policy via PluginLifecycleManagerOptions.
 */
function defaultPolicy(_pluginName: string, _capability: PluginCapability): boolean {
  return true;
}

/**
 * Returns whether a string value is a known PluginCapability.
 */
function isKnownCapability(value: string): value is PluginCapability {
  return (ALL_CAPABILITIES as ReadonlyArray<string>).includes(value);
}

/**
 * resolveCapabilityManifest — Parse and resolve the capability manifest for a
 * plugin, applying the runtime's capability policy.
 *
 * @param pluginName - Plugin name (for logging).
 * @param manifest   - The raw plugin manifest (may have `capabilities` array).
 * @param policy     - Capability grant/deny callback. Defaults to permissive.
 * @returns A fully-resolved PluginCapabilityManifest.
 */
export function resolveCapabilityManifest(
  pluginName: string,
  manifest: PluginManifestV2,
  policy: (name: string, cap: PluginCapability) => boolean = defaultPolicy,
): PluginCapabilityManifest {
  const rawRequested = manifest.capabilities ?? [];

  // Validate and filter unknown capability strings.
  const requested: PluginCapability[] = [];
  for (const raw of rawRequested) {
    if (isKnownCapability(raw)) {
      requested.push(raw);
    } else {
      logger.warn(
        `[plugin-lifecycle:${pluginName}] Unknown capability '${raw}' — ignored`,
      );
    }
  }

  const granted: PluginCapability[] = [];
  const denied: PluginCapability[] = [];
  const denialReasons: Partial<Record<PluginCapability, string>> = {};

  for (const cap of requested) {
    if (policy(pluginName, cap)) {
      granted.push(cap);
    } else {
      denied.push(cap);
      denialReasons[cap] = `Capability '${cap}' denied by runtime policy`;
      logger.warn(
        `[plugin-lifecycle:${pluginName}] Capability '${cap}' denied by policy`,
      );
    }
  }

  logger.debug(
    `[plugin-lifecycle:${pluginName}] Capabilities resolved — granted: [${granted.join(', ')}]` +
    (denied.length > 0 ? `, denied: [${denied.join(', ')}]` : ''),
  );

  return {
    requested: Object.freeze(requested),
    granted,
    denied,
    denialReasons,
  };
}

/**
 * hasCapability — Returns whether a plugin has been granted a specific
 * capability after manifest resolution.
 */
export function hasCapability(
  manifest: PluginCapabilityManifest,
  capability: PluginCapability,
): boolean {
  return manifest.granted.includes(capability);
}

/**
 * validateManifestV2 — Light validation of the PluginManifestV2 shape.
 * Returns null on success or an error string on failure.
 */
export function validateManifestV2(manifest: unknown): string | null {
  if (!manifest || typeof manifest !== 'object') {
    return 'manifest must be an object';
  }
  const m = manifest as Record<string, unknown>;
  if (typeof m['name'] !== 'string' || !m['name']) {
    return "manifest.name must be a non-empty string";
  }
  if (typeof m['version'] !== 'string' || !m['version']) {
    return "manifest.version must be a non-empty string";
  }
  if (typeof m['description'] !== 'string') {
    return "manifest.description must be a string";
  }
  if (m['capabilities'] !== undefined) {
    if (!Array.isArray(m['capabilities'])) {
      return "manifest.capabilities must be an array";
    }
    for (const cap of m['capabilities'] as unknown[]) {
      if (typeof cap !== 'string') {
        return `manifest.capabilities entries must be strings, got: ${typeof cap}`;
      }
    }
  }
  if (m['minRuntimeVersion'] !== undefined && typeof m['minRuntimeVersion'] !== 'string') {
    return "manifest.minRuntimeVersion must be a string";
  }
  return null;
}
