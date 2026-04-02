/**
 * Compatibility Contracts — Current Schema Versions
 *
 * Declares the authoritative current schema version for each versioned domain.
 * Bump these when making structural changes to the corresponding schema.
 *
 * @module contracts/version
 */

import type { SchemaVersion } from './types.ts';

/**
 * Current schema versions for all versioned runtime domains.
 *
 * Rules for bumping:
 * - Bump `major` when the change is breaking (requires migration)
 * - Bump `minor` when adding optional fields (additive, backward-compatible)
 * - Bump `patch` for non-structural documentation or annotation changes
 */
export const SCHEMA_VERSIONS = {
  /** Top-level RuntimeState snapshot schema. */
  runtimeState: { major: 1, minor: 0, patch: 0 } as const satisfies SchemaVersion,
  /** RuntimeEventEnvelope schema for event persistence and replay. */
  eventEnvelope: { major: 1, minor: 0, patch: 0 } as const satisfies SchemaVersion,
  /** Session persistence format (messages + meta). */
  session: { major: 1, minor: 0, patch: 0 } as const satisfies SchemaVersion,
  /** Plugin manifest and capability descriptor schema. */
  pluginManifest: { major: 1, minor: 0, patch: 0 } as const satisfies SchemaVersion,
  /** RuntimeTask record schema used in task domain persistence. */
  taskRecord: { major: 1, minor: 0, patch: 0 } as const satisfies SchemaVersion,
} as const;

/**
 * The minimum schema version supported for migration for each domain.
 *
 * Data older than this version cannot be migrated and must be discarded
 * or re-initialized. This is updated when old migration steps are pruned.
 */
export const MIN_SUPPORTED_VERSIONS = {
  runtimeState: { major: 1, minor: 0, patch: 0 } as const satisfies SchemaVersion,
  eventEnvelope: { major: 1, minor: 0, patch: 0 } as const satisfies SchemaVersion,
  session: { major: 1, minor: 0, patch: 0 } as const satisfies SchemaVersion,
  pluginManifest: { major: 1, minor: 0, patch: 0 } as const satisfies SchemaVersion,
  taskRecord: { major: 1, minor: 0, patch: 0 } as const satisfies SchemaVersion,
} as const;

/** Union of all known contract names. */
export type ContractName = keyof typeof SCHEMA_VERSIONS;
