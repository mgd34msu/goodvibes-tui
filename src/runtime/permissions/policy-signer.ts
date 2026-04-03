/**
 * GC-PERM-011 — Policy signing and provenance for the permissions runtime.
 *
 * Provides HMAC-SHA256-based signature creation and verification for policy
 * bundles. Used by the policy loader to validate bundle integrity before
 * the evaluator processes any rules.
 *
 * Signing key is supplied at runtime (environment or config). The signer
 * never stores keys in bundle payloads.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

// ── Provenance types ──────────────────────────────────────────────────────────

/**
 * Opaque identifier for a specific policy bundle instance.
 *
 * Used to correlate decisions back to the bundle that produced them.
 * Typically a content hash or UUID assigned at bundle creation.
 */
export type PolicyBundleId = string;

/**
 * Signature validation outcome for a loaded policy bundle.
 *
 * - `valid`    — Signature present and verified against the payload.
 * - `invalid`  — Signature present but verification failed (tampered/wrong key).
 * - `missing`  — No signature field present in the bundle (returned by verifyBundle directly).
 * - `unsigned` — Bundle has no signature field; loader uses this in non-managed mode.
 * - `skipped`  — Signature check was bypassed (no key supplied).
 */
export type SignatureStatus = 'valid' | 'invalid' | 'missing' | 'unsigned' | 'skipped';

/**
 * Describes the origin of the policy bundle for audit and UI display.
 *
 * - `local-file`  — Loaded from a local filesystem path.
 * - `remote-url`  — Fetched from a remote URL (managed infra).
 * - `inline`      — Embedded directly in runtime configuration.
 * - `test-fixture`— Created by test infrastructure; never production.
 */
export type ProvenanceSource = 'local-file' | 'remote-url' | 'inline' | 'test-fixture';

// ── Bundle types ──────────────────────────────────────────────────────────────

/**
 * A signed policy bundle as it appears on disk or over the wire.
 *
 * The `signature` field contains the hex-encoded HMAC-SHA256 digest of
 * the canonical JSON serialisation of `{ bundleId, issuedAt, issuer, payload }`.
 */
export interface SignedPolicyBundle<T = unknown> {
  /** Opaque bundle identifier (UUID or content hash). */
  bundleId: PolicyBundleId;
  /** ISO 8601 timestamp of when the bundle was signed. */
  issuedAt: string;
  /** The actual policy payload (rules array, metadata, etc.). */
  payload: T;
  /**
   * Hex-encoded HMAC-SHA256 of the canonical JSON of `{ bundleId, issuedAt, issuer, payload }`.
   * Absent when the bundle is unsigned.
   */
  signature?: string;
  /** Human-readable hint about the signer or issuer. */
  issuer?: string;
}

/**
 * Result returned by `verifyBundle()`.
 */
export interface VerifyResult {
  /** Whether the bundle signature is valid (false for missing/invalid). */
  ok: boolean;
  /** Validation outcome detail. */
  status: SignatureStatus;
  /** Human-readable explanation of the outcome. */
  message: string;
}

// ── Canonical serialisation ───────────────────────────────────────────────────

/**
 * canonicalise — Produces a deterministic JSON string for the given value.
 *
 * Keys are sorted recursively so that the representation is stable
 * regardless of insertion order, ensuring consistent HMAC inputs.
 *
 * @param value — The value to serialise.
 */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalise).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalise(obj[k])}`);
  return '{' + pairs.join(',') + '}';
}

// ── Signing ───────────────────────────────────────────────────────────────────

/**
 * signBundle — Creates a signed policy bundle from a payload.
 *
 * Generates a hex-encoded HMAC-SHA256 signature over the canonical JSON
 * of the payload and embeds it in the returned `SignedPolicyBundle`.
 *
 * @param bundleId — Unique identifier for this bundle.
 * @param payload  — The policy payload to sign.
 * @param key      — Raw signing key (Buffer or hex string).
 * @param issuer   — Optional human-readable issuer label.
 */
export function signBundle<T>(
  bundleId: PolicyBundleId,
  payload: T,
  key: Buffer | string,
  issuer?: string,
): SignedPolicyBundle<T> {
  const issuedAt = new Date().toISOString();
  const composite = { bundleId, issuedAt, issuer, payload };
  const canonical = canonicalise(composite);
  const keyBuf = typeof key === 'string' ? Buffer.from(key, 'hex') : key;
  const signature = createHmac('sha256', keyBuf)
    .update(canonical, 'utf8')
    .digest('hex');

  const bundle: SignedPolicyBundle<T> = {
    bundleId,
    issuedAt,
    payload,
    signature,
  };
  if (issuer !== undefined) bundle.issuer = issuer;
  return bundle;
}

// ── Verification ──────────────────────────────────────────────────────────────

/**
 * verifyBundle — Validates the HMAC-SHA256 signature of a policy bundle.
 *
 * Computes the expected HMAC over the canonical payload and performs
 * a constant-time comparison against the stored signature to prevent
 * timing side-channel attacks.
 *
 * Returns `{ ok: false, status: 'missing' }` when the bundle carries no
 * signature field. Callers decide whether to accept unsigned bundles.
 *
 * @param bundle — The bundle to verify.
 * @param key    — The verification key (Buffer or hex string).
 */
export function verifyBundle<T>(
  bundle: SignedPolicyBundle<T>,
  key: Buffer | string,
): VerifyResult {
  if (bundle.signature === undefined || bundle.signature === '') {
    return {
      ok: false,
      status: 'missing',
      message: `Bundle "${bundle.bundleId}" carries no signature.`,
    };
  }

  const composite = {
    bundleId: bundle.bundleId,
    issuedAt: bundle.issuedAt,
    issuer: bundle.issuer,
    payload: bundle.payload,
  };
  const canonical = canonicalise(composite);
  const keyBuf = typeof key === 'string' ? Buffer.from(key, 'hex') : key;

  let expected: Buffer;
  try {
    expected = createHmac('sha256', keyBuf)
      .update(canonical, 'utf8')
      .digest();
  } catch {
    // Non-fatal: key is malformed; treat as invalid
    return {
      ok: false,
      status: 'invalid',
      message: `Bundle "${bundle.bundleId}": key error during signature computation.`,
    };
  }

  if (!/^[0-9a-f]+$/i.test(bundle.signature)) {
    return {
      ok: false,
      status: 'invalid',
      message: `Bundle "${bundle.bundleId}": signature is not valid hex.`,
    };
  }

  let actual: Buffer;
  try {
    actual = Buffer.from(bundle.signature, 'hex');
  } catch {
    return {
      ok: false,
      status: 'invalid',
      message: `Bundle "${bundle.bundleId}": signature is not valid hex.`,
    };
  }

  if (expected.length !== actual.length) {
    return {
      ok: false,
      status: 'invalid',
      message: `Bundle "${bundle.bundleId}": signature length mismatch.`,
    };
  }

  const valid = timingSafeEqual(expected, actual);
  if (!valid) {
    return {
      ok: false,
      status: 'invalid',
      message: `Bundle "${bundle.bundleId}": signature mismatch — payload may be tampered.`,
    };
  }

  return {
    ok: true,
    status: 'valid',
    message: `Bundle "${bundle.bundleId}": signature valid.`,
  };
}
