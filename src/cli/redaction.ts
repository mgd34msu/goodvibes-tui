export const REDACTED_VALUE = '<redacted>';

const SENSITIVE_PATH_PATTERN = /(^|\.)(apiKey|accessToken|botToken|appToken|signingSecret|webhookSecret|verifyToken|verificationToken|secret|password|token|keyFile)$/i;
// payments.card.* (number, expiry, cvv, cardholderName — see
// input/payments-config.ts) is sensitive by PREFIX, not by suffix: "number",
// "expiry" and "cardholderName" match none of the suffix names above, so a
// bundle export would carry them in plaintext if a value were ever stored as
// a literal instead of a goodvibes:// secret reference. Every payments.card.*
// path is always treated as sensitive regardless of its trailing field name.
const SENSITIVE_PATH_PREFIX_PATTERN = /^payments\.card\./i;
const SECRET_LIKE_TEXT_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9_]{16,}\b/g,
  /\bgho_[A-Za-z0-9_]{16,}\b/g,
  /\bghu_[A-Za-z0-9_]{16,}\b/g,
  /\bghs_[A-Za-z0-9_]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{24,}\b/g,
  /\b(?:xoxb|xapp|xoxp|xoxa)-[A-Za-z0-9-]{16,}\b/g,
  /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]{8,}@/g,
];

export function isSensitiveConfigPath(path: string): boolean {
  return SENSITIVE_PATH_PATTERN.test(path) || SENSITIVE_PATH_PREFIX_PATTERN.test(path);
}

export function isRedactedValue(value: unknown): boolean {
  return value === REDACTED_VALUE;
}

export interface RedactedConfigResult<T> {
  readonly value: T;
  readonly redactedPaths: readonly string[];
}

function shouldRedactValue(path: string, value: unknown): boolean {
  if (!isSensitiveConfigPath(path)) return false;
  if (typeof value !== 'string') return value !== undefined && value !== null;
  if (value.trim().length === 0) return false;
  if (value.startsWith('goodvibes://secrets/')) return false;
  return true;
}

function redactUnknown(value: unknown, path: string, redactedPaths: string[]): unknown {
  if (shouldRedactValue(path, value)) {
    redactedPaths.push(path);
    return REDACTED_VALUE;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => redactUnknown(item, `${path}.${index}`, redactedPaths));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const nestedPath = path ? `${path}.${key}` : key;
      result[key] = redactUnknown(nested, nestedPath, redactedPaths);
    }
    return result;
  }

  return value;
}

export function redactConfig<T>(config: T): RedactedConfigResult<T> {
  const redactedPaths: string[] = [];
  return {
    value: redactUnknown(config, '', redactedPaths) as T,
    redactedPaths,
  };
}

export function redactText(input: string): string {
  let output = input;
  for (const pattern of SECRET_LIKE_TEXT_PATTERNS) {
    output = output.replace(pattern, REDACTED_VALUE);
  }
  return output;
}

function collectSensitiveValues(value: unknown, path: string, values: string[]): void {
  if (shouldRedactValue(path, value) && typeof value === 'string') {
    values.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSensitiveValues(item, `${path}.${index}`, values));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      collectSensitiveValues(nested, path ? `${path}.${key}` : key, values);
    }
  }
}

export function collectSensitiveConfigValues(config: unknown): readonly string[] {
  const values: string[] = [];
  collectSensitiveValues(config, '', values);
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

export function redactSerializedSecrets(serialized: string, secretValues: readonly string[]): string {
  let output = redactText(serialized);
  for (const secret of secretValues) {
    if (!secret) continue;
    const encoded = JSON.stringify(secret).slice(1, -1);
    output = output.split(encoded).join(REDACTED_VALUE);
    output = output.split(secret).join(REDACTED_VALUE);
  }
  return output;
}
