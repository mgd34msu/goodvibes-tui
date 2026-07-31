/**
 * config-client.ts — reading and writing the settings the DAEMON owns.
 *
 * ── The split, and why it is not "all config goes over the wire" ───────────
 *
 * A config key belongs to the runtime that ACTS on it (the SDK's
 * config-ownership.ts is the authority, and this module never keeps a second
 * copy of its lists). Two scopes matter here:
 *
 * - DAEMON-OWNED (`surfaces.*`, `controlPlane.*`, `watchers.*`, `device.*`,
 *   `automation.*`, `atRest.*`, `payments.*`, `voice.local.*`, …). The daemon
 *   executes these unattended. When the terminal app hosted the daemon, writing
 *   them to this surface's own settings file happened to work. It does not
 *   anymore: a Telegram bot token saved here would land in
 *   `~/.goodvibes/tui/settings.json`, the daemon would never read it, and the
 *   save would report success while configuring nothing. These go over
 *   `config.set` and come back over `config.get` / `settings.snapshot`.
 *
 * - SURFACE-OWNED (rendering, theme, transcript display, keybindings, and the
 *   `daemon.*` / `service.*` switches that say whether THIS installation runs a
 *   daemon at all). These stay local, in this surface's own file, read and
 *   written by the in-process ConfigManager exactly as before. Sending them to
 *   the daemon would make one machine's theme everyone's theme.
 *
 * ── Degrading honestly ─────────────────────────────────────────────────────
 *
 * With no reachable daemon a daemon-owned WRITE fails, loudly, with the
 * refusal reason — it does not fall back to writing the local file. A silent
 * local write is the exact failure this split exists to end: it looks like it
 * worked and changes nothing. A daemon-owned READ falls back to the local
 * value, because a stale-but-real number renders better than a blank field and
 * reads were always allowed to be optimistic.
 */
import { isDaemonOwnedConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { DaemonVerbCaller } from './operator-endpoint.ts';

/** Re-exported so call sites classify a key through one import, not two. */
export { isDaemonOwnedConfigKey };

export interface DaemonConfigClient {
  /** True when this key's value lives in the daemon's own settings tier. */
  ownsKey(key: string): boolean;
  /**
   * Write a daemon-owned key. Rejects (never falls back to a local write) when
   * no daemon is reachable — a write that configures nothing must not report
   * success.
   */
  set(key: string, value: unknown): Promise<void>;
  /** Read a daemon-owned key; `undefined` when the daemon could not answer. */
  get(key: string): Promise<unknown>;
  /** The daemon's whole resolved config snapshot, for a settings view that opens cold. */
  snapshot(): Promise<Record<string, unknown> | null>;
}

/**
 * Walk a dotted config path through a nested snapshot.
 *
 * `config.get` returns the whole RESOLVED config tree — it takes no key. That
 * is the right shape for the daemon (one read answers a settings view) and the
 * wrong shape for a single-key read, so the walk happens here rather than in
 * every caller that wanted one value.
 */
function readDottedPath(snapshot: Record<string, unknown> | null, key: string): unknown {
  let cursor: unknown = snapshot;
  for (const segment of key.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export function createDaemonConfigClient(verbs: DaemonVerbCaller): DaemonConfigClient {
  return {
    ownsKey: (key) => isDaemonOwnedConfigKey(key),

    set: async (key, value) => {
      const probe = verbs.probe();
      if (!probe.available) {
        throw new Error(`'${key}' is a daemon-owned setting and ${probe.reason}`);
      }
      // The route takes a body envelope, not a flat pair.
      await verbs.invoke('config.set', { key, value });
    },

    get: async (key) => {
      try {
        // `config.get` takes no key: it answers with the whole resolved tree.
        const snapshot = await verbs.invoke<Record<string, unknown>>('config.get', {});
        return readDottedPath(snapshot ?? null, key);
      } catch (error) {
        logger.debug('[config] reading a daemon-owned key failed; showing the local value', {
          key,
          error: summarizeError(error),
        });
        return undefined;
      }
    },

    snapshot: async () => {
      try {
        return await verbs.invoke<Record<string, unknown>>('config.get', {}) ?? null;
      } catch (error) {
        logger.debug('[config] the daemon config snapshot was not available', { error: summarizeError(error) });
        return null;
      }
    },
  };
}
