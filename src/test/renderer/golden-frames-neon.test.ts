// ---------------------------------------------------------------------------
// golden-frames-neon.test.ts, the golden surfaces under goodvibes-neon.
//
// goodvibes-neon is the pre-2026-09 look (formerly the `vaporwave` theme). It
// runs every surface of golden-frames.test.ts against the committed set in
// golden-frames-goodvibes-neon/, so the neon theme cannot drift unnoticed.
// The test runner gives each test file its own process, so the environment
// set here never reaches golden-frames.test.ts's own run.
//
// Update path:
//   GOODVIBES_UPDATE_GOLDENS=1 bun test src/test/renderer/golden-frames-neon.test.ts
// ---------------------------------------------------------------------------

process.env['GOODVIBES_GOLDEN_THEME'] = 'goodvibes-neon';
await import('./golden-frames.test.ts');

export {};
