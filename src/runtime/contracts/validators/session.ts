/**
 * Compatibility Contracts — Session Validator
 *
 * Performs runtime shape validation for the session persistence format
 * (messages array + meta object). Returns a structured ValidationResult.
 *
 * @module contracts/validators/session
 */

import type { ValidationResult, ValidationError, SchemaVersion } from '../types.ts';

/**
 * Validates that `data` conforms to the expected session persistence shape.
 *
 * Checks:
 * - `data` is a non-null object
 * - `sessionId` is a non-empty string
 * - `messages` is an array (contents are not deeply validated)
 * - `meta` is a non-null, non-array object
 * - `meta.version` (if present) has numeric `major`, `minor`, `patch` fields
 *
 * @param data - The raw persisted data to validate.
 * @returns A ValidationResult with structured errors if any field is invalid.
 */
export function validateSession(data: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (data === null || typeof data !== 'object') {
    errors.push({
      path: '',
      message: 'Session must be a non-null object',
      expected: 'object',
      actual: data === null ? 'null' : typeof data,
    });
    return { valid: false, errors };
  }

  const record = data as Record<string, unknown>;

  // Validate sessionId: non-empty string
  const sessionIdRaw = record['sessionId'];
  if (typeof sessionIdRaw !== 'string' || sessionIdRaw.length === 0) {
    errors.push({
      path: 'sessionId',
      message: "Field 'sessionId' must be a non-empty string",
      expected: 'non-empty string',
      actual: sessionIdRaw === undefined ? 'undefined' : sessionIdRaw === null ? 'null' : typeof sessionIdRaw,
    });
  }

  // Validate messages: array
  const messagesRaw = record['messages'];
  if (!Array.isArray(messagesRaw)) {
    errors.push({
      path: 'messages',
      message: "Field 'messages' must be an array",
      expected: 'array',
      actual: messagesRaw === undefined ? 'undefined' : messagesRaw === null ? 'null' : typeof messagesRaw,
    });
  }

  // Validate meta: non-null, non-array object
  const metaRaw = record['meta'];
  if (metaRaw === undefined || metaRaw === null || typeof metaRaw !== 'object' || Array.isArray(metaRaw)) {
    errors.push({
      path: 'meta',
      message: "Field 'meta' must be a non-null, non-array object",
      expected: 'object',
      actual: metaRaw === undefined ? 'undefined' : metaRaw === null ? 'null' : Array.isArray(metaRaw) ? 'array' : typeof metaRaw,
    });
  }

  // Detect version from meta.version if present
  let detectedVersion: SchemaVersion | undefined;
  if (metaRaw !== undefined && metaRaw !== null && typeof metaRaw === 'object' && !Array.isArray(metaRaw)) {
    const meta = metaRaw as Record<string, unknown>;
    const versionRaw = meta['version'];
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
        let actualStr: string;
        try { actualStr = JSON.stringify(versionRaw); } catch { actualStr = String(versionRaw); }
        errors.push({
          path: 'meta.version',
          message: "Field 'meta.version' must have numeric major, minor, patch components",
          expected: '{ major: number, minor: number, patch: number }',
          actual: actualStr,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    version: detectedVersion,
  };
}
