import { describe, expect, test } from 'bun:test';
import {
  allowTerminalWrite,
  installTerminalOutputGuard,
  type TerminalOutputIntercept,
} from '@pellux/goodvibes-terminal-shell/terminal-output-guard';

function makeStream() {
  const writes: string[] = [];
  return {
    writes,
    write: (...args: unknown[]) => {
      writes.push(String(args[0] ?? ''));
      const maybeCallback = args[args.length - 1];
      if (typeof maybeCallback === 'function') {
        maybeCallback(null);
      }
      return true;
    },
  };
}

describe('terminal output guard', () => {
  test('captures direct stdout, stderr, and console writes while active', () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const captured: TerminalOutputIntercept[] = [];
    const guard = installTerminalOutputGuard({
      stdout,
      stderr,
      active: true,
      onIntercept: (event) => captured.push(event),
    });

    try {
      stdout.write('raw stdout\n');
      stderr.write('raw stderr\n');
      console.error('console %s', 'error');

      expect(stdout.writes).toEqual([]);
      expect(stderr.writes).toEqual([]);
      expect(captured.map((event) => event.source)).toEqual([
        'stdout',
        'stderr',
        'console.error',
      ]);
      expect(captured[2]?.preview).toBe('console error');
    } finally {
      guard.dispose();
    }
  });

  test('allows compositor-owned writes through allowTerminalWrite', () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const captured: TerminalOutputIntercept[] = [];
    const guard = installTerminalOutputGuard({
      stdout,
      stderr,
      active: true,
      onIntercept: (event) => captured.push(event),
    });

    try {
      allowTerminalWrite(() => stdout.write('render diff'));

      expect(stdout.writes).toEqual(['render diff']);
      expect(captured).toEqual([]);
    } finally {
      guard.dispose();
    }
  });

  test('passes writes through after being deactivated', () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const captured: TerminalOutputIntercept[] = [];
    const guard = installTerminalOutputGuard({
      stdout,
      stderr,
      active: true,
      onIntercept: (event) => captured.push(event),
    });

    try {
      guard.setActive(false);
      stdout.write('normal stdout');
      stderr.write('normal stderr');

      expect(stdout.writes).toEqual(['normal stdout']);
      expect(stderr.writes).toEqual(['normal stderr']);
      expect(captured).toEqual([]);
    } finally {
      guard.dispose();
    }
  });
});
