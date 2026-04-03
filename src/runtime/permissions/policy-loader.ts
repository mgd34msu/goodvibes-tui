/**
 * GC-PERM-011 — Policy loader with signature validation.
 *
 * Wraps the raw policy bundle loading path with a signature validation
 * step. In managed mode, bundles with invalid or missing signatures are
 * rejected. In non-managed mode, unsigned bundles are allowed through
 * with a `SignatureStatus` of `'unsigned'` for UI display.
 *
 * This module does NOT perform I/O itself — it accepts a pre-parsed
 * `SignedPolicyBundle` so callers control the loading strategy.
 */

import type { PolicyRule } from './types.ts';
import type {
  PolicyBundleId,
  SignatureStatus,
  ProvenanceSource,
  SignedPolicyBundle,
} from './policy-signer.ts';
import { verifyBundle } from './policy-signer.ts';

// ── Loader types ──────────────────────────────────────────────────────────────

/**
 * A policy bundle payload: the rules array and optional metadata.
 */
export interface PolicyBundlePayload {
  /** Version tag for schema migration. */
  version: number;
  /** The ordered list of policy rules to register with the evaluator. */
  rules: PolicyRule[];
  /** Optional human-readable bundle description. */
  description?: string;
}

/**
 * Provenance record attached to every loaded policy bundle.
 *
 * Carried forward onto each `PermissionDecision` produced by an evaluator
 * that was configured from this bundle.
 */
export interface BundleProvenance {
  /** Stable identifier for the bundle instance. */
  policyBundleId: PolicyBundleId;
  /** Validation outcome for the bundle's signature. */
  signatureStatus: SignatureStatus;
  /** Where the bundle originated from. */
  provenanceSource: ProvenanceSource;
  /** ISO 8601 timestamp from the bundle, if present. */
  issuedAt?: string;
  /** Human-readable issuer label, if present in the bundle. */
  issuer?: string;
}

/**
 * Result returned by `loadPolicyBundle()`.
 */
export interface PolicyLoadResult {
  /** Whether the bundle was successfully loaded and validated. */
  ok: boolean;
  /** The extracted policy rules (only populated when `ok` is true). */
  rules?: PolicyRule[];
  /** Provenance record for the bundle. */
  provenance: BundleProvenance;
  /** Human-readable explanation of why loading failed (when `ok` is false). */
  error?: string;
}

// ── Error class ───────────────────────────────────────────────────────────────

/**
 * PolicySignatureError — Thrown when a managed-mode bundle fails signature
 * validation and the caller opts into strict error throwing.
 *
 * Managed mode MUST reject bundles with invalid or missing signatures.
 */
export class PolicySignatureError extends Error {
  constructor(
    /** The bundle ID that failed validation. */
    public readonly bundleId: PolicyBundleId,
    /** The validation outcome. */
    public readonly signatureStatus: SignatureStatus,
    message: string,
  ) {
    super(message);
    this.name = 'PolicySignatureError';
  }
}

// ── Loader options ────────────────────────────────────────────────────────────

/**
 * Options controlling how `loadPolicyBundle()` behaves.
 */
export interface PolicyLoaderOptions {
  /**
   * HMAC-SHA256 signing key (Buffer or hex string).
   *
   * Required when `managed` is true; optional otherwise. When absent,
   * signature verification is skipped and status is set to `'skipped'`.
   */
  signingKey?: Buffer | string;

  /**
   * When true, the loader operates in managed mode:
   *   - Bundles with `SignatureStatus` of `'invalid'` or `'missing'` are rejected.
   *   - Bundles with `SignatureStatus` of `'unsigned'` are rejected.
   *   - Only `'valid'` signatures are accepted.
   *
   * When false (default), unsigned bundles are permitted with status `'unsigned'`.
   */
  managed?: boolean;

  /**
   * Describes where the bundle was loaded from.
   * Defaults to `'inline'` when not provided.
   */
  provenanceSource?: ProvenanceSource;

