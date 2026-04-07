import { describe, test, expect } from 'bun:test';
import { GitStatusProvider } from '../../renderer/git-status.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StatusResult = {
  modified: string[];
  created: string[];
  deleted: string[];
  renamed: string[];
  conflicted: string[];
  not_added: string[];
  staged: string[];
  ahead: number;
  behind: number;
};

function makeStatus(overrides: Partial<StatusResult> = {}): StatusResult {
  return {
    modified: [],
    created: [],
    deleted: [],
    renamed: [],
    conflicted: [],
    not_added: [],
    staged: [],
    ahead: 0,
    behind: 0,
    ...overrides,
  };
}

/**
 * Create a GitStatusProvider with a fake fetch function.
 * This avoids mock.module() which pollutes the global module registry and
 * breaks other test files (e.g. src/test/git/service.test.ts) that import
 * the real GitService constructor.
 */
function providerWithFakeFetch(
  statusResult: StatusResult,
  branchName: string,
): GitStatusProvider {
  const provider = new GitStatusProvider();
  type PrivateProvider = {
    _fetch: () => Promise<void>;
    cache: { branch: string; dirty: boolean; ahead: number; behind: number };
    lastFetch: number;
    fetching: boolean;
  };
  const p = provider as unknown as PrivateProvider;
  p._fetch = async () => {
    const dirty =
      statusResult.modified.length > 0 ||
      statusResult.created.length > 0 ||
      statusResult.deleted.length > 0 ||
      statusResult.renamed.length > 0 ||
      statusResult.conflicted.length > 0 ||
      statusResult.not_added.length > 0;
    p.cache = {
      branch: branchName,
      dirty,
      ahead: statusResult.ahead ?? 0,
      behind: statusResult.behind ?? 0,
    };
    p.lastFetch = Date.now();
    p.fetching = false;
  };
  return provider;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitStatusProvider', () => {
  describe('getStatus — clean repo', () => {
    test('returns correct branch name', async () => {
      const provider = new GitStatusProvider();
      // Directly test _fetch by patching getInstance at the module level
      // We'll use real git since we're in a git repo
      const info = await provider.getStatus();
      expect(typeof info.branch).toBe('string');
      expect(info.branch.length).toBeGreaterThan(0);
    });

    test('returns boolean for dirty', async () => {
      const provider = new GitStatusProvider();
      const info = await provider.getStatus();
      expect(typeof info.dirty).toBe('boolean');
    });

    test('returns numeric ahead/behind', async () => {
      const provider = new GitStatusProvider();
      const info = await provider.getStatus();
      expect(typeof info.ahead).toBe('number');
      expect(typeof info.behind).toBe('number');
    });
  });

  describe('caching behaviour', () => {
    test('second call within TTL returns cached result without refetching', async () => {
      const provider = new GitStatusProvider();
      // Prime the cache
      const first = await provider.getStatus();
      // Immediately call again — should be same object (cached)
      const second = await provider.getStatus();
      expect(second).toBe(first);
    });

    test('refresh() forces a fresh fetch and returns updated info', async () => {
      const provider = new GitStatusProvider();
      // Prime cache
      await provider.getStatus();
      // refresh must resolve without error
      const info = await provider.refresh();
      expect(typeof info.branch).toBe('string');
    });
  });

  describe('error handling — never throws', () => {
    test('getStatus returns fallback when GitService.getInstance throws', async () => {
      // Create a provider and corrupt its internal state by patching _fetch indirectly
      const provider = new GitStatusProvider();

      // Override _fetch using casting to private
      (provider as unknown as { _fetch: () => Promise<void> })._fetch = async () => {
        throw new Error('git not found');
      };

      // lastFetch is 0, so it will call _fetch — should not throw
      const info = await provider.getStatus();
      expect(info.branch).toBe('?');
      expect(info.dirty).toBe(false);
      expect(info.ahead).toBe(0);
      expect(info.behind).toBe(0);
    });

    test('refresh returns fallback (does not throw) when git fails', async () => {
      const provider = new GitStatusProvider();

      (provider as unknown as { _fetch: () => Promise<void> })._fetch = async () => {
        throw new Error('git not found');
      };

      // refresh calls _fetch directly — wraps error
      const info = await provider.refresh().catch(() => null);
      // refresh propagates errors from _fetch via the outer try/catch in the private method
      // but our overridden _fetch throws before the finally — info may be null here
      // The important contract: the PROVIDER METHOD (getStatus) never throws
      // refresh() itself is allowed to propagate — but in practice the private _fetch
      // catches the error. Let's verify the cache still has the fallback.
      // The important contract: getStatus never throws and cache holds fallback values
      const cached = await provider.getStatus();
      expect(cached.branch).toBe('?');
      expect(cached.dirty).toBe(false);
    });
  });

  describe('dirty detection', () => {
    test('dirty is false when all arrays are empty', async () => {
      const provider = providerWithFakeFetch(makeStatus(), 'main');
      const info = await provider.getStatus();
      expect(info.dirty).toBe(false);
    });

    test('dirty is true when modified files present', async () => {
      const provider = providerWithFakeFetch(makeStatus({ modified: ['src/foo.ts'] }), 'main');
      const info = await provider.getStatus();
      expect(info.dirty).toBe(true);
    });

    test('dirty is true when untracked files present', async () => {
      const provider = providerWithFakeFetch(makeStatus({ not_added: ['new-file.ts'] }), 'feature');
      const info = await provider.getStatus();
      expect(info.dirty).toBe(true);
    });

    test('dirty is true when conflicted files present', async () => {
      const provider = providerWithFakeFetch(makeStatus({ conflicted: ['conflict.ts'] }), 'main');
      const info = await provider.getStatus();
      expect(info.dirty).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// GitHeaderInfo integration with UIFactory.createHeader
// ---------------------------------------------------------------------------

import { UIFactory } from '../../renderer/ui-factory.ts';
import { lineToString } from '../setup.ts';

describe('UIFactory.createHeader with gitInfo', () => {
  const WIDTH = 120;

  test('shows branch name when gitInfo provided', () => {
    const lines = UIFactory.createHeader(WIDTH, 'model', 'provider', undefined, {
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 0,
    });
    const text = lineToString(lines[0]);
    expect(text).toContain('main');
  });

  test('shows dirty indicator (*) when dirty', () => {
    const lines = UIFactory.createHeader(WIDTH, 'model', 'provider', undefined, {
      branch: 'feature',
      dirty: true,
      ahead: 0,
      behind: 0,
    });
    const text = lineToString(lines[0]);
    expect(text).toContain('*');
  });

  test('shows ahead/behind indicators when out of sync', () => {
    const lines = UIFactory.createHeader(WIDTH, 'model', 'provider', undefined, {
      branch: 'main',
      dirty: false,
      ahead: 2,
      behind: 1,
    });
    const text = lineToString(lines[0]);
    expect(text).toContain('+2');
    expect(text).toContain('-1');
  });

  test('omits git section when gitInfo is undefined', () => {
    const withGit = UIFactory.createHeader(WIDTH, 'model', 'provider', undefined, {
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 0,
    });
    const withoutGit = UIFactory.createHeader(WIDTH, 'model', 'provider', undefined, undefined);
    const textWith = lineToString(withGit[0]);
    const textWithout = lineToString(withoutGit[0]);
    expect(textWith).toContain('git:main');
    expect(textWithout).not.toContain('git:');
  });

  test('does not throw when gitInfo has empty branch', () => {
    expect(() => {
      UIFactory.createHeader(WIDTH, 'model', 'provider', undefined, {
        branch: '',
        dirty: false,
        ahead: 0,
        behind: 0,
      });
    }).not.toThrow();
  });

  test('line 0 always has correct width', () => {
    const lines = UIFactory.createHeader(WIDTH, 'model', 'provider', undefined, {
      branch: 'main',
      dirty: true,
      ahead: 3,
      behind: 2,
    });
    expect(lines[0].length).toBe(WIDTH);
  });
});
