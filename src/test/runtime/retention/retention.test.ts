/**
 * retention.test.ts
 *
 * Comprehensive tests for the snapshot retention and pruning policy subsystem.
 *
 * Test strategy:
 *  - All tests inject a mock pruner to avoid file-system I/O.
 *  - RetentionPolicy tests use an injectable clock for deterministic time assertions.
 *  - SnapshotPruner path-validation tests run in-process (no I/O needed for rejects).
 */

import { describe, it, expect } from 'bun:test';
// Retention symbols come straight from the SDK operations namespace rather than
// the local runtime barrel: the barrel deliberately does not re-export them
// (see src/runtime/index.ts) because a same-named re-export collided with the
// SDK's own `class SnapshotPruner` and produced a compiled-binary startup crash.
import { operations } from '@pellux/goodvibes-sdk/platform/runtime';

const { RetentionPolicy, DEFAULT_RETENTION_CONFIG, SnapshotPruner } = operations;
import type {
  CheckpointRecord,
  PerClassPruneResult,
  Pruner,
  PruneOptions,
  PruneResult,
  RetentionClass,
} from '@/runtime/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_TIME = 1_000_000_000_000; // fixed epoch for deterministic tests

function makeRecord(
  id: string,
  opts: {
    createdAt?: number;
    sizeBytes?: number;
    retentionClass?: RetentionClass;
    path?: string;
  } = {},
): CheckpointRecord {
  return {
    id,
    createdAt: opts.createdAt ?? BASE_TIME,
    sizeBytes: opts.sizeBytes ?? 1024,
    retentionClass: opts.retentionClass ?? 'standard',
    path: opts.path ?? `/data/checkpoints/${id}.json`,
  };
}

function emptyPerClass(): PerClassPruneResult {
  return { deletedCount: 0, reclaimedBytes: 0, deletedIds: [], candidateIds: [], failedIds: [] };
}

/**
 * A mock Pruner implementation that captures what it was called with and
 * optionally injects failures for specific IDs.
 */
class MockPruner implements Pruner {
  calls: Array<{ candidates: readonly CheckpointRecord[]; options?: PruneOptions }> = [];
  failIds: Set<string> = new Set();

