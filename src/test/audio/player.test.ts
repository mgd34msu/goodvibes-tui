// Deliberately per-repo test, byte-identical to the sibling product's copy by design: the module it exercises is this repo's own and has diverged from the sibling's, so the two copies prove different code and neither can stand in for the other.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveStreamingAudioPlayerCommand } from '../../audio/player.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('streaming audio player discovery', () => {
  test('prefers mpv over ffplay', () => {
    const binDir = makeProjectTempDir('goodvibes-audio');
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
    const binDir = makeProjectTempDir('goodvibes-audio');
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
