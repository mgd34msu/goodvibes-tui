import { describe, expect, test } from 'bun:test';
import { installFullScreenTerminalOutputGuard } from '@pellux/goodvibes-terminal-shell';

// item 1a: direct terminal writes that would corrupt the TUI are captured
// and counted (surfaced by /debug), NOT pushed as repeated transcript lines.
describe('TUI terminal-output guard counter (1a)', () => {
  test('captured writes increment a cumulative counter and are suppressed from the stream', () => {
    const written: string[] = [];
    const fakeStdout = { write: (s: string | Uint8Array) => { written.push(String(s)); return true; } };
    const captures: number[] = [];

    const guard = installFullScreenTerminalOutputGuard({
      stdout: fakeStdout as never,
      stderr: fakeStdout as never,
      active: true,
      onCapture: (total) => { captures.push(total); },
    });
    try {
      // After install, fakeStdout.write is the guard wrapper: a direct write is
      // intercepted (never reaches the real stream) and bumps the counter.
      (fakeStdout.write as (s: string) => boolean)('rogue direct stdout line\n');
      expect(captures).toEqual([1]);       // counter surfaced via onCapture
      expect(written).toEqual([]);         // suppressed — not written through
    } finally {
      guard.dispose();
    }
  });
});
