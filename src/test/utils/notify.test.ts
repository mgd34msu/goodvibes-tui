import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { notifyCompletion, escapeAppleScript } from '../../utils/notify.ts';

describe('escapeAppleScript', () => {
  test('escapes double quotes', () => {
    expect(escapeAppleScript('say "hello"')).toBe('say \\"hello\\"');
  });

  test('escapes backslashes', () => {
    expect(escapeAppleScript('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  test('escapes backslashes before quotes', () => {
    expect(escapeAppleScript('he said \\"hi\\"')).toBe('he said \\\\\\"hi\\\\\\"');
  });

  test('leaves safe strings unchanged', () => {
    expect(escapeAppleScript('hello world')).toBe('hello world');
  });

  test('handles empty string', () => {
    expect(escapeAppleScript('')).toBe('');
  });
});

describe('notifyCompletion', () => {
  let writeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  test('emits terminal bell when durationMs > 5000', () => {
    notifyCompletion('Title', 'Message', 5001);
    expect(writeSpy).toHaveBeenCalledWith('\x07');
  });

  test('emits terminal bell at exactly the threshold boundary (> not >=)', () => {
    notifyCompletion('Title', 'Message', 5000);
    expect(writeSpy).not.toHaveBeenCalledWith('\x07');
  });

  test('does not emit bell when durationMs <= 5000', () => {
    notifyCompletion('Title', 'Message', 4999);
    expect(writeSpy).not.toHaveBeenCalledWith('\x07');
  });

  test('does not emit bell when durationMs is 0', () => {
    notifyCompletion('Title', 'Message', 0);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test('does not throw when durationMs > 30000 (desktop notification path is non-fatal)', () => {
    // Desktop notification may fail in test env — must not throw
    expect(() => notifyCompletion('Title', 'Message', 30001)).not.toThrow();
  });

  test('emits bell for durations > 30000 as well', () => {
    notifyCompletion('Title', 'Message', 35000);
    expect(writeSpy).toHaveBeenCalledWith('\x07');
  });
});
