/**
 * daemon-fatal-boot-entry.ts — the daemon's boot-and-fail path, compilable.
 *
 * This exists to be built with `bun build --compile` and RUN, because the
 * defect it guards is invisible to a source-level test: the released 1.27.0
 * daemon binary died on this path with zero bytes on stdout and zero bytes on
 * stderr, while the identical source run under `bun` printed the reason.
 *
 * It imports the REAL home resolution (`resolveGoodVibesHomeOwnership`), the
 * REAL `ConfigManager` whose daemon-tier read is what throws, and the REAL
 * `reportFatalBootFailure`, and it mirrors `src/daemon/cli.ts`'s tail exactly.
 * Nothing about the failure path is re-implemented here; if this entry stays
 * silent, so does the daemon.
 *
 * Why not compile `src/daemon/cli.ts` itself: that build only RUNS after
 * `scripts/prebuild.ts` has rewritten `node_modules/css-tree/lib/data-patch.js`
 * into a form `bun build --compile` can bundle. On a fresh checkout — which is
 * what the CI test job has — the compiled entrypoint dies at module init with
 * `Cannot find module '../data/patch.json'`, from a dependency of jsdom, before
 * a single line of daemon code runs. Measured both ways. A test that mutates
 * node_modules to make itself possible is worse than this fixture, which
 * exercises the same three real modules with none of that reach.
 */

import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { configureActivityLogger } from '@pellux/goodvibes-sdk/platform/utils';
import { resolveGoodVibesHomeOwnership } from '../../../config/goodvibes-home.ts';
import { reportFatalBootFailure } from '../../../cli/fatal-boot-report.ts';

async function main(): Promise<void> {
  const { homeDirectory } = resolveGoodVibesHomeOwnership();
  const workingDir = process.env['GOODVIBES_WORKING_DIR'] ?? process.cwd();
  configureActivityLogger(join(workingDir, '.goodvibes', 'logs'));
  // The construction that throws on an unreadable daemon tier — the exact call
  // src/daemon/cli.ts makes, with the same surfaceRoot.
  const config = new ConfigManager({ workingDir, homeDir: homeDirectory, surfaceRoot: 'tui' });
  process.stdout.write(`BOOTED controlPlane.port=${String(config.get('controlPlane.port'))}\n`);
  await Promise.resolve();
}

void main().catch((error) => {
  reportFatalBootFailure(error);
  process.exit(1);
});
