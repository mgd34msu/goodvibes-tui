import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStreamingAudioPlayerCommand } from '../../audio/player.ts';

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('streaming audio player discovery', () => {
  test('prefers mpv over ffplay', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'goodvibes-audio-'));
    cleanupPaths.push(binDir);
    const mpv = join(binDir, 'mpv');
    const ffplay = join(binDir, 'ffplay');
    writeFileSync(mpv, '#!/bin/sh\n');
    writeFileSync(ffplay, '#!/bin/sh\n');
    chmodSync(mpv, 0o755);
    chmodSync(ffplay, 0o755);

    const command = resolveStreamingAudioPlayerCommand({ PATH: binDir });

    expect(command?.label).toBe('mpv');
    expect(command?.command).toBe(mpv);
  });

  test('falls back to ffplay when mpv is not present', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'goodvibes-audio-'));
    cleanupPaths.push(binDir);
    const ffplay = join(binDir, 'ffplay');
    writeFileSync(ffplay, '#!/bin/sh\n');
    chmodSync(ffplay, 0o755);

    const command = resolveStreamingAudioPlayerCommand({ PATH: binDir });

    expect(command?.label).toBe('ffplay');
    expect(command?.command).toBe(ffplay);
  });

  test('reports unavailable when no streaming player is on PATH', () => {
    expect(resolveStreamingAudioPlayerCommand({ PATH: '' })).toBeNull();
  });
});
