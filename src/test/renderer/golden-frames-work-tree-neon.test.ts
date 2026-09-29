// golden-frames-work-tree-neon.test.ts, the work-tree golden frames
// under goodvibes-neon (see golden-frames-work-tree.test.ts).
//
// A single `bun test` run evaluates every test file in ONE process: this
// file's environment variable and the active theme it selects would otherwise
// reach every file that runs after it. Both are put back when its tests end.
//
// Update path:
//   GOODVIBES_UPDATE_GOLDENS=1 bun test src/test/renderer/golden-frames-work-tree-neon.test.ts

import { afterAll } from 'bun:test';
import { activeThemeMode, getActiveThemeName, setActiveThemeMode, setActiveThemeName } from '../../renderer/theme.ts';

const previousTheme = process.env['GOODVIBES_GOLDEN_THEME'];
const previousName = getActiveThemeName();
const previousMode = activeThemeMode();
afterAll(() => {
  if (previousTheme === undefined) delete process.env['GOODVIBES_GOLDEN_THEME'];
  else process.env['GOODVIBES_GOLDEN_THEME'] = previousTheme;
  setActiveThemeName(previousName);
  setActiveThemeMode(previousMode);
});

process.env['GOODVIBES_GOLDEN_THEME'] = 'goodvibes-neon';
await import('./golden-frames-work-tree.test.ts');

export {};
