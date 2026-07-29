/**
 * credential-composition.ts
 *
 * The credential and identity seam: the secret store, the step-up ceremony
 * service that verifies against it, and the per-device pairing tokens.
 *
 * These are grouped because they share one fact, and it is the fact this round
 * had to fix: WHERE the daemon's own credentials live. `daemonHome` is threaded
 * rather than defaulted, because without it a daemon told to run out of a temp
 * tree moved its identity directory and nothing else — the credential store
 * stayed in the real home, so an "isolated" test daemon held live credentials
 * and long-polled a real account. A default here would silently restore that.
 *
 * Extracted from services.ts because that file sits at the 800-line
 * architecture cap. Moving a coherent seam out is what the cap is for; trimming
 * unrelated comments to buy headroom is the thing it exists to prevent.
 */

import { SecretsManager } from '../config/secrets.ts';
import { StepUpService } from '@pellux/goodvibes-sdk/daemon';
import { PairingTokenManager } from '@pellux/goodvibes-sdk/platform/pairing';

interface CredentialCompositionInput {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /**
   * The daemon's state root when the host was told one. Absent means "not
   * overridden" and must stay absent rather than being defaulted — see above.
   */
  readonly daemonHomeDirectory?: string | undefined;
  readonly configManager: ConstructorParameters<typeof SecretsManager>[0]['configManager'];
  readonly pairingTokenPath: string;
}

export function composeCredentialServices(input: CredentialCompositionInput): {
  readonly secretsManager: SecretsManager;
  readonly stepUpService: StepUpService;
  readonly pairingTokens: PairingTokenManager;
} {
  const secretsManager = new SecretsManager({
    projectRoot: input.workingDirectory,
    globalHome: input.homeDirectory,
    // Threaded, not defaulted: else an isolated daemon reads the real store.
    ...(input.daemonHomeDirectory === undefined ? {} : { daemonHome: input.daemonHomeDirectory }),
    configManager: input.configManager,
  });
  return {
    secretsManager,
    // Shared between the ceremony gateway verbs and the relay gate's verifier,
    // so both check a step-up against the same store.
    stepUpService: new StepUpService({ secrets: secretsManager }),
    pairingTokens: new PairingTokenManager(input.pairingTokenPath),
  };
}
