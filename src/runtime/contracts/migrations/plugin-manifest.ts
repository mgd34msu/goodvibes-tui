/**
 * Compatibility Contracts — Plugin Manifest Migrations
 *
 * Migration steps for the plugin manifest and capability descriptor schema.
 * All steps are pure functions — they do not mutate their input.
 *
 * @module contracts/migrations/plugin-manifest
 */

import type { MigrationStep } from '../types.ts';
import { SCHEMA_VERSIONS } from '../version.ts';

/**
 * All registered PluginManifest migration steps.
 *
 * Currently empty — the schema is at its initial version (1.0.0).
 * Future steps must be appended here and registered via the contract registry.
 *
 * Example: if `capabilities` becomes an explicit array in v1.1.0, a migration
 * step would synthesize it from legacy `registerCommand`/`registerTool` usage.
 */
const PLUGIN_MANIFEST_STEPS: MigrationStep[] = [
  // Example structure for future use:
  // {
  //   from: { major: 1, minor: 0, patch: 0 },
  //   to: { major: 1, minor: 1, patch: 0 },
  //   description: 'Add capabilities array to plugin manifest',
  //   migrate: (data: unknown): unknown => {
  //     const d = data as Record<string, unknown>;
  //     return { ...d, capabilities: d['capabilities'] ?? [] };
  //   },
  // },
];

/**
 * The current PluginManifest schema version (re-exported for convenience).
 */
export const PLUGIN_MANIFEST_VERSION = SCHEMA_VERSIONS.pluginManifest;

/**
 * Returns all PluginManifest migration steps.
 * Used by the contract registry during initialization.
 */
export function getPluginManifestMigrationSteps(): MigrationStep[] {
  return PLUGIN_MANIFEST_STEPS;
}
