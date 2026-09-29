// golden-frames-session-views-neon.test.ts, the session view golden frames
// under goodvibes-neon (see golden-frames-session-views.test.ts). Each test
// file runs in its own process, so the environment set here stays in this run.
//
// Update path:
//   GOODVIBES_UPDATE_GOLDENS=1 bun test src/test/renderer/golden-frames-session-views-neon.test.ts

process.env['GOODVIBES_GOLDEN_THEME'] = 'goodvibes-neon';
await import('./golden-frames-session-views.test.ts');

export {};
