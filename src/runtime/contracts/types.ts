/**
 * Compatibility Contracts — Core Types
 *
 * Defines the foundational types used by the schema versioning and migration
 * infrastructure across all runtime domains.
 *
 * @module contracts/types
 */

/**
 * A semantic version identifier for a schema.
 *
 * Follows major.minor.patch semantics:
 * - major: breaking change, requires explicit migration
 * - minor: additive change, backward-compatible
 * - patch: non-structural fix, always backward-compatible
 */
export interface SchemaVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * The result of a schema validation operation.
 */
export interface ValidationResult {
  /** Whether the data is valid against the expected schema. */
  readonly valid: boolean;
  /** Structured list of validation errors (empty when valid). */
  readonly errors: ValidationError[];
  /** The detected schema version, if parseable. */
  readonly version?: SchemaVersion;
}

/**
 * A single validation failure with path and diagnostic context.
 */
export interface ValidationError {
  /** Dot-delimited path to the invalid field (e.g. 'envelope.sessionId'). */
  readonly path: string;
  /** Human-readable description of the failure. */
  readonly message: string;
  /** Description of the expected type or value. */
  readonly expected?: string;
  /** Description of the actual type or value found. */
  readonly actual?: string;
}

/**
 * A pure transformation function that migrates data from one schema version
 * to the next. Must not mutate the input — return a new object.
 *
 * The `unknown` input/output types are intentional: migration functions operate
 * on raw persisted data whose shape may predate current TypeScript interfaces.
 */
export type MigrationFn = (data: unknown) => unknown;

/**
 * Describes a single step in a migration chain, moving data from `from` to `to`.
 *
 * All steps must be registered in the MigrationRegistry before use.
 */
export interface MigrationStep {
  /** Source schema version this step migrates from. */
  readonly from: SchemaVersion;
  /** Target schema version this step migrates to. */
  readonly to: SchemaVersion;
  /** Pure transformation function. Must not mutate input. */
  readonly migrate: MigrationFn;
  /** Human-readable description of what this migration changes. */
  readonly description: string;
}

/**
 * The result of a migration operation, containing the transformed data
 * and the version it was migrated to.
 */
export interface MigrationResult {
  /** The migrated data at the target schema version. */
  readonly data: unknown;
  /** The schema version of the migrated data. */
  readonly version: SchemaVersion;
}

/**
 * A schema contract defines the versioning, validation, and migration
 * interface for a single domain schema (e.g. RuntimeState, EventEnvelope).
 */
export interface SchemaContract {
  /** Unique name identifying this contract (e.g. 'runtimeState'). */
  readonly name: string;
  /** The current schema version emitted by this runtime. */
  readonly currentVersion: SchemaVersion;
  /** The oldest schema version this runtime can still migrate from. */
  readonly minSupportedVersion: SchemaVersion;
  /**
   * Validates that the given data matches the expected schema shape.
   * Performs runtime type checks — not just TypeScript type narrowing.
   */
  validate: (data: unknown) => ValidationResult;
  /**
   * Migrates data from an older schema version to the current version.
   * Returns a MigrationResult with the migrated data and target version,
   * or throws if migration is not possible.
   */
  migrate: (data: unknown, fromVersion: SchemaVersion) => MigrationResult;
}

/**
 * Compares two SchemaVersions. Returns:
 * - negative if a < b
 * - 0 if a === b
 * - positive if a > b
 */
export function compareVersions(a: SchemaVersion, b: SchemaVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Returns true if the two SchemaVersions are equal.
 */
export function versionsEqual(a: SchemaVersion, b: SchemaVersion): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

/**
 * Serializes a SchemaVersion to a canonical string (e.g. '1.0.0').
 */
export function versionToString(v: SchemaVersion): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * Parses a version string (e.g. '1.2.3') into a SchemaVersion.
 * Throws if the string is not a valid semver triple.
 */
export function parseVersion(raw: string): SchemaVersion {
  const parts = raw.split('.');
  if (parts.length !== 3) {
    throw new Error(`Invalid schema version string: '${raw}' (expected 'major.minor.patch')`);
  }
  const [major, minor, patch] = parts.map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    throw new Error(`Non-integer component in schema version: '${raw}'`);
  }
  return { major, minor, patch };
}
