/**
 * GC-PERM-011 — Tests for the policy loader with signature validation.
 *
 * Covers:
 *   - loadPolicyBundle(): unsigned/invalid/valid signature cases
 *   - Managed mode rejection behaviour
 *   - Non-managed mode acceptance of unsigned bundles
 *   - Provenance attachment to PolicyLoadResult
 *   - PolicySignatureError throw behaviour
 *   - createUnsignedBundle() helper
 *   - Integration: provenance flows through LayeredPolicyEvaluator decisions
 */

import { describe, it, expect } from 'bun:test';
import {
  loadPolicyBundle,
  createUnsignedBundle,
  PolicySignatureError,
} from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-loader';
import { signBundle } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-signer';
import { createPermissionEvaluator } from '@pellux/goodvibes-sdk/platform/runtime/permissions/index';
import type { PolicyBundlePayload, BundleProvenance } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-loader';
import type { SignedPolicyBundle } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-signer';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_KEY = 'a'.repeat(64);
const WRONG_KEY = 'b'.repeat(64);

const EMPTY_PAYLOAD: PolicyBundlePayload = { version: 1, rules: [] };

function makeSignedBundle(id: string, key = TEST_KEY): SignedPolicyBundle<PolicyBundlePayload> {
  return signBundle(id, EMPTY_PAYLOAD, key);
}

// ── Non-managed mode ──────────────────────────────────────────────────────────

describe('loadPolicyBundle (non-managed mode)', () => {
  it('accepts a valid signed bundle', () => {
    const bundle = makeSignedBundle('nm-1');
    const result = loadPolicyBundle(bundle, {
      signingKey: TEST_KEY,
      managed: false,
      provenanceSource: 'local-file',
    });
    expect(result.ok).toBe(true);
    expect(result.rules).toEqual([]);
    expect(result.provenance.signatureStatus).toBe('valid');
    expect(result.provenance.policyBundleId).toBe('nm-1');
    expect(result.provenance.provenanceSource).toBe('local-file');
  });

  it('accepts an unsigned bundle with status=unsigned (no key)', () => {
    const bundle = createUnsignedBundle('nm-2', EMPTY_PAYLOAD);
    const result = loadPolicyBundle(bundle, { managed: false });
    expect(result.ok).toBe(true);
    // No key provided => skipped
    expect(result.provenance.signatureStatus).toBe('skipped');
  });

  it('accepts a bundle with no signature and a key supplied (status=unsigned)', () => {
    const bundle = createUnsignedBundle('nm-3', EMPTY_PAYLOAD);
    const result = loadPolicyBundle(bundle, {
      signingKey: TEST_KEY,
      managed: false,
    });
    // Non-managed mode allows unsigned bundles; status is 'unsigned' (not 'missing')
    expect(result.ok).toBe(true);
    expect(result.provenance.signatureStatus).toBe('unsigned');
  });

  it('accepts a bundle with invalid signature in non-managed mode', () => {
    const bundle = makeSignedBundle('nm-4', WRONG_KEY);
    const result = loadPolicyBundle(bundle, {
      signingKey: TEST_KEY,  // Different key
      managed: false,
    });
    expect(result.ok).toBe(true);
    expect(result.provenance.signatureStatus).toBe('invalid');
  });

  it('populates issuedAt and issuer in provenance', () => {
    const bundle = signBundle('nm-5', EMPTY_PAYLOAD, TEST_KEY, 'acme-corp');
    const result = loadPolicyBundle(bundle, { signingKey: TEST_KEY });
    expect(result.ok).toBe(true);
    expect(result.provenance.issuedAt).toBeDefined();
    expect(result.provenance.issuer).toBe('acme-corp');
  });

  it('defaults provenanceSource to inline when not provided', () => {
    const bundle = makeSignedBundle('nm-6');
    const result = loadPolicyBundle(bundle, { signingKey: TEST_KEY });
    expect(result.provenance.provenanceSource).toBe('inline');
  });
});

// ── Managed mode ──────────────────────────────────────────────────────────────

describe('loadPolicyBundle (managed mode)', () => {
  it('accepts a valid signed bundle in managed mode', () => {
    const bundle = makeSignedBundle('m-1');
    const result = loadPolicyBundle(bundle, {
      signingKey: TEST_KEY,
      managed: true,
      provenanceSource: 'remote-url',
    });
    expect(result.ok).toBe(true);
    expect(result.provenance.signatureStatus).toBe('valid');
    expect(result.provenance.provenanceSource).toBe('remote-url');
  });

  it('rejects an unsigned bundle in managed mode (status=skipped, no key)', () => {
    const bundle = createUnsignedBundle('m-2', EMPTY_PAYLOAD);
    const result = loadPolicyBundle(bundle, { managed: true });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.provenance.signatureStatus).toBe('skipped');
  });

  it('rejects a bundle with missing signature in managed mode', () => {
    const bundle = createUnsignedBundle('m-3', EMPTY_PAYLOAD);
    const result = loadPolicyBundle(bundle, {
      signingKey: TEST_KEY,
      managed: true,
    });
    expect(result.ok).toBe(false);
    expect(result.provenance.signatureStatus).toBe('unsigned');
    expect(result.error).toContain('m-3');
  });

  it('rejects a bundle with invalid signature in managed mode', () => {
    // Sign with wrong key
    const bundle = makeSignedBundle('m-4', WRONG_KEY);
    const result = loadPolicyBundle(bundle, {
      signingKey: TEST_KEY,
      managed: true,
    });
    expect(result.ok).toBe(false);
    expect(result.provenance.signatureStatus).toBe('invalid');
    expect(result.error).toContain('m-4');
  });

  it('rejects when no key is provided in managed mode', () => {
    const bundle = makeSignedBundle('m-5');
    // Managed mode but no key — status=skipped → rejected
    const result = loadPolicyBundle(bundle, { managed: true });
    expect(result.ok).toBe(false);
    expect(result.provenance.signatureStatus).toBe('skipped');
  });
});

