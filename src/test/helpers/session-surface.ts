/**
 * Test helper: build the same declare-once SessionSurface the runtime builds.
 *
 * Tests that touch session state should go through this rather than hand-
 * rolling paths, for the same reason production code does: a test that spells
 * its own scope can pass while the real reader and writer disagree.
 */
import { utimesSync } from 'node:fs';
import { createSessionSurface, type SessionSurface } from '@/runtime/index.ts';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../../config/surface.ts';

export function makeTestSurface(dir: string, homeDir: string = dir): SessionSurface {
  return createSessionSurface({
    surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
    workingDirectory: dir,
    homeDirectory: homeDir,
  });
}

/**
 * Stamp a recovery snapshot far enough in the past that the boot offer treats
 * it as an abandoned crash rather than as a file a live process is still
 * rewriting. The SDK skips any snapshot refreshed inside its live-refresh
 * window, so a test that needs a snapshot OFFERED has to age it first — a file
 * written this instant genuinely does look like live state, which is exactly
 * the rule that stops a still-running older build's snapshot being re-offered
 * forever. `msBefore` orders two aged snapshots against each other.
 */
export function ageRecoverySnapshot(path: string, msBefore = 0): void {
  const at = new Date(Date.now() - 600_000 - msBefore);
  utimesSync(path, at, at);
}
