#!/usr/bin/env bun
/**
 * generate-command-reference, regenerate docs/commands-reference.md from the
 * live slash-command registry. Run via `bun run docs:commands`. Every prebuild
 * and `bun run release:prepare` also rewrite it.
 */
import { join } from 'node:path';
import { syncCommandReference } from './project-surfaces.ts';
import { withWorkspaceLock } from './workspace-lock.ts';

withWorkspaceLock('sync command reference', () => {
  syncCommandReference(join(import.meta.dir, '..'));
});
