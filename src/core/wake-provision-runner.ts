// ---------------------------------------------------------------------------
// wake-provision-runner.ts — what `/voice wake status` and `/voice wake setup` do.
//
// Provisioning the wake models is an EXPLICIT ACT and nothing else. There is no
// automatic download anywhere in this path: status only reads what is on disk
// (verifying by content, never by existence), and the download runs only when a
// user types the setup subcommand. That is the same posture the managed local
// voice runtime already has — an always-listening feature that fetched a
// classifier the moment it was switched on would be the opposite of it.
//
// Both SDK calls are injectable so a wire test drives the whole flow — a fresh
// host, a corrupt artifact, a failed component — with no network and no files.
// ---------------------------------------------------------------------------

import {
  provisionWakeWordModels,
  wakeProvisionStatus,
  type WakeProvisionProgress,
  type WakeProvisionResult,
  type WakeProvisionStatus,
  type WakeRuntimeSettings,
} from '@pellux/goodvibes-sdk/platform/voice';
import {
  WAKE_SETUP_ANNOUNCEMENT,
  wakeProvisionReceiptLines,
  wakeStatusLines,
} from './wake-provision-status.ts';

export interface WakeProvisionRunnerDeps {
  /** Managed root the wake tree hangs off; `<managedRoot>/wake` holds the artifacts. */
  readonly managedRoot: string;
  /** Already-resolved `voice.wake.*` rows, so the status block reports the live posture. */
  readonly settings: WakeRuntimeSettings;
  readonly print: (block: string) => void;
  /** Injected in tests; defaults to the SDK's content-verifying read. */
  readonly readStatus?: (managedRoot: string) => WakeProvisionStatus;
  /** Injected in tests; defaults to the SDK's checksum-pinned download. */
  readonly provision?: (
    managedRoot: string,
    onProgress: (progress: WakeProvisionProgress) => void,
  ) => Promise<WakeProvisionResult>;
}

/** Print the honest on-disk + configured posture. Reads only; never downloads. */
export function printWakeStatus(deps: WakeProvisionRunnerDeps): void {
  const read = deps.readStatus ?? ((managedRoot: string) => wakeProvisionStatus({ managedRoot }));
  deps.print(['Wake-Word Detection', ...wakeStatusLines(read(deps.managedRoot), deps.settings)].join('\n'));
}

/**
 * Run the provision, narrating each artifact as its phase advances, then print
 * the receipt. A component that fails is named in the receipt with its "got X,
 * want Y" reason rather than folded into an overall failure.
 */
export async function runWakeProvision(deps: WakeProvisionRunnerDeps): Promise<void> {
  const provision = deps.provision
    ?? ((managedRoot: string, onProgress: (progress: WakeProvisionProgress) => void) =>
      provisionWakeWordModels({ managedRoot, onProgress }));
  deps.print(WAKE_SETUP_ANNOUNCEMENT);
  // One line per phase CHANGE, so a slow download does not repeat itself.
  const lastPhase = new Map<string, string>();
  const onProgress = (progress: WakeProvisionProgress): void => {
    if (lastPhase.get(progress.component) === progress.phase) return;
    lastPhase.set(progress.component, progress.phase);
    const extra = progress.message !== undefined ? ` — ${progress.message}` : '';
    deps.print(`  ${progress.component}: ${progress.phase}${extra}`);
  };
  try {
    const result = await provision(deps.managedRoot, onProgress);
    deps.print(['Wake-Word Setup — receipt', ...wakeProvisionReceiptLines(result)].join('\n'));
  } catch (error) {
    deps.print(`Wake-Word Setup\n  provisioning failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
