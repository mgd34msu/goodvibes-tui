/**
 * credentials-client.ts — writing a credential the DAEMON will use.
 *
 * ── The pair that must not split ───────────────────────────────────────────
 *
 * A secret-backed setting is two writes that only work together: the config key
 * gets a `goodvibes://secrets/...` REFERENCE, and the secret store gets the
 * VALUE that reference points at. When the terminal app hosted the daemon, both
 * halves landed in one process's tree and the pair held.
 *
 * As a pure client it does not. The reference now goes to the daemon over
 * `config.set` (config-client.ts) because the key is daemon-owned; the value
 * has to follow it, or the daemon resolves the reference and finds nothing —
 * the mailbox password that reports saved and never polls, the card that is not
 * there at purchase time. `credentials.set` / `credentials.delete` are the
 * verbs that carry the value to the same place the reference went.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 *
 * Only DAEMON-scoped writes come here. A `user`-scoped secret (an API key this
 * terminal's own provider calls use) stays in this surface's own secret store —
 * it is this process that spends it, and sending it to the daemon would put a
 * credential somewhere it is not needed. `defaultSecretBackedScope` in
 * config/secret-config.ts already makes exactly that call from the key's
 * ownership, so this store honours the scope it is handed rather than
 * second-guessing it.
 *
 * ── No silent local fallback ───────────────────────────────────────────────
 *
 * With no reachable daemon a daemon-scoped write REJECTS. Writing it locally
 * instead would produce the split pair this module exists to prevent, and the
 * caller (the settings modal, `/payments card`, the onboarding wizard) renders
 * the refusal so the user knows the credential is not stored anywhere.
 */
import type { SecretScope, SecretStorageMedium } from '../../config/secrets.ts';
import type { SecretBackedSecretStore } from '../../config/secret-config.ts';
import type { DaemonVerbCaller } from './operator-endpoint.ts';

export interface SecretWriteOptions {
  readonly scope?: SecretScope;
  readonly medium?: SecretStorageMedium;
}

/**
 * A secret store that routes DAEMON-scoped writes to the daemon's own
 * credential verbs and leaves every other scope with the local store.
 */
export function createSplitScopeSecretStore(deps: {
  readonly local: SecretBackedSecretStore;
  readonly verbs: DaemonVerbCaller;
}): SecretBackedSecretStore {
  const isDaemonScoped = (options?: SecretWriteOptions): boolean => options?.scope === 'daemon';

  const requireDaemon = (key: string): void => {
    const probe = deps.verbs.probe();
    if (!probe.available) {
      throw new Error(`'${key}' is a credential the daemon uses and ${probe.reason}`);
    }
  };

  return {
    set: async (key, value, options) => {
      if (!isDaemonScoped(options)) {
        await deps.local.set(key, value, options);
        return;
      }
      requireDaemon(key);
      await deps.verbs.invoke('credentials.set', {
        key,
        value,
        scope: 'daemon',
        ...(options?.medium === undefined ? {} : { medium: options.medium }),
      });
    },

    delete: async (key, options) => {
      if (!isDaemonScoped(options)) {
        await deps.local.delete?.(key, options);
        return;
      }
      requireDaemon(key);
      await deps.verbs.invoke('credentials.delete', {
        key,
        scope: 'daemon',
        ...(options?.medium === undefined ? {} : { medium: options.medium }),
      });
    },
  };
}
