// golden-frames-work-tree-neon.test.ts, the work-tree golden frames under
// goodvibes-neon (see golden-frames-work-tree.test.ts). Each test file runs in
// its own process, so the environment set here stays in this run.
//
// Update path:
//   GOODVIBES_UPDATE_GOLDENS=1 bun test src/test/renderer/golden-frames-work-tree-neon.test.ts

process.env['GOODVIBES_GOLDEN_THEME'] = 'goodvibes-neon';
await import('./golden-frames-work-tree.test.ts');

export {};
