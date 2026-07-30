// ---------------------------------------------------------------------------
// provision-wake-model.ts — `goodvibes-daemon provision-wake-model`.
//
// WHAT THIS IS FOR
//
// The curl installer needs to put the wake-word model on the machine, and it must
// not hold the pinned URLs, byte counts or checksums to do it. Those live in ONE
// place — the SDK's wake-word manifest — and a shell script that copied them
// would be a second copy of a pin, drifting silently the first time the model is
// retrained. So the installer runs the binary it just installed and lets the SDK
// do what the SDK owns.
//
// IT EXITS 0 EVEN WHEN THE DOWNLOAD FAILS, ON PURPOSE
//
// The caller is an installer. A wake-word model is not a reason to fail installing
// a coding tool, and an installer that aborts half-way through is worse than one
// that finishes without a wake word. The outcome is printed either way — one plain
// line naming what happened and how to retry — and a running daemon retries at
// every boot. `--strict` is there for a caller that genuinely wants the exit code
// to carry the result (a test, a provisioning script that is checking); the
// installer does not pass it.
//
// It composes NOTHING. No runtime, no config manager, no gateway: this reads a
// home directory, derives the managed voice root the same way the running daemon
// does, and calls one SDK function. Composing a runtime here would start a second
// set of pollers on a machine whose daemon is probably already running.
// ---------------------------------------------------------------------------

import {
  provisionWakeWordModelsAtInstall,
  resolveManagedVoiceRoot,
} from '@pellux/goodvibes-sdk/platform/voice';

export interface ProvisionWakeModelResult {
  readonly exitCode: number;
  readonly lines: readonly string[];
}

export interface ProvisionWakeModelDeps {
  /** The home directory whose `.goodvibes/voice` tree receives the artifacts. */
  readonly homeDirectory: string;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Injected in tests: the SDK policy, so nothing downloads. */
  readonly provisionAtInstall?: typeof provisionWakeWordModelsAtInstall | undefined;
}

/**
 * Run the install-time provision and report it.
 *
 * `--strict` makes a degraded outcome exit 1. Without it, every outcome exits 0,
 * because the caller is an installer and the alternative is an aborted install
 * over an optional model.
 */
export async function runProvisionWakeModelCommand(
  argv: readonly string[],
  deps: ProvisionWakeModelDeps,
): Promise<ProvisionWakeModelResult> {
  const strict = argv.includes('--strict');
  const provision = deps.provisionAtInstall ?? provisionWakeWordModelsAtInstall;
  let managedRoot: string;
  try {
    managedRoot = resolveManagedVoiceRoot(deps.homeDirectory);
  } catch (error) {
    // A home directory this process cannot make sense of is still not a reason to
    // fail an install, so it is reported on the same terms as a failed download.
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: strict ? 1 : 0,
      lines: [`wake-word model: skipped — ${message}`],
    };
  }
  const outcome = await provision({
    managedRoot,
    recoveryHint: '/voice wake setup',
    ...(deps.env !== undefined ? { env: deps.env } : {}),
  });
  return {
    exitCode: strict && outcome.state === 'degraded' ? 1 : 0,
    lines: [`wake-word model: ${outcome.message}`],
  };
}
