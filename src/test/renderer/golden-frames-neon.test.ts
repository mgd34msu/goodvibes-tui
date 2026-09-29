// ---------------------------------------------------------------------------
// golden-frames-neon.test.ts, the golden surfaces under goodvibes-neon.
//
// goodvibes-neon is the pre-2026-09 look (formerly the `vaporwave` theme). It
// runs every surface of golden-frames.test.ts against the committed set in
// golden-frames-goodvibes-neon/, so the neon theme cannot drift unnoticed.
// A single `bun test` run evaluates every test file in ONE process, so the
// environment variable and active theme set here are put back when this
// file's tests end rather than reaching the files that run after it.
//
// Update path:
//   GOODVIBES_UPDATE_GOLDENS=1 bun test src/test/renderer/golden-frames-neon.test.ts
// ---------------------------------------------------------------------------

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
await import('./golden-frames.test.ts');

export {};