// ── PolicySignatureError throw ────────────────────────────────────────────────

describe('loadPolicyBundle (throwOnRejection)', () => {
  it('throws PolicySignatureError on managed rejection when throwOnRejection=true', () => {
    const bundle = createUnsignedBundle('t-1', EMPTY_PAYLOAD);
    expect(() =>
      loadPolicyBundle(bundle, {
        signingKey: TEST_KEY,
        managed: true,
        throwOnRejection: true,
      }),
    ).toThrow(PolicySignatureError);
  });

  it('thrown error carries bundleId and signatureStatus', () => {
    const bundle = createUnsignedBundle('t-2', EMPTY_PAYLOAD);
    let caught: PolicySignatureError | undefined;
    try {
      loadPolicyBundle(bundle, {
        signingKey: TEST_KEY,
        managed: true,
        throwOnRejection: true,
      });
    } catch (e) {
      caught = e as PolicySignatureError;
    }
    expect(caught).toBeDefined();
    expect(caught!.bundleId).toBe('t-2');
    expect(caught!.signatureStatus).toBe('unsigned');
    expect(caught!.name).toBe('PolicySignatureError');
  });

  it('does not throw when ok=true even with throwOnRejection=true', () => {
    const bundle = makeSignedBundle('t-3');
    expect(() =>
      loadPolicyBundle(bundle, {
        signingKey: TEST_KEY,
        managed: true,
        throwOnRejection: true,
      }),
    ).not.toThrow();
  });
});

// ── createUnsignedBundle ──────────────────────────────────────────────────────

describe('createUnsignedBundle', () => {
  it('creates a bundle with no signature', () => {
    const bundle = createUnsignedBundle('u-1', EMPTY_PAYLOAD);
    expect(bundle.bundleId).toBe('u-1');
    expect(bundle.signature).toBeUndefined();
    expect(bundle.payload).toEqual(EMPTY_PAYLOAD);
  });

  it('sets issuedAt to a valid ISO 8601 string', () => {
    const bundle = createUnsignedBundle('u-2', EMPTY_PAYLOAD);
    expect(() => new Date(bundle.issuedAt)).not.toThrow();
    expect(new Date(bundle.issuedAt).toISOString()).toBe(bundle.issuedAt);
  });
});

// ── Integration: provenance flows through evaluator decisions ─────────────────

describe('provenance in PermissionDecision (integration)', () => {
  it('attaches policyBundleId, signatureStatus, and provenanceSource to decisions', () => {
    const bundle = makeSignedBundle('int-1');
    const result = loadPolicyBundle(bundle, {
      signingKey: TEST_KEY,
      managed: false,
      provenanceSource: 'local-file',
    });
    expect(result.ok).toBe(true);

    const provenance = result.provenance as BundleProvenance;
    const evaluator = createPermissionEvaluator(
      { mode: 'default', rules: result.rules },
      provenance,
    );

    const decision = evaluator.evaluate('read', { path: '/tmp/foo.txt' });
    expect(decision.policyBundleId).toBe('int-1');
    expect(decision.signatureStatus).toBe('valid');
    expect(decision.provenanceSource).toBe('local-file');
  });

  it('leaves provenance fields undefined when no bundle is loaded', () => {
    const evaluator = createPermissionEvaluator({ mode: 'default' });
    const decision = evaluator.evaluate('read', { path: '/tmp/foo.txt' });
    expect(decision.policyBundleId).toBeUndefined();
    expect(decision.signatureStatus).toBeUndefined();
    expect(decision.provenanceSource).toBeUndefined();
  });

  it('records invalid-signature provenance on decisions (non-managed, invalid sig)', () => {
    const bundle = makeSignedBundle('int-2', WRONG_KEY);
    const result = loadPolicyBundle(bundle, {
      signingKey: TEST_KEY,
      managed: false,
    });
    expect(result.ok).toBe(true);
    expect(result.provenance.signatureStatus).toBe('invalid');

    const evaluator = createPermissionEvaluator(
      { mode: 'default' },
      result.provenance,
    );
    const decision = evaluator.evaluate('write', { path: '/tmp/out.txt' });
    expect(decision.signatureStatus).toBe('invalid');
  });
});
