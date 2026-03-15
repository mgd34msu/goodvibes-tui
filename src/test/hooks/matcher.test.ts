import { describe, test, expect } from 'bun:test';
import { matchesEventPath, matchesMatcher } from '../../hooks/matcher.ts';

describe('matchesEventPath', () => {
  describe('exact matching', () => {
    test('exact path matches itself', () => {
      expect(matchesEventPath('Pre:tool:read', 'Pre:tool:read')).toBe(true);
    });

    test('different phase does not match', () => {
      expect(matchesEventPath('Pre:tool:read', 'Post:tool:read')).toBe(false);
    });

    test('different category does not match', () => {
      expect(matchesEventPath('Pre:tool:read', 'Pre:file:read')).toBe(false);
    });

    test('different specific does not match', () => {
      expect(matchesEventPath('Pre:tool:read', 'Pre:tool:write')).toBe(false);
    });
  });

  describe('wildcard in specific segment', () => {
    test('Pre:tool:* matches Pre:tool:read', () => {
      expect(matchesEventPath('Pre:tool:*', 'Pre:tool:read')).toBe(true);
    });

    test('Pre:tool:* matches Pre:tool:exec', () => {
      expect(matchesEventPath('Pre:tool:*', 'Pre:tool:exec')).toBe(true);
    });

    test('Pre:tool:* does not match Post:tool:read', () => {
      expect(matchesEventPath('Pre:tool:*', 'Post:tool:read')).toBe(false);
    });

    test('Pre:tool:* does not match Pre:file:read', () => {
      expect(matchesEventPath('Pre:tool:*', 'Pre:file:read')).toBe(false);
    });
  });

  describe('wildcard in category segment', () => {
    test('Pre:*:read matches Pre:tool:read', () => {
      expect(matchesEventPath('Pre:*:read', 'Pre:tool:read')).toBe(true);
    });

    test('Pre:*:read matches Pre:file:read', () => {
      expect(matchesEventPath('Pre:*:read', 'Pre:file:read')).toBe(true);
    });

    test('Pre:*:read does not match Pre:tool:write', () => {
      expect(matchesEventPath('Pre:*:read', 'Pre:tool:write')).toBe(false);
    });
  });

  describe('wildcard in phase segment', () => {
    test('*:git:commit matches Pre:git:commit', () => {
      expect(matchesEventPath('*:git:commit', 'Pre:git:commit')).toBe(true);
    });

    test('*:git:commit matches Post:git:commit', () => {
      expect(matchesEventPath('*:git:commit', 'Post:git:commit')).toBe(true);
    });

    test('*:git:commit does not match Pre:tool:commit', () => {
      expect(matchesEventPath('*:git:commit', 'Pre:tool:commit')).toBe(false);
    });
  });

  describe('all wildcards', () => {
    test('*:*:* matches any event path', () => {
      expect(matchesEventPath('*:*:*', 'Pre:tool:read')).toBe(true);
      expect(matchesEventPath('*:*:*', 'Post:file:write')).toBe(true);
      expect(matchesEventPath('*:*:*', 'Fail:agent:start')).toBe(true);
    });
  });

  describe('all phases', () => {
    test('Post:tool:* matches Post events', () => {
      expect(matchesEventPath('Post:tool:*', 'Post:tool:read')).toBe(true);
    });

    test('Fail:tool:* matches Fail events', () => {
      expect(matchesEventPath('Fail:tool:*', 'Fail:tool:exec')).toBe(true);
    });

    test('Change:config:* matches Change events', () => {
      expect(matchesEventPath('Change:config:*', 'Change:config:update')).toBe(true);
    });

    test('Lifecycle:session:* matches Lifecycle events', () => {
      expect(matchesEventPath('Lifecycle:session:*', 'Lifecycle:session:start')).toBe(true);
    });
  });

  describe('edge cases', () => {
    test('pattern with wrong number of parts returns false', () => {
      expect(matchesEventPath('Pre:tool', 'Pre:tool:read')).toBe(false);
    });

    test('empty strings do not match', () => {
      expect(matchesEventPath('', 'Pre:tool:read')).toBe(false);
    });

    test('event path with extra colons still matches on first 3 segments', () => {
      // Pre:tool:read:extra should match Pre:tool:* treating "read:extra" as specific
      expect(matchesEventPath('Pre:tool:*', 'Pre:tool:read:extra')).toBe(true);
    });
  });
});

describe('matchesMatcher', () => {
  test('undefined matcher always returns true', () => {
    expect(matchesMatcher(undefined, 'anything')).toBe(true);
    expect(matchesMatcher(undefined, '')).toBe(true);
  });

  test('exact matcher matches exact value', () => {
    expect(matchesMatcher('file_read', 'file_read')).toBe(true);
  });

  test('exact matcher does not match different value', () => {
    expect(matchesMatcher('file_read', 'file_write')).toBe(false);
  });

  test('empty string matcher matches empty string', () => {
    expect(matchesMatcher('', '')).toBe(true);
  });

  test('empty string matcher does not match non-empty', () => {
    expect(matchesMatcher('', 'something')).toBe(false);
  });
});
