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
 * As a pure client it does not. The reference belongs with the daemon (the key
 * is daemon-owned) and so does the value, or the daemon resolves the reference
 * and finds nothing — the mailbox password that reports saved and never polls,
 * the card that is not there at purchase time.
 *
 * ── Why this is ONE verb and not two writes from here ─────────────────────
 *
 * `credentials.set` takes the CONFIG KEY — `surfaces.telegram.botToken`, not
 * `GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN` — and does the whole sequence itself,
 * in an order this client could not enforce from the outside:
 *
 *   1. derive the secret-store name from the config path (one derivation,
 *      platform-wide, so a client cannot name it differently);
 *   2. write the value at the scope the ownership rules resolve;
 *   3. read it BACK and compare;
 *   4. only then replace the config value with its reference.
 *
 * If step 3 does not match, the config is left exactly as it was and the call
 * fails. A config key pointing at a reference that resolves to nothing is worse
 * than a key that was never written: every reader treats it as a
 * configured-but-broken credential and the surface that wrote it was told it
 * succeeded. Splitting this into a `config.set` plus a secret write from here
 * would reintroduce exactly that window.
 *
 * The verb also refuses a key that is not a credential-bearing setting, with a
 * message naming `config.set` as the right call — so a mistake here is a
 * refusal, not a config value quietly replaced by a reference nobody can read.
 *
 * ── What never comes back ─────────────────────────────────────────────────
 *
 * The value. Not on success, not in an error, not in a log line. The response
 * names the config key, the store key, the scope and the reference — everything
 * needed to verify the write and nothing that repeats the credential.
 *
 * ── No silent local fallback ──────────────────────────────────────────────
 *
 * With no reachable daemon a daemon-owned credential write REJECTS, and the
 * caller (the settings modal, `/payments card`, the onboarding wizard) renders
 * the refusal. Writing it locally instead produces the split pair this module
 * exists to prevent.
 */
import type { DaemonVerbCaller } from './operator-endpoint.ts';

/** What the daemon reports back about a credential write. Never the value. */
export interface CredentialWriteReceipt {
  readonly key?: string;
  readonly secretKey?: string;
  readonly scope?: string;
  readonly reference?: string;
}

export interface DaemonCredentialsClient {
  /**
   * Store a credential for a daemon-owned config key. The daemon writes the
   * secret, verifies it reads back, and only then points the config key at it.
   */
  set(configKey: string, value: string): Promise<CredentialWriteReceipt>;
  /** Clear a credential and the config reference that pointed at it. */
  clear(configKey: string): Promise<void>;
}

export function createDaemonCredentialsClient(verbs: DaemonVerbCaller): DaemonCredentialsClient {
  const requireDaemon = (configKey: string): void => {
    const probe = verbs.probe();
    if (!probe.available) {
      throw new Error(`'${configKey}' is a credential the daemon uses and ${probe.reason}`);
    }
  };

  return {
    set: async (configKey, value) => {
      requireDaemon(configKey);
      return await verbs.invoke<CredentialWriteReceipt>('credentials.set', { key: configKey, value });
    },
    clear: async (configKey) => {
      requireDaemon(configKey);
      await verbs.invoke('credentials.delete', { key: configKey });
    },
  };
}
