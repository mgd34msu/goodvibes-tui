/**
 * Compatibility Contracts — Module barrel and factory
 *
 * Entry point for the schema versioning, validation, and migration
 * infrastructure. Use `createContractRegistry()` to obtain a fully
 * initialized registry with all domain contracts registered.
 *
 * Usage:
 * ```ts
 * import { createContractRegistry } from './contracts/index.ts';
 * const { registry, contracts } = createContractRegistry();
 * const result = contracts.get('runtimeState')?.validate(rawData);
 * ```
 *
 * @module contracts
 */

export { MigrationRegistry } from './migrations/index.ts';
export * from './types.ts';
export * from './version.ts';
export * from './validators/index.ts';

import { MigrationRegistry } from './migrations/index.ts';
import type { SchemaContract } from './types.ts';
import { SCHEMA_VERSIONS, MIN_SUPPORTED_VERSIONS } from './version.ts';
import type { ContractName } from './version.ts';
import { getRuntimeStateMigrationSteps } from './migrations/runtime-state.ts';
import { getEventEnvelopeMigrationSteps } from './migrations/event-envelope.ts';
import { getSessionMigrationSteps } from './migrations/session.ts';
import { getPluginManifestMigrationSteps } from './migrations/plugin-manifest.ts';
import { getTaskRecordMigrationSteps } from './migrations/task-record.ts';
import { validateRuntimeState } from './validators/runtime-state.ts';
import { validateEventEnvelope } from './validators/event-envelope.ts';
import { validateSession } from './validators/session.ts';

/**
 * Creates a fully initialized contract registry with all domain migration
 * steps registered and SchemaContract instances built for each domain.
 *
 * Each SchemaContract provides:
 * - `validate(data)` — runtime shape validation returning a ValidationResult
 * - `migrate(data, fromVersion)` — migration chain execution via MigrationRegistry
 *
 * @returns An object containing:
 *   - `registry` — the MigrationRegistry with all steps registered
 *   - `contracts` — a Map of contract name → SchemaContract
 */
export function createContractRegistry(): {
  registry: MigrationRegistry;
  contracts: Map<ContractName, SchemaContract>;
} {
  const registry = new MigrationRegistry();

  // Register all domain migration steps
  for (const step of getRuntimeStateMigrationSteps()) {
    registry.register('runtimeState', step);
  }
  for (const step of getEventEnvelopeMigrationSteps()) {
    registry.register('eventEnvelope', step);
  }
  for (const step of getSessionMigrationSteps()) {
    registry.register('session', step);
  }
  for (const step of getPluginManifestMigrationSteps()) {
    registry.register('pluginManifest', step);
  }
  for (const step of getTaskRecordMigrationSteps()) {
    registry.register('taskRecord', step);
  }

  const contracts = new Map<ContractName, SchemaContract>();

  // runtimeState contract
  contracts.set('runtimeState', {
    name: 'runtimeState',
    currentVersion: SCHEMA_VERSIONS.runtimeState,
    minSupportedVersion: MIN_SUPPORTED_VERSIONS.runtimeState,
    validate: validateRuntimeState,
    migrate: (data, fromVersion) => registry.migrate('runtimeState', data, fromVersion),
  });

  // eventEnvelope contract
  contracts.set('eventEnvelope', {
    name: 'eventEnvelope',
    currentVersion: SCHEMA_VERSIONS.eventEnvelope,
    minSupportedVersion: MIN_SUPPORTED_VERSIONS.eventEnvelope,
    validate: validateEventEnvelope,
    migrate: (data, fromVersion) => registry.migrate('eventEnvelope', data, fromVersion),
  });

  // session contract
  contracts.set('session', {
    name: 'session',
    currentVersion: SCHEMA_VERSIONS.session,
    minSupportedVersion: MIN_SUPPORTED_VERSIONS.session,
    validate: validateSession,
    migrate: (data, fromVersion) => registry.migrate('session', data, fromVersion),
  });

  // pluginManifest contract
  contracts.set('pluginManifest', {
    name: 'pluginManifest',
    currentVersion: SCHEMA_VERSIONS.pluginManifest,
    minSupportedVersion: MIN_SUPPORTED_VERSIONS.pluginManifest,
    validate: (data) => {
      const errors: import('./types.ts').ValidationError[] = [];
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        errors.push({ path: '', message: 'pluginManifest must be a non-null object', expected: 'object', actual: data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data });
        return { valid: false, errors };
      }
      const record = data as Record<string, unknown>;
      if (typeof record['name'] !== 'string' || record['name'].length === 0) {
        errors.push({ path: 'name', message: "Field 'name' must be a non-empty string", expected: 'non-empty string', actual: typeof record['name'] });
      }
      if (typeof record['version'] !== 'string' || record['version'].length === 0) {
        errors.push({ path: 'version', message: "Field 'version' must be a non-empty string", expected: 'non-empty string', actual: typeof record['version'] });
      }
      if (!Array.isArray(record['capabilities'])) {
        errors.push({ path: 'capabilities', message: "Field 'capabilities' must be an array", expected: 'array', actual: typeof record['capabilities'] });
      }
      return { valid: errors.length === 0, errors, version: SCHEMA_VERSIONS.pluginManifest };
    },
    migrate: (data, fromVersion) => registry.migrate('pluginManifest', data, fromVersion),
  });

  // taskRecord contract
  contracts.set('taskRecord', {
    name: 'taskRecord',
    currentVersion: SCHEMA_VERSIONS.taskRecord,
    minSupportedVersion: MIN_SUPPORTED_VERSIONS.taskRecord,
    validate: (data) => {
      const errors: import('./types.ts').ValidationError[] = [];
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        errors.push({ path: '', message: 'taskRecord must be a non-null object', expected: 'object', actual: data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data });
        return { valid: false, errors };
      }
      const record = data as Record<string, unknown>;
      if (typeof record['id'] !== 'string' || record['id'].length === 0) {
        errors.push({ path: 'id', message: "Field 'id' must be a non-empty string", expected: 'non-empty string', actual: typeof record['id'] });
      }
      if (typeof record['type'] !== 'string' || record['type'].length === 0) {
        errors.push({ path: 'type', message: "Field 'type' must be a non-empty string", expected: 'non-empty string', actual: typeof record['type'] });
      }
      if (typeof record['status'] !== 'string' || record['status'].length === 0) {
        errors.push({ path: 'status', message: "Field 'status' must be a non-empty string", expected: 'non-empty string', actual: typeof record['status'] });
      }
      return { valid: errors.length === 0, errors, version: SCHEMA_VERSIONS.taskRecord };
    },
    migrate: (data, fromVersion) => registry.migrate('taskRecord', data, fromVersion),
  });

  return { registry, contracts };
}