  /**
   * When true, `loadPolicyBundle()` throws a `PolicySignatureError` on
   * rejection in managed mode instead of returning `{ ok: false }`.
   *
   * Defaults to false.
   */
  throwOnRejection?: boolean;
}

// ── Core loader ───────────────────────────────────────────────────────────────

/**
 * loadPolicyBundle — Validates and loads a signed policy bundle.
 *
 * Performs signature verification and returns the extracted rules with
 * a full provenance record. In managed mode, bundles that are unsigned,
 * missing a signature, or carry an invalid signature are rejected.
 *
 * In non-managed mode, unsigned bundles are accepted with status `'unsigned'`
 * so the UI can display a warning.
 *
 * @param bundle  — The pre-parsed signed bundle object.
 * @param options — Loader behaviour options.
 *
 * @example
 * ```ts
 * const result = loadPolicyBundle(bundle, {
 *   signingKey: process.env['POLICY_SIGNING_KEY'],
 *   managed: true,
 *   provenanceSource: 'local-file',
 * });
 * if (!result.ok) {
 *   throw new Error(`Policy load failed: ${result.error}`);
 * }
 * ```
 */
export function loadPolicyBundle(
  bundle: SignedPolicyBundle<PolicyBundlePayload>,
  options: PolicyLoaderOptions = {},
): PolicyLoadResult {
  const {
    signingKey,
    managed = false,
    provenanceSource = 'inline',
    throwOnRejection = false,
  } = options;

  const baseProv: BundleProvenance = {
    policyBundleId: bundle.bundleId,
    signatureStatus: 'skipped',
    provenanceSource,
    issuedAt: bundle.issuedAt,
    issuer: bundle.issuer,
  };

  // ── Signature validation ────────────────────────────────────────────────────
  let signatureStatus: SignatureStatus;

  if (!signingKey) {
    // No key supplied — skip verification (permitted in non-managed mode)
    signatureStatus = 'skipped';
  } else if (!bundle.signature) {
    // Key supplied but bundle has no signature — unsigned in non-managed, rejected in managed
    signatureStatus = 'unsigned';
  } else {
    const result = verifyBundle(bundle, signingKey);
    signatureStatus = result.status;
  }

  const provenance: BundleProvenance = { ...baseProv, signatureStatus };

  // ── Managed-mode enforcement ────────────────────────────────────────────────
  if (managed) {
    const rejected =
      signatureStatus === 'invalid'
      || signatureStatus === 'missing'
      || signatureStatus === 'unsigned'
      || signatureStatus === 'skipped'; // managed mode requires a key + valid sig

    if (rejected) {
      const msg =
        `Managed-mode policy rejection: bundle "${bundle.bundleId}" ` +
        `has signatureStatus="${signatureStatus}". ` +
        `Only bundles with a valid HMAC-SHA256 signature are accepted in managed mode.`;

      if (throwOnRejection) {
        throw new PolicySignatureError(bundle.bundleId, signatureStatus, msg);
      }

      return { ok: false, provenance, error: msg };
    }
  }

  // ── Payload extraction ───────────────────────────────────────────────────────
  const payload = bundle.payload;

  return {
    ok: true,
    rules: payload.rules,
    provenance,
  };
}

/**
 * createUnsignedBundle — Convenience helper for non-managed/test usage.
 *
 * Creates a bare `SignedPolicyBundle` without a signature. The resulting
 * bundle will be accepted in non-managed mode with status `'unsigned'`.
 *
 * @param bundleId — Unique identifier for this bundle.
 * @param payload  — The policy payload.
 */
export function createUnsignedBundle(
  bundleId: PolicyBundleId,
  payload: PolicyBundlePayload,
): SignedPolicyBundle<PolicyBundlePayload> {
  return {
    bundleId,
    issuedAt: new Date().toISOString(),
    payload,
    // No signature field
  };
}
