/**
 * GC-PERM-011 — Tests for policy signing and verification.
 *
 * Covers:
 *   - canonicalise(): deterministic serialisation
 *   - signBundle(): signature generation
 *   - verifyBundle(): valid, invalid, missing signature cases
 */

import { describe, it, expect } from 'bun:test';
import {
  canonicalise,
  signBundle,
  verifyBundle,
} from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-signer';
import type { SignedPolicyBundle } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-signer';

// ── Fixture helpers ───────────────────────────────────────────────────────────

/** 32-byte test key (hex) */
const TEST_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes
const TEST_KEY_B = 'b'.repeat(64); // Different key

const TEST_PAYLOAD = { version: 1, rules: [], description: 'test bundle' };

// ── canonicalise ─────────────────────────────────────────────────────────────

describe('canonicalise', () => {
  it('produces identical output regardless of key insertion order', () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { m: 3, z: 1, a: 2 };
    expect(canonicalise(a)).toBe(canonicalise(b));
  });

  it('handles nested objects with sorted keys', () => {
    const obj = { outer: { z: 1, a: 2 } };
    expect(canonicalise(obj)).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('handles arrays preserving order', () => {
    const arr = [3, 1, 2];
    expect(canonicalise(arr)).toBe('[3,1,2]');
  });

  it('handles null, numbers, booleans, and strings', () => {
    expect(canonicalise(null)).toBe('null');
    expect(canonicalise(42)).toBe('42');
    expect(canonicalise(true)).toBe('true');
    expect(canonicalise('hello')).toBe('"hello"');
  });

  it('handles empty objects and arrays', () => {
    expect(canonicalise({})).toBe('{}');
    expect(canonicalise([])).toBe('[]');
  });
});

// ── signBundle ────────────────────────────────────────────────────────────────

describe('signBundle', () => {
  it('returns a bundle with a hex signature', () => {
    const bundle = signBundle('test-bundle-1', TEST_PAYLOAD, TEST_KEY);
    expect(bundle.bundleId).toBe('test-bundle-1');
    expect(typeof bundle.signature).toBe('string');
    expect(bundle.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('includes payload and issuedAt in the bundle', () => {
    const bundle = signBundle('b2', TEST_PAYLOAD, TEST_KEY);
    expect(bundle.payload).toEqual(TEST_PAYLOAD);
    expect(typeof bundle.issuedAt).toBe('string');
    // issuedAt should be a valid ISO 8601 string
    expect(() => new Date(bundle.issuedAt)).not.toThrow();
  });

  it('includes issuer when provided', () => {
    const bundle = signBundle('b3', TEST_PAYLOAD, TEST_KEY, 'test-issuer');
    expect(bundle.issuer).toBe('test-issuer');
  });

  it('omits issuer when not provided', () => {
    const bundle = signBundle('b4', TEST_PAYLOAD, TEST_KEY);
    expect(bundle.issuer).toBeUndefined();
  });

  it('produces a signature that round-trips through verify for the same bundle', () => {
    // Since issuedAt is generated at sign time, two independent sign() calls
    // will have different issuedAt and thus different signatures. The correct
    // stability test is that the signed bundle verifies successfully.
    const bundle = signBundle('b5', TEST_PAYLOAD, TEST_KEY);
    const { ok, status } = verifyBundle(bundle, TEST_KEY);
    expect(ok).toBe(true);
    expect(status).toBe('valid');
  });

  it('accepts Buffer keys', () => {
    const keyBuf = Buffer.from(TEST_KEY, 'hex');
    const bundle = signBundle('b6', TEST_PAYLOAD, keyBuf);
    expect(bundle.signature).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── verifyBundle ──────────────────────────────────────────────────────────────

describe('verifyBundle', () => {
  it('returns ok=true for a correctly signed bundle', () => {
    const bundle = signBundle('v1', TEST_PAYLOAD, TEST_KEY);
    const result = verifyBundle(bundle, TEST_KEY);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('valid');
  });

  it('returns ok=false with status=invalid when signature does not match', () => {
    const bundle = signBundle('v2', TEST_PAYLOAD, TEST_KEY);
    // Verify with a different key
    const result = verifyBundle(bundle, TEST_KEY_B);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('invalid');
  });

  it('returns ok=false with status=invalid when payload is tampered', () => {
    const bundle = signBundle('v3', TEST_PAYLOAD, TEST_KEY);
    // Tamper with the payload after signing
    const tampered: SignedPolicyBundle<typeof TEST_PAYLOAD> = {
      ...bundle,
      payload: { ...TEST_PAYLOAD, description: 'tampered!' },
    };
    const result = verifyBundle(tampered, TEST_KEY);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('invalid');
  });

  it('returns ok=false with status=missing when signature is absent', () => {
    const unsigned: SignedPolicyBundle<typeof TEST_PAYLOAD> = {
      bundleId: 'v4',
      issuedAt: new Date().toISOString(),
      payload: TEST_PAYLOAD,
      // No signature
    };
    const result = verifyBundle(unsigned, TEST_KEY);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('missing');
  });

  it('returns ok=false with status=missing when signature is empty string', () => {
    const bundle: SignedPolicyBundle<typeof TEST_PAYLOAD> = {
      bundleId: 'v5',
      issuedAt: new Date().toISOString(),
      payload: TEST_PAYLOAD,
      signature: '',
    };
    const result = verifyBundle(bundle, TEST_KEY);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('missing');
  });

  it('returns ok=false with status=invalid for non-hex signature', () => {
    const bundle: SignedPolicyBundle<typeof TEST_PAYLOAD> = {
      bundleId: 'v6',
      issuedAt: new Date().toISOString(),
      payload: TEST_PAYLOAD,
      signature: 'not-valid-hex!!!!',
    };
    const result = verifyBundle(bundle, TEST_KEY);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('invalid');
  });

  it('accepts Buffer keys for verification', () => {
    const keyBuf = Buffer.from(TEST_KEY, 'hex');
    const bundle = signBundle('v7', TEST_PAYLOAD, keyBuf);
    const result = verifyBundle(bundle, keyBuf);
    expect(result.ok).toBe(true);
  });

  it('cross-verifies: sign with string key, verify with Buffer key', () => {
    const bundle = signBundle('v8', TEST_PAYLOAD, TEST_KEY);
    const keyBuf = Buffer.from(TEST_KEY, 'hex');
    const result = verifyBundle(bundle, keyBuf);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('valid');
  });

  it('returns ok=false with status=invalid when bundleId is swapped (metadata covers HMAC)', () => {
    const bundle = signBundle('v9', TEST_PAYLOAD, TEST_KEY);
    // Attacker swaps bundleId without re-signing
    const tampered: SignedPolicyBundle<typeof TEST_PAYLOAD> = {
      ...bundle,
      bundleId: 'attacker-bundle-id',
    };
    const result = verifyBundle(tampered, TEST_KEY);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('invalid');
  });

  it('returns ok=false with status=invalid when issuedAt is swapped (metadata covers HMAC)', () => {
    const bundle = signBundle('v10', TEST_PAYLOAD, TEST_KEY);
    // Attacker swaps timestamp without re-signing
    const tampered: SignedPolicyBundle<typeof TEST_PAYLOAD> = {
      ...bundle,
      issuedAt: '1970-01-01T00:00:00.000Z',
    };
    const result = verifyBundle(tampered, TEST_KEY);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('invalid');
  });
});
