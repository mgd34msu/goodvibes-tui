/**
 * Compatibility Contracts — RuntimeState Validator
 *
 * Performs runtime shape validation for the top-level RuntimeState snapshot schema.
 * Returns a structured ValidationResult rather than throwing.
 *
 * @module contracts/validators/runtime-state
 */

import type { ValidationResult, ValidationError, SchemaVersion } from '../types.ts';

/**
 * Expected top-level field names for a RuntimeState snapshot.
 * Validated as required string/object fields at the top level.
 */
const REQUIRED_FIELDS = ['version', 'domains'] as const;

/**
 * Validates that `data` conforms to the expected RuntimeState snapshot shape.
 *
 * Checks:
 * - `data` is a non-null object
 * - `version` is present and has numeric `major`, `minor`, `patch` fields
 * - `domains` is present and is a non-null object
 *
 * @param data - The raw persisted data to validate.
 * @returns A ValidationResult with `valid: true` if the shape is correct,
 *   or `valid: false` with a list of errors if any required field is missing or malformed.
 */
export function validateRuntimeState(data: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (data === null || typeof data !== 'object') {
    errors.push({
      path: '',
      message: 'RuntimeState must be a non-null object',
      expected: 'object',
      actual: data === null ? 'null' : typeof data,
    });
    return { valid: false, errors };
  }

  const record = data as Record<string, unknown>;

  // Check all required top-level fields are present
  for (const field of REQUIRED_FIELDS) {
    if (!(field in record)) {
      errors.push({
        path: field,
        message: `Missing required field '${field}'`,
        expected: 'present',
        actual: 'undefined',
      });
    }
  }

  // Validate version shape: { major: number, minor: number, patch: number }
  let detectedVersion: SchemaVersion | undefined;
  const versionRaw = record['version'];
  if (versionRaw !== undefined) {
    if (versionRaw === null || typeof versionRaw !== 'object') {
      errors.push({
        path: 'version',
        message: 'Field \'version\' must be a non-null object',
        expected: '{ major: number, minor: number, patch: number }',
        actual: versionRaw === null ? 'null' : typeof versionRaw,
      });
    } else {
      const v = versionRaw as Record<string, unknown>;
      const vErrors: ValidationError[] = [];
      for (const component of ['major', 'minor', 'patch'] as const) {
        if (typeof v[component] !== 'number') {
          vErrors.push({
            path: `version.${component}`,
            message: `Field 'version.${component}' must be a number`,
            expected: 'number',
            actual: v[component] === null ? 'null' : typeof v[component],
          });
        }
      }
      errors.push(...vErrors);
      if (vErrors.length === 0) {
        detectedVersion = {
          major: v['major'] as number,
          minor: v['minor'] as number,
          patch: v['patch'] as number,
        };
      }
    }
  }

  // Validate domains is a non-null object
  const domainsRaw = record['domains'];
  if (domainsRaw !== undefined) {
    if (domainsRaw === null || typeof domainsRaw !== 'object' || Array.isArray(domainsRaw)) {
      errors.push({
        path: 'domains',
        message: "Field 'domains' must be a non-null, non-array object",
        expected: 'object',
        actual: domainsRaw === null ? 'null' : Array.isArray(domainsRaw) ? 'array' : typeof domainsRaw,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    version: detectedVersion,
  };
}
