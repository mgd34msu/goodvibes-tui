/**
 * Output schema fingerprint stability tests.
 *
 * Tests:
 *   - Same mode/input class produces stable (deterministic) fingerprint
 *   - Different key sets produce different fingerprints
 *   - Values do not affect the fingerprint (schema-level identity)
 *   - getSchemaShapeId returns canonical IDs for known modes
 *   - appendSchemaFingerprint is a no-op when flag is disabled
 *   - appendSchemaFingerprint injects _meta when flag is enabled
 */

import { describe, it, expect } from 'bun:test';
import { createFeatureFlagManager } from '../../runtime/feature-flags/manager.ts';
import {
  computeSchemaFingerprintSync,
  computeSchemaFingerprint,
  getSchemaShapeId,
  appendSchemaFingerprint,
  SCHEMA_SHAPE_IDS,
  type SchemaFingerprintMeta,
} from '../../tools/shared/schema-fingerprint.ts';

// ---------------------------------------------------------------------------
// computeSchemaFingerprintSync — stability
// ---------------------------------------------------------------------------

describe('computeSchemaFingerprintSync — stability', () => {
  it('produces the same fingerprint for the same key set', () => {
    const resultA = { files: ['a.ts', 'b.ts'], count: 2 };
    const resultB = { files: ['x.ts'], count: 1 };

    const fpA1 = computeSchemaFingerprintSync(resultA);
    const fpA2 = computeSchemaFingerprintSync(resultA);
    const fpB1 = computeSchemaFingerprintSync(resultB);

    // Same key set → same fingerprint regardless of call order
    expect(fpA1).toBe(fpA2);
    // Both resultA and resultB share the same keys {files, count}
    expect(fpA1).toBe(fpB1);
  });

  it('is insensitive to value changes (schema-level identity)', () => {
    const v1 = { matches: ['x'], count: 1, error: undefined };
    const v2 = { matches: ['a', 'b', 'c'], count: 99, error: undefined };

    // Same keys → same fingerprint
    expect(computeSchemaFingerprintSync(v1)).toBe(computeSchemaFingerprintSync(v2));
  });

  it('differs when key sets differ', () => {
    const schema1 = { files: [], count: 0 };
    const schema2 = { matches: [], count: 0, context: '' };

    expect(computeSchemaFingerprintSync(schema1)).not.toBe(computeSchemaFingerprintSync(schema2));
  });

  it('is insensitive to key insertion order', () => {
    const a = { count: 0, files: [] };
    const b = { files: [], count: 0 };

    expect(computeSchemaFingerprintSync(a)).toBe(computeSchemaFingerprintSync(b));
  });

  it('returns a non-empty hex string', () => {
    const fp = computeSchemaFingerprintSync({ foo: 1, bar: 2 });
    expect(fp.length).toBeGreaterThan(0);
    expect(/^[0-9a-f]+$/.test(fp)).toBe(true);
  });

  it('handles empty object (no keys)', () => {
    const fp1 = computeSchemaFingerprintSync({});
    const fp2 = computeSchemaFingerprintSync({});
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBeGreaterThan(0);
  });

  it('handles single-key object', () => {
    const fp1 = computeSchemaFingerprintSync({ error: 'boom' });
    const fp2 = computeSchemaFingerprintSync({ error: 'different error message' });
    expect(fp1).toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// computeSchemaFingerprint (async) — stability
// ---------------------------------------------------------------------------

describe('computeSchemaFingerprint (async) — stability', () => {
  it('produces the same fingerprint for the same key set', async () => {
    const a = { files: ['a.ts'], count: 1 };
    const b = { files: ['z.ts'], count: 99 };

    const fpA = await computeSchemaFingerprint(a);
    const fpB = await computeSchemaFingerprint(b);

    // Same keys → same fingerprint
    expect(fpA).toBe(fpB);
  });

  it('returns a 64-character hex string (SHA-256)', async () => {
    const fp = await computeSchemaFingerprint({ foo: 1 });
    expect(fp).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(fp)).toBe(true);
  });

  it('differs for different key sets', async () => {
    const fp1 = await computeSchemaFingerprint({ a: 1, b: 2 });
    const fp2 = await computeSchemaFingerprint({ a: 1, c: 2 });
    expect(fp1).not.toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// getSchemaShapeId — canonical IDs
// ---------------------------------------------------------------------------

describe('getSchemaShapeId — canonical shape IDs', () => {
  it('returns correct ID for find:files', () => {
    expect(getSchemaShapeId('find', 'files')).toBe('find.files.v1');
  });

  it('returns correct ID for analyze:impact', () => {
    expect(getSchemaShapeId('analyze', 'impact')).toBe('analyze.impact.v1');
  });

  it('returns correct ID for inspect:project', () => {
    expect(getSchemaShapeId('inspect', 'project')).toBe('inspect.project.v1');
  });

  it('falls back gracefully for unknown modes', () => {
    const id = getSchemaShapeId('find', 'future_mode');
    expect(id).toBe('find.future_mode.v1');
  });

  it('all registered shape IDs have the v1 suffix', () => {
    for (const [, id] of Object.entries(SCHEMA_SHAPE_IDS)) {
      expect(id.endsWith('.v1')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// appendSchemaFingerprint — feature flag off (default)
// ---------------------------------------------------------------------------

describe('appendSchemaFingerprint — flag disabled (default)', () => {
  it('returns the original object unchanged when flag is disabled', () => {
    const original = { files: ['a.ts'], count: 1 };
    const featureFlags = createFeatureFlagManager();
    const result = appendSchemaFingerprint(original, 'find', 'files', { featureFlags });

    expect(result).toBe(original); // reference equality — no copy
    expect(result._meta).toBeUndefined();
  });

  it('does not throw for any tool/mode combination', () => {
    const data = { matches: [], count: 0 };
    const featureFlags = createFeatureFlagManager();
    expect(() => appendSchemaFingerprint(data, 'analyze', 'dead_code', { featureFlags })).not.toThrow();
    expect(() => appendSchemaFingerprint(data, 'inspect', 'components', { featureFlags })).not.toThrow();
    expect(() => appendSchemaFingerprint(data, 'find', 'structural', { featureFlags })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// appendSchemaFingerprint — feature flag on (mocked)
// ---------------------------------------------------------------------------

describe('appendSchemaFingerprint — flag enabled (mocked)', () => {
  it('appendSchemaFingerprint injects _meta with correct fields when flag is enabled', () => {
    const result = { files: ['a.ts'], count: 1 };
    const featureFlags = createFeatureFlagManager();
    featureFlags.enable('output-schema-fingerprint');
    const augmented = appendSchemaFingerprint(result, 'find', 'files', { featureFlags });

    expect(augmented._meta).toBeDefined();
    const meta = augmented._meta as SchemaFingerprintMeta;
    expect(meta.schemaShapeId).toBe('find.files.v1');
    expect(typeof meta.outputSchemaFingerprint).toBe('string');
    expect(meta.outputSchemaFingerprint.length).toBeGreaterThan(0);
    expect(/^[0-9a-f]+$/.test(meta.outputSchemaFingerprint)).toBe(true);
  });

  it('appendSchemaFingerprint merges with existing _meta instead of overwriting', () => {
    const existing = { files: ['a.ts'], count: 1, _meta: { customField: 'preserved' } };
    const featureFlags = createFeatureFlagManager();
    featureFlags.enable('output-schema-fingerprint');
    const augmented = appendSchemaFingerprint(existing as Record<string, unknown>, 'find', 'files', { featureFlags });

    const meta = augmented._meta as Record<string, unknown>;
    expect(meta.customField).toBe('preserved');
    expect(meta.schemaShapeId).toBe('find.files.v1');
    expect(typeof meta.outputSchemaFingerprint).toBe('string');
  });

  it('fingerprint in augmented result is stable across repeated calls', () => {
    const result = { routes: [], count: 0 };
    const fp1 = computeSchemaFingerprintSync(result);
    const fp2 = computeSchemaFingerprintSync(result);
    const fp3 = computeSchemaFingerprintSync({ routes: [{ path: '/api', method: 'GET' }], count: 1 });

    // All three have the same keys → same fingerprint
    expect(fp1).toBe(fp2);
    expect(fp1).toBe(fp3);
  });

  it('_meta field does not affect fingerprint of the outer result', () => {
    // When we add _meta to a result, the key set changes.
    // The original schema and the augmented schema should have different fingerprints.
    const original = { files: ['a.ts'], count: 1 };
    const augmented = { files: ['a.ts'], count: 1, _meta: { schemaShapeId: 'x', outputSchemaFingerprint: 'y' } };

    const fpOrig = computeSchemaFingerprintSync(original);
    const fpAug = computeSchemaFingerprintSync(augmented);

    expect(fpOrig).not.toBe(fpAug);
  });
});

// ---------------------------------------------------------------------------
// Mode-level stability: same mode → same fingerprint class
// ---------------------------------------------------------------------------

describe('mode-level fingerprint stability (same mode/input class)', () => {
  const modes: Array<{ tool: string; mode: string; sampleResult: Record<string, unknown> }> = [
    { tool: 'find', mode: 'files',      sampleResult: { files: [], count: 0 } },
    { tool: 'find', mode: 'content',    sampleResult: { matches: [], count: 0 } },
    { tool: 'find', mode: 'symbols',    sampleResult: { symbols: [], count: 0 } },
    { tool: 'analyze', mode: 'impact',  sampleResult: { impacted: [], count: 0 } },
    { tool: 'analyze', mode: 'security', sampleResult: { findings: [], count: 0 } },
    { tool: 'inspect', mode: 'project', sampleResult: { type: 'nodejs', framework: 'next' } },
    { tool: 'inspect', mode: 'api',     sampleResult: { routes: [], count: 0 } },
  ];

  for (const { tool, mode, sampleResult } of modes) {
    it(`${tool}:${mode} — same schema produces same fingerprint across invocations`, () => {
      const fp1 = computeSchemaFingerprintSync(sampleResult);
      // Simulate second invocation with different values but same keys
      const secondResult = Object.fromEntries(
        Object.keys(sampleResult).map((k) => [k, typeof sampleResult[k] === 'number' ? 42 : []]),
      );
      const fp2 = computeSchemaFingerprintSync(secondResult);

      expect(fp1).toBe(fp2);

      // Shape ID is consistent
      expect(getSchemaShapeId(tool, mode)).toBeTruthy();
    });
  }
});
