/**
 * Test helper: build the same declare-once SessionSurface the runtime builds.
 *
 * Tests that touch session state should go through this rather than hand-
 * rolling paths, for the same reason production code does: a test that spells
 * its own scope can pass while the real reader and writer disagree.
 */
import { createSessionSurface, type SessionSurface } from '@/runtime/index.ts';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../../config/surface.ts';

export function makeTestSurface(dir: string, homeDir: string = dir): SessionSurface {
  return createSessionSurface({
    surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
    workingDirectory: dir,
    homeDirectory: homeDir,
  });
}
