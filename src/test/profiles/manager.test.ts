import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileManager } from '../../profiles/manager.ts';

describe('ProfileManager', () => {
  let dir: string;
  let pm: ProfileManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gv-pm-test-'));
    pm = new ProfileManager(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('save/load round-trip', () => {
    it('saves and reloads display settings', () => {
      pm.save('test', {
        display: { stream: false, lineNumbers: true, collapseThreshold: 50, theme: 'dark', showThinking: false, showReasoningSummary: false },
      });
      const { data } = pm.load('test');
      expect(data.display?.stream).toBe(false);
      expect(data.display?.lineNumbers).toBe(true);
      expect(data.display?.theme).toBe('dark');
    });

    it('saves and reloads behavior settings', () => {
      pm.save('b-test', {
        behavior: { autoApprove: true, autoCompactThreshold: 90, saveHistory: false },
      });
      const { data } = pm.load('b-test');
      expect(data.behavior?.autoApprove).toBe(true);
      expect(data.behavior?.autoCompactThreshold).toBe(90);
    });

    it('saves and reloads provider settings', () => {
      pm.save('p-test', {
        provider: { model: 'gpt-5', reasoningEffort: 'high' },
      });
      const { data } = pm.load('p-test');
      expect(data.provider?.model).toBe('gpt-5');
      expect(data.provider?.reasoningEffort).toBe('high');
    });

    it('preserves timestamp', () => {
      const before = Date.now();
      pm.save('ts-test', {});
      const { timestamp } = pm.load('ts-test');
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('list', () => {
    it('returns empty array when no profiles', () => {
      expect(pm.list()).toEqual([]);
    });

    it('returns all saved profiles sorted by timestamp descending', () => {
      pm.save('alpha', {});
      pm.save('beta', {});
      const list = pm.list();
      expect(list.length).toBe(2);
      // Most recent first — beta was saved after alpha
      expect(list[0].name).toBe('beta');
      expect(list[1].name).toBe('alpha');
    });

    it('includes name, timestamp, and filePath', () => {
      pm.save('myprofile', {});
      const list = pm.list();
      expect(list[0].name).toBe('myprofile');
      expect(list[0].timestamp).toBeGreaterThan(0);
      expect(list[0].filePath).toContain('myprofile.json');
    });
  });

  describe('delete', () => {
    it('deletes an existing profile and returns true', () => {
      pm.save('to-delete', {});
      const result = pm.delete('to-delete');
      expect(result).toBe(true);
      expect(pm.list()).toEqual([]);
    });

    it('returns false when profile does not exist', () => {
      expect(pm.delete('nonexistent')).toBe(false);
    });

    it('deleted profile is not loadable', () => {
      pm.save('gone', {});
      pm.delete('gone');
      expect(() => pm.load('gone')).toThrow('Profile not found');
    });
  });

  describe('sanitizeName', () => {
    it('lowercases and replaces spaces with dashes', () => {
      expect(pm.sanitizeName('My Profile')).toBe('my-profile');
    });

    it('strips special characters', () => {
      expect(pm.sanitizeName('test!@#$')).toBe('test');
    });

    it('collapses consecutive dashes', () => {
      expect(pm.sanitizeName('foo---bar')).toBe('foo-bar');
    });

    it('falls back to profile for empty result', () => {
      expect(pm.sanitizeName('!!!!')).toBe('profile');
    });
  });

  describe('error cases', () => {
    it('throws on empty name for save', () => {
      expect(() => pm.save('', {})).toThrow('Profile name cannot be empty');
    });

    it('throws on empty name for load', () => {
      expect(() => pm.load('')).toThrow('Profile name cannot be empty');
    });

    it('throws on not-found profile for load', () => {
      expect(() => pm.load('ghost')).toThrow('Profile not found: ghost');
    });
  });
});
