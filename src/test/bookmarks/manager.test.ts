import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BookmarkManager } from '../../bookmarks/manager.ts';

describe('BookmarkManager', () => {
  let dir: string;
  let bm: BookmarkManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gv-bm-test-'));
    bm = new BookmarkManager(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('toggle', () => {
    it('adds a bookmark and returns true', () => {
      const result = bm.toggle('msg_1', 'code block');
      expect(result).toBe(true);
      expect(bm.isBookmarked('msg_1')).toBe(true);
    });

    it('removes an existing bookmark and returns false', () => {
      bm.toggle('msg_1', 'code block');
      const result = bm.toggle('msg_1');
      expect(result).toBe(false);
      expect(bm.isBookmarked('msg_1')).toBe(false);
    });

    it('uses key as label when no label provided', () => {
      bm.toggle('msg_2');
      const entries = bm.list();
      expect(entries[0].label).toBe('msg_2');
    });
  });

  describe('isBookmarked', () => {
    it('returns false for unknown keys', () => {
      expect(bm.isBookmarked('nonexistent')).toBe(false);
    });

    it('returns true after toggle on', () => {
      bm.toggle('x', 'label');
      expect(bm.isBookmarked('x')).toBe(true);
    });
  });

  describe('list', () => {
    it('returns entries sorted by timestamp ascending', () => {
      bm.toggle('a', 'first');
      bm.toggle('b', 'second');
      const list = bm.list();
      expect(list.length).toBe(2);
      expect(list[0].key).toBe('a');
      expect(list[1].key).toBe('b');
    });

    it('returns empty array when no bookmarks', () => {
      expect(bm.list()).toEqual([]);
    });
  });

  describe('saveToFile', () => {
    it('writes content to disk and returns path', () => {
      const path = bm.saveToFile('hello world', 'my label');
      expect(path).toContain(dir);
      expect(path).toEndWith('.txt');
      const content = require('node:fs').readFileSync(path, 'utf-8');
      expect(content).toBe('hello world');
    });

    it('sanitizes the label in the filename', () => {
      const path = bm.saveToFile('data', 'My Label: With Spaces!');
      expect(path).toContain('my-label-with-spaces');
    });
  });

  describe('loadSavedFile', () => {
    it('reads back saved content', () => {
      const content = 'test content here';
      const path = bm.saveToFile(content, 'testfile');
      const filename = require('node:path').basename(path);
      const loaded = bm.loadSavedFile(filename);
      expect(loaded).toBe(content);
    });

    it('returns null for nonexistent file', () => {
      const result = bm.loadSavedFile('does-not-exist.txt');
      expect(result).toBeNull();
    });

    it('appends .txt extension automatically', () => {
      const content = 'auto ext test';
      const path = bm.saveToFile(content, 'autoext');
      const filename = require('node:path').basename(path, '.txt');
      const loaded = bm.loadSavedFile(filename);
      expect(loaded).toBe(content);
    });

    it('blocks path traversal attempts', () => {
      expect(() => bm.loadSavedFile('../etc/passwd')).toThrow('Invalid bookmark name');
    });

    it('blocks nested traversal', () => {
      expect(() => bm.loadSavedFile('../../secret')).toThrow('Invalid bookmark name');
    });
  });
});