  async delete(
    candidates: readonly CheckpointRecord[],
    options: PruneOptions = {},
  ): Promise<PruneResult> {
    this.calls.push({ candidates, options });
    const { dryRun = false } = options;

    const deletedIds: string[] = [];
    const candidateIds: string[] = [];
    const failedIds: string[] = [];
    const errors: Record<string, string> = {};
    let reclaimedBytes = 0;

    const byClass: Record<RetentionClass, { deletedIds: string[]; candidateIds: string[]; failedIds: string[]; reclaimedBytes: number }> = {
      short: { deletedIds: [], candidateIds: [], failedIds: [], reclaimedBytes: 0 },
      standard: { deletedIds: [], candidateIds: [], failedIds: [], reclaimedBytes: 0 },
      forensic: { deletedIds: [], candidateIds: [], failedIds: [], reclaimedBytes: 0 },
    };

    for (const record of candidates) {
      if (dryRun) {
        candidateIds.push(record.id);
        byClass[record.retentionClass].candidateIds.push(record.id);
        continue;
      }
      if (this.failIds.has(record.id)) {
        failedIds.push(record.id);
        errors[record.id] = 'mock I/O error';
        byClass[record.retentionClass].failedIds.push(record.id);
      } else {
        deletedIds.push(record.id);
        reclaimedBytes += record.sizeBytes;
        byClass[record.retentionClass].deletedIds.push(record.id);
        byClass[record.retentionClass].reclaimedBytes += record.sizeBytes;
      }
    }

    const toPerClass = (cls: RetentionClass): PerClassPruneResult => ({
      deletedCount: byClass[cls].deletedIds.length,
      reclaimedBytes: byClass[cls].reclaimedBytes,
      deletedIds: byClass[cls].deletedIds,
      candidateIds: byClass[cls].candidateIds,
      failedIds: byClass[cls].failedIds,
    });

    return {
      deletedCount: deletedIds.length,
      reclaimedBytes,
      deletedIds,
      candidateIds,
      failedIds,
      errors,
      dryRun,
      byClass: {
        short: toPerClass('short'),
        standard: toPerClass('standard'),
        forensic: toPerClass('forensic'),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// RetentionPolicy, age-based pruning
// ---------------------------------------------------------------------------

describe('RetentionPolicy: age-based pruning', () => {
  it('marks expired records as candidates and keeps recent ones', async () => {
    const mock = new MockPruner();
    const now = BASE_TIME + 2 * 60 * 60 * 1000; // 2 hours after base
    const policy = new RetentionPolicy(
      { short: { ...DEFAULT_RETENTION_CONFIG.short, maxAgeMs: 60 * 60 * 1000 } },
      () => now,
      mock,
    );

    // expired: 2 hours old (> 1h maxAgeMs)
    policy.register(makeRecord('old', { createdAt: BASE_TIME, retentionClass: 'short' }));
    // recent: 30 min old
    policy.register(
      makeRecord('new', { createdAt: now - 30 * 60 * 1000, retentionClass: 'short' }),
    );

    await policy.prune();

    const { candidates } = mock.calls[0]!;
    expect(candidates.map((c) => c.id)).toContain('old');
    expect(candidates.map((c) => c.id)).not.toContain('new');
  });

  it('removes deleted records from tracking after successful prune', async () => {
    const mock = new MockPruner();
    const now = BASE_TIME + 2 * 60 * 60 * 1000;
    const policy = new RetentionPolicy(
      { short: { ...DEFAULT_RETENTION_CONFIG.short, maxAgeMs: 60 * 60 * 1000 } },
      () => now,
      mock,
    );

    policy.register(makeRecord('expired', { createdAt: BASE_TIME, retentionClass: 'short' }));
    await policy.prune();

    const stats = policy.getRetainedCount();
    expect(stats.counts.short).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RetentionPolicy, count-based pruning
// ---------------------------------------------------------------------------

describe('RetentionPolicy: count-based pruning', () => {
  it('prunes oldest records when count exceeds maxCount', async () => {
    const mock = new MockPruner();
    const policy = new RetentionPolicy(
      { standard: { maxAgeMs: 999_999_999, maxCount: 3, maxSizeBytes: 999_999_999 } },
      () => BASE_TIME + 1000,
      mock,
    );

    // Register 5 records in order, oldest first
    for (let i = 1; i <= 5; i++) {
      policy.register(
        makeRecord(`cpt_${i}`, { createdAt: BASE_TIME + i * 1000, retentionClass: 'standard' }),
      );
    }

    await policy.prune();

    const pruned = mock.calls[0]!.candidates.map((c) => c.id);
    // cpt_1 and cpt_2 are oldest and should be pruned (5 - 3 = 2 excess)
    expect(pruned).toContain('cpt_1');
    expect(pruned).toContain('cpt_2');
    // cpt_3, cpt_4, cpt_5 should be kept
    expect(pruned).not.toContain('cpt_3');
    expect(pruned).not.toContain('cpt_4');
    expect(pruned).not.toContain('cpt_5');
  });

  it('keeps all records when count is at or below maxCount', async () => {
    const mock = new MockPruner();
    const policy = new RetentionPolicy(
      { standard: { maxAgeMs: 999_999_999, maxCount: 5, maxSizeBytes: 999_999_999 } },
      () => BASE_TIME + 1000,
      mock,
    );

    for (let i = 1; i <= 5; i++) {
      policy.register(
        makeRecord(`cpt_${i}`, { createdAt: BASE_TIME + i * 1000, retentionClass: 'standard' }),
      );
    }

    await policy.prune();
    expect(mock.calls[0]!.candidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// RetentionPolicy, size-based pruning
// ---------------------------------------------------------------------------

describe('RetentionPolicy: size-based pruning', () => {
  it('prunes largest oldest records until total size fits', async () => {
    const mock = new MockPruner();
    // maxSizeBytes = 100 bytes; each record is 60 bytes → 2 records = 120 > 100
    const policy = new RetentionPolicy(
      { standard: { maxAgeMs: 999_999_999, maxCount: 999, maxSizeBytes: 100 } },
      () => BASE_TIME + 1000,
      mock,
    );

    policy.register(
      makeRecord('cpt_old', { createdAt: BASE_TIME + 1, sizeBytes: 60, retentionClass: 'standard' }),
    );
    policy.register(
      makeRecord('cpt_new', { createdAt: BASE_TIME + 2, sizeBytes: 60, retentionClass: 'standard' }),
    );

    await policy.prune();
    const pruned = mock.calls[0]!.candidates.map((c) => c.id);
    // oldest should be pruned first
    expect(pruned).toContain('cpt_old');
    expect(pruned).not.toContain('cpt_new');
  });

  it('keeps all records when total size is within budget', async () => {
    const mock = new MockPruner();
    const policy = new RetentionPolicy(
      { standard: { maxAgeMs: 999_999_999, maxCount: 999, maxSizeBytes: 200 } },
      () => BASE_TIME + 1000,
      mock,
    );

    policy.register(
      makeRecord('cpt_a', { createdAt: BASE_TIME + 1, sizeBytes: 50, retentionClass: 'standard' }),
    );
    policy.register(
      makeRecord('cpt_b', { createdAt: BASE_TIME + 2, sizeBytes: 50, retentionClass: 'standard' }),
    );

    await policy.prune();
    expect(mock.calls[0]!.candidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// RetentionPolicy, dry-run mode
// ---------------------------------------------------------------------------

describe('RetentionPolicy: dry-run mode', () => {
  it('does not remove records from tracking in dry-run mode', async () => {
    const mock = new MockPruner();
    const now = BASE_TIME + 2 * 60 * 60 * 1000;
    const policy = new RetentionPolicy(
      { short: { ...DEFAULT_RETENTION_CONFIG.short, maxAgeMs: 60 * 60 * 1000 } },
      () => now,
      mock,
    );

    policy.register(makeRecord('expired', { createdAt: BASE_TIME, retentionClass: 'short' }));

    const result = await policy.prune({ dryRun: true });

    expect(result.dryRun).toBe(true);
    // Record should still be tracked after dry-run
    expect(policy.getRetainedCount().counts.short).toBe(1);
  });

  it('returns candidateIds (not deletedIds) in dry-run mode via mock pruner', async () => {
    const mock = new MockPruner();
    const now = BASE_TIME + 2 * 60 * 60 * 1000;
    const policy = new RetentionPolicy(
      { short: { ...DEFAULT_RETENTION_CONFIG.short, maxAgeMs: 60 * 60 * 1000 } },
      () => now,
      mock,
    );

    policy.register(makeRecord('expired', { createdAt: BASE_TIME, retentionClass: 'short' }));

    const result = await policy.prune({ dryRun: true });

    expect(result.deletedIds).toHaveLength(0);
    expect(result.candidateIds).toContain('expired');
  });
});

// ---------------------------------------------------------------------------
// RetentionPolicy, per-class breakdown
// ---------------------------------------------------------------------------

describe('RetentionPolicy: per-class breakdown', () => {
  it('correctly attributes pruned records to their retention class', async () => {
    const mock = new MockPruner();
    const now = BASE_TIME + 10 * 60 * 60 * 1000; // 10 hours later
    const policy = new RetentionPolicy(
      {
        short: { maxAgeMs: 60 * 60 * 1000, maxCount: 999, maxSizeBytes: 999_999_999 },
        standard: { maxAgeMs: 5 * 60 * 60 * 1000, maxCount: 999, maxSizeBytes: 999_999_999 },
        forensic: { maxAgeMs: 999 * 60 * 60 * 1000, maxCount: 999, maxSizeBytes: 999_999_999 },
      },
      () => now,
      mock,
    );

    // short: expired (> 1h)
    policy.register(makeRecord('s1', { createdAt: BASE_TIME, retentionClass: 'short' }));
    // standard: expired (> 5h)
    policy.register(makeRecord('st1', { createdAt: BASE_TIME, retentionClass: 'standard' }));
    // forensic: NOT expired (< 999h)
    policy.register(makeRecord('f1', { createdAt: BASE_TIME, retentionClass: 'forensic' }));

    const result = await policy.prune();

    expect(result.byClass.short.deletedIds).toContain('s1');
    expect(result.byClass.standard.deletedIds).toContain('st1');
    expect(result.byClass.forensic.deletedIds).not.toContain('f1');
  });
});

// ---------------------------------------------------------------------------
// RetentionPolicy, error handling (partial failures)
// ---------------------------------------------------------------------------

describe('RetentionPolicy: error handling', () => {
  it('returns partial results when some deletions fail', async () => {
    const mock = new MockPruner();
    mock.failIds.add('cpt_fail');
    const now = BASE_TIME + 2 * 60 * 60 * 1000;
    const policy = new RetentionPolicy(
      { short: { maxAgeMs: 60 * 60 * 1000, maxCount: 999, maxSizeBytes: 999_999_999 } },
      () => now,
      mock,
    );

    policy.register(makeRecord('cpt_ok', { createdAt: BASE_TIME, retentionClass: 'short' }));
    policy.register(makeRecord('cpt_fail', { createdAt: BASE_TIME, retentionClass: 'short' }));

    const result = await policy.prune();

    expect(result.deletedIds).toContain('cpt_ok');
    expect(result.failedIds).toContain('cpt_fail');
    expect(result.errors['cpt_fail']).toBeDefined();
  });

  it('does not throw when all deletions fail', async () => {
    const mock = new MockPruner();
    mock.failIds.add('cpt_a');
    mock.failIds.add('cpt_b');
    const now = BASE_TIME + 2 * 60 * 60 * 1000;
    const policy = new RetentionPolicy(
      { short: { maxAgeMs: 60 * 60 * 1000, maxCount: 999, maxSizeBytes: 999_999_999 } },
      () => now,
      mock,
    );

    policy.register(makeRecord('cpt_a', { createdAt: BASE_TIME, retentionClass: 'short' }));
    policy.register(makeRecord('cpt_b', { createdAt: BASE_TIME, retentionClass: 'short' }));

    await expect(policy.prune()).resolves.toBeDefined();
  });

  it('does not remove failed records from tracking', async () => {
    const mock = new MockPruner();
    mock.failIds.add('cpt_fail');
    const now = BASE_TIME + 2 * 60 * 60 * 1000;
    const policy = new RetentionPolicy(
      { short: { maxAgeMs: 60 * 60 * 1000, maxCount: 999, maxSizeBytes: 999_999_999 } },
      () => now,
      mock,
    );

    policy.register(makeRecord('cpt_fail', { createdAt: BASE_TIME, retentionClass: 'short' }));
    await policy.prune();

    // Failed record should still be tracked
    expect(policy.getRetainedCount().counts.short).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RetentionPolicy, config validation
// ---------------------------------------------------------------------------

describe('RetentionPolicy: config validation', () => {
  it('throws RangeError for negative maxAgeMs', () => {
    expect(
      () =>
        new RetentionPolicy({
          short: { maxAgeMs: -1, maxCount: 5, maxSizeBytes: 1000 },
        }),
    ).toThrow(RangeError);
  });

  it('throws RangeError for zero maxCount', () => {
    expect(
      () =>
        new RetentionPolicy({
          standard: { maxAgeMs: 1000, maxCount: 0, maxSizeBytes: 1000 },
        }),
    ).toThrow(RangeError);
  });

  it('throws RangeError for negative maxCount', () => {
    expect(
      () =>
        new RetentionPolicy({
          standard: { maxAgeMs: 1000, maxCount: -1, maxSizeBytes: 1000 },
        }),
    ).toThrow(RangeError);
  });

  it('throws RangeError for negative maxSizeBytes', () => {
    expect(
      () =>
        new RetentionPolicy({
          forensic: { maxAgeMs: 1000, maxCount: 5, maxSizeBytes: -1 },
        }),
    ).toThrow(RangeError);
  });

  it('accepts zero maxAgeMs (immediately expire everything)', () => {
    expect(
      () =>
        new RetentionPolicy({
          short: { maxAgeMs: 0, maxCount: 5, maxSizeBytes: 1000 },
        }),
    ).not.toThrow();
  });

  it('accepts valid positive config values', () => {
    expect(() => new RetentionPolicy()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// RetentionPolicy, injectable clock
// ---------------------------------------------------------------------------

describe('RetentionPolicy: injectable clock', () => {
  it('uses the injected clock to evaluate age', async () => {
    const mock = new MockPruner();
    let fakeNow = BASE_TIME;
    const policy = new RetentionPolicy(
      { standard: { maxAgeMs: 60 * 60 * 1000, maxCount: 999, maxSizeBytes: 999_999_999 } },
      () => fakeNow,
      mock,
    );

    policy.register(
      makeRecord('cpt_1', { createdAt: BASE_TIME, retentionClass: 'standard' }),
    );

    // At base time, record is 0ms old, should not be pruned
    await policy.prune();
    expect(mock.calls[0]!.candidates).toHaveLength(0);

    // Advance clock past maxAgeMs
    fakeNow = BASE_TIME + 2 * 60 * 60 * 1000;
    await policy.prune();
    expect(mock.calls[1]!.candidates.map((c) => c.id)).toContain('cpt_1');
  });
});

// ---------------------------------------------------------------------------
// SnapshotPruner, path validation
// ---------------------------------------------------------------------------

describe('SnapshotPruner: path validation', () => {
  const pruner = new SnapshotPruner();

  it('rejects empty string path', async () => {
    const rec = makeRecord('bad', { path: '' });
    const result = await pruner.delete([rec]);
    expect(result.failedIds).toContain('bad');
    expect(result.errors['bad']).toMatch(/empty/);
  });

  it('rejects relative paths', async () => {
    const rec = makeRecord('rel', { path: 'relative/path/file.json' });
    const result = await pruner.delete([rec]);
    expect(result.failedIds).toContain('rel');
    expect(result.errors['rel']).toMatch(/not absolute/);
  });

  it('rejects path traversal with leading ../', async () => {
    const rec = makeRecord('traversal', { path: '../etc/passwd' });
    const result = await pruner.delete([rec]);
    expect(result.failedIds).toContain('traversal');
    expect(result.errors['traversal']).toMatch(/traversal/);
  });

  it('rejects embedded path traversal (/foo/../../etc/passwd)', async () => {
    const rec = makeRecord('traversal2', { path: '/foo/../../etc/passwd' });
    const result = await pruner.delete([rec]);
    expect(result.failedIds).toContain('traversal2');
    expect(result.errors['traversal2']).toMatch(/traversal/);
  });

  it('accepts legitimate path containing double-dot in a directory name like v1..2', async () => {
    // We expect a validation pass (no traversal error), but the file won't exist,
    // so it will fail with an ENOENT fs error, that is correct behaviour.
    const rec = makeRecord('legit', { path: '/data/v1..2/checkpoint.json' });
    const result = await pruner.delete([rec]);
    // Should NOT be a traversal failure
    if (result.failedIds.includes('legit')) {
      expect(result.errors['legit']).not.toMatch(/traversal/);
    }
  });

  it('accepts a well-formed absolute path (validation passes, fails on ENOENT)', async () => {
    const rec = makeRecord('noexist', { path: '/tmp/__gv_test_nonexistent_file_xyz.json' });
    const result = await pruner.delete([rec]);
    // Should have a real fs error, not a validation error
    if (result.failedIds.includes('noexist')) {
      expect(result.errors['noexist']).not.toMatch(/traversal|not absolute|empty/);
    }
  });
});

// ---------------------------------------------------------------------------
// SnapshotPruner, dry-run semantics
// ---------------------------------------------------------------------------

describe('SnapshotPruner: dry-run semantics', () => {
  it('populates candidateIds and not deletedIds in dry-run mode', async () => {
    const pruner = new SnapshotPruner();
    const rec = makeRecord('cpt_dr', { path: '/tmp/__gv_test_dryrun.json' });
    const result = await pruner.delete([rec], { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.deletedIds).toHaveLength(0);
    expect(result.candidateIds).toContain('cpt_dr');
    expect(result.deletedCount).toBe(0);
    expect(result.reclaimedBytes).toBe(0);
  });

  it('dry-run result has candidateIds in per-class breakdown', async () => {
    const pruner = new SnapshotPruner();
    const rec = makeRecord('cpt_dr2', {
      path: '/tmp/__gv_test_dryrun2.json',
      retentionClass: 'short',
    });
    const result = await pruner.delete([rec], { dryRun: true });

    expect(result.byClass.short.candidateIds).toContain('cpt_dr2');
    expect(result.byClass.short.deletedIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// RetentionPolicy, injectable pruner
// ---------------------------------------------------------------------------

describe('RetentionPolicy: injectable pruner', () => {
  it('uses the injected pruner instead of default SnapshotPruner', async () => {
    const mock = new MockPruner();
    const policy = new RetentionPolicy(
      { standard: { maxAgeMs: 0, maxCount: 999, maxSizeBytes: 999_999_999 } },
      () => BASE_TIME + 1,
      mock,
    );

    policy.register(makeRecord('cpt_1', { createdAt: BASE_TIME, retentionClass: 'standard' }));
    await policy.prune();

    expect(mock.calls).toHaveLength(1);
  });

  it('constructs with default pruner when none injected (no error)', () => {
    expect(() => new RetentionPolicy()).not.toThrow();
  });
});
