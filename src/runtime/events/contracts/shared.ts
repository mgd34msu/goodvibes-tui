/**
 * Shared primitives for runtime event contract validation.
 */
export interface ContractResult {
  readonly valid: boolean;
  readonly violations: readonly string[];
}

const OK: ContractResult = { valid: true, violations: [] };

function fail(...messages: string[]): ContractResult {
  return { valid: false, violations: messages };
}

export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isNumber(v: unknown): v is number {
  return typeof v === 'number';
}

export function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export type FieldKind = 'string' | 'number' | 'boolean' | 'string[]' | 'enum' | 'object';

export interface FieldSpec {
  readonly key: string;
  readonly kind: FieldKind;
  readonly values?: readonly string[];
}

export function validateEventFields(type: string, v: unknown, fields: readonly FieldSpec[]): ContractResult {
  if (!isObject(v)) return fail('event must be an object');
  if (v['type'] !== type) return fail(`type must be '${type}', got ${String(v['type'])}`);

  const violations: string[] = [];
  for (const field of fields) {
    const value = v[field.key];
    switch (field.kind) {
      case 'string':
        if (!isString(value)) violations.push(`${field.key} must be a string`);
        break;
      case 'number':
        if (!isNumber(value)) violations.push(`${field.key} must be a number`);
        break;
      case 'boolean':
        if (!isBoolean(value)) violations.push(`${field.key} must be a boolean`);
        break;
      case 'string[]':
        if (!Array.isArray(value) || value.some((item) => !isString(item))) {
          violations.push(`${field.key} must be an array of strings`);
        }
        break;
      case 'enum':
        if (!isString(value) || !(field.values ?? []).includes(value)) {
          violations.push(`${field.key} must be one of: ${(field.values ?? []).join(', ')}`);
        }
        break;
      case 'object':
        if (!isObject(value)) violations.push(`${field.key} must be an object`);
        break;
    }
  }
  return violations.length ? { valid: false, violations } : OK;
}

export interface EventEnvelopeShape {
  readonly traceId: string;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly source: string;
  readonly event: Record<string, unknown>;
}

export function validateEnvelope(v: unknown): ContractResult {
  if (!isObject(v)) return fail('envelope must be an object');
  const violations: string[] = [];
  if (!isString(v['traceId'])) violations.push('traceId must be a string');
  if (!isString(v['sessionId'])) violations.push('sessionId must be a string');
  if (!isNumber(v['timestamp'])) violations.push('timestamp must be a number');
  if (!isString(v['source'])) violations.push('source must be a string');
  if (!isObject(v['event'])) violations.push('event must be an object');
  return violations.length ? { valid: false, violations } : OK;
}
