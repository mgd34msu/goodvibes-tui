export const REDACTED_VALUE = '<redacted>';

// Matches a config path whose LAST SEGMENT is exactly one of these words. That
// is the whole reach of this pattern, and it is why the declared list below
// exists: `surfaces.calendar.caldavPassword` does not end in a `.password`
// segment, it ends in a `caldavPassword` segment, so this pattern answers false
// for it — as it does for `imapPassword`, `appPassword` and `authToken`.
const SENSITIVE_PATH_PATTERN = /(^|\.)(apiKey|accessToken|botToken|appToken|signingSecret|webhookSecret|verifyToken|verificationToken|secret|password|token|keyFile)$/i;

// Credential-bearing config keys that are sensitive by NAME rather than by the
// generic trailing-word list above. Every one of these was carried in the clear
// by a support bundle before it was listed here, because the pattern matches a
// trailing WORD and these names carry the credential word in the middle or
// prefixed by a protocol ("caldavPassword", "imapPassword", "appPassword",
// "authToken").
//
// The `*Ref` Cloudflare keys normally hold a `goodvibes://secrets/...`
// reference, which shouldRedactValue already lets through as safe. They are
// listed as a BACKSTOP, for the same reason the mail keys are worth listing
// twice over: it costs nothing, and it is what stands between a future code
// path that writes a literal token there and that token reaching a file the
// owner emails to someone for support.
const SENSITIVE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  // Mailbox / CalDAV — the credentials the daemon polls mail and calendar with.
  'surfaces.email.password',
  'surfaces.email.imapPassword',
  'surfaces.email.imap.password',
  'surfaces.email.smtp.password',
  'surfaces.calendar.caldavPassword',
  // Telephony.
  'surfaces.telephony.authToken',
  'surfaces.msteams.appPassword',
  // Cloudflare token references.
  'cloudflare.apiTokenRef',
  'cloudflare.tunnelTokenRef',
  'cloudflare.accessServiceTokenRef',
  'cloudflare.workerTokenRef',
  'cloudflare.workerClientTokenRef',
  // Cluster shared phrase.
  'cluster.secret',
  // Payment card material. ADDED to this set, never substituted for it: this
  // set is a hardcoded list with no delegation, so replacing it wholesale with
  // another product's would silently stop redacting whatever that one omits.
  // The four names below end in no word the suffix pattern knows —
  // "cardNumber", "cardExpiry" and "cardholderName" match none of them — which
  // is the whole reason a declared list exists rather than a naming habit.
  // (The `.map` below lowercases every entry; the lookup lowercases too.)
  'payments.cardNumber',
  'payments.cardExpiry',
  'payments.cardCvv',
  'payments.cardholderName',
].map((key) => key.toLowerCase()));

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
  return SENSITIVE_PATH_PATTERN.test(path) || SENSITIVE_CONFIG_KEYS.has(path.toLowerCase());
}

export function isRedactedValue(value: unknown): boolean {
  return value === REDACTED_VALUE;
}

export interface RedactedConfigResult<T> {
  readonly value: T;
  readonly redactedPaths: readonly string[];
}

// Redaction rule for sensitive config paths:
// - Non-string values: redact if truthy (i.e. non-null, non-undefined, non-zero, non-false).
//   Rationale: zero and false are never meaningful secrets; null/undefined mean absent.
// - String values: redact non-empty strings that are not goodvibes:// secret refs.
//   Rationale: empty string means unset; secret refs are safe placeholders, not raw values.
function shouldRedactValue(path: string, value: unknown): boolean {
  if (!isSensitiveConfigPath(path)) return false;
  if (typeof value !== 'string') return value !== null && value !== undefined && Boolean(value);
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
  // Assignment form: keyword=value — anchored so 'monkey=' and 'donkey=' do NOT match.
  // Matches: token=, access_token=, api_key=, api-key=, secret=, password= and colon form token: value
  let output = input
    .replace(
      /(?<![A-Za-z])(?:access_token|api[_-]?key|secret|password|token)\s*=\s*([^ \t\r\n"'`]+)/gi,
      (m, val) => m.slice(0, m.length - val.length) + REDACTED_VALUE,
    )
    .replace(
      /(?<![A-Za-z])(?:access_token|api[_-]?key|secret|password|token)\s*:\s*([^ \t\r\n"'`]+)/gi,
      (m, val) => m.slice(0, m.length - val.length) + REDACTED_VALUE,
    );
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
