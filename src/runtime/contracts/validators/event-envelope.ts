/**
 * Compatibility Contracts — EventEnvelope Validator
 *
 * Performs runtime shape validation for the RuntimeEventEnvelope persistence schema.
 * Returns a structured ValidationResult rather than throwing.
 *
 * @module contracts/validators/event-envelope
 */

import type { ValidationResult, ValidationError, SchemaVersion } from '../types.ts';

/**
 * Required fields for a persisted RuntimeEventEnvelope.
 */
const REQUIRED_STRING_FIELDS = ['type', 'traceId', 'sessionId', 'source'] as const;

/**
 * Validates that `data` conforms to the expected RuntimeEventEnvelope persistence shape.
 *
 * Checks:
 * - `data` is a non-null object
 * - `type`, `traceId`, `sessionId`, `source` are non-empty strings
 * - `ts` is a finite number (Unix ms timestamp)
 * - `payload` is present and is a non-null object
 * - `version` (if present) has numeric `major`, `minor`, `patch` fields
 *
 * @param data - The raw persisted data to validate.
 * @returns A ValidationResult with structured errors if any field is invalid.
 */
export function validateEventEnvelope(data: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (data === null || typeof data !== 'object') {
    errors.push({
      path: '',
      message: 'EventEnvelope must be a non-null object',
      expected: 'object',
      actual: data === null ? 'null' : typeof data,
    });
    return { valid: false, errors };
  }

  const record = data as Record<string, unknown>;

  // Validate required string fields
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = record[field];
    if (typeof value !== 'string' || value.length === 0) {
      errors.push({
        path: field,
        message: `Field '${field}' must be a non-empty string`,
        expected: 'non-empty string',
        actual: value === undefined ? 'undefined' : value === null ? 'null' : typeof value,
      });
    }
  }

  // Validate ts: finite number
  const tsRaw = record['ts'];
  if (typeof tsRaw !== 'number' || !Number.isFinite(tsRaw)) {
    errors.push({
      path: 'ts',
      message: "Field 'ts' must be a finite number (Unix ms timestamp)",
      expected: 'finite number',
      actual: tsRaw === undefined ? 'undefined' : tsRaw === null ? 'null' : typeof tsRaw,
    });
  }

  // Validate payload: non-null object
  const payloadRaw = record['payload'];
  if (payloadRaw === undefined || payloadRaw === null || typeof payloadRaw !== 'object') {
    errors.push({
      path: 'payload',
      message: "Field 'payload' must be a non-null object",
      expected: 'object',
      actual: payloadRaw === undefined ? 'undefined' : payloadRaw === null ? 'null' : typeof payloadRaw,
    });
  }

  // Detect version if present
  let detectedVersion: SchemaVersion | undefined;
  const versionRaw = record['version'];
  if (versionRaw !== undefined && versionRaw !== null && typeof versionRaw === 'object') {
    const v = versionRaw as Record<string, unknown>;
    const allNumeric =
      typeof v['major'] === 'number' &&
      typeof v['minor'] === 'number' &&
      typeof v['patch'] === 'number';
    if (allNumeric) {
      detectedVersion = {
        major: v['major'] as number,
        minor: v['minor'] as number,
        patch: v['patch'] as number,
      };
    } else {
      errors.push({
        path: 'version',
        message: "Field 'version' must have numeric major, minor, patch components",
        expected: '{ major: number, minor: number, patch: number }',
        actual: (() => { try { return JSON.stringify(versionRaw); } catch { return String(versionRaw); } })(),
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    version: detectedVersion,
  };
}
