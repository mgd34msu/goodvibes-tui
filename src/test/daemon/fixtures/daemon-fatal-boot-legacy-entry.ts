/**
 * daemon-fatal-boot-legacy-entry.ts — the fatal tail as it shipped, on purpose.
 *
 * The control for the compiled-binary disclosure test. This is the shape
 * `src/daemon/cli.ts` actually used through 1.27.0: report the failure to the
 * activity LOGGER, flush it, and exit. No file descriptor is ever written, and
 * the entrypoint never called `configureActivityLogger` at all, so the logger
 * it reports to has no destination either.
 *
 * Compiled and run, it produces zero bytes on stdout and zero bytes on stderr —
 * which is precisely what an operator saw for 77 crash-loops, and precisely
 * what a source-level test cannot observe.
 *
 * Its only job is to hold that baseline still, so the fixed entry's output is
 * measured against a real one rather than an assumption, and so anyone who
 * returns the fatal path to a log-only report fails a test instead of shipping
 * silence.
 */

import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { flushActivityLogSync, logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { resolveGoodVibesHomeOwnership } from '../../../config/goodvibes-home.ts';

async function main(): Promise<void> {
  const { homeDirectory } = resolveGoodVibesHomeOwnership();
  const workingDir = process.env['GOODVIBES_WORKING_DIR'] ?? process.cwd();
  // Deliberately no configureActivityLogger — the shipped daemon entrypoint had
  // none, which is the other half of why nothing was written anywhere.
  const config = new ConfigManager({ workingDir, homeDir: homeDirectory, surfaceRoot: 'tui' });
  process.stdout.write(`BOOTED controlPlane.port=${String(config.get('controlPlane.port'))}\n`);
  await Promise.resolve();
}

void main().catch(async (error) => {
  logger.error('goodvibes daemon host failed', {
    error: summarizeError(error),
  });
  flushActivityLogSync();
  process.exit(1);
});
