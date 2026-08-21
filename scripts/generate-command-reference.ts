#!/usr/bin/env bun
/**
 * generate-command-reference, regenerate docs/commands-reference.md from the
 * live slash-command registry. Run via `bun run docs:commands`. The drift check
 * (src/test/release-gates/command-reference-gate.test.ts) fails CI if the
 * committed file is stale, so re-run this after adding or editing a command.
 */
import { join } from 'node:path';
import { syncCommandReference } from './project-surfaces.ts';
import { withWorkspaceLock } from './workspace-lock.ts';

withWorkspaceLock('sync command reference', () => {
  syncCommandReference(join(import.meta.dir, '..'));
});
