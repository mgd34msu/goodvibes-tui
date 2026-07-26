/**
 * run-daemon-config-migration.ts — the one call every TUI composition root
 * makes before constructing its `ConfigManager`.
 *
 * Daemon-owned configuration now has exactly one home:
 * `~/.goodvibes/daemon/settings.json`. Before this migration, every product
 * wrote every key (including daemon-only ones like `surfaces.telegram.*`)
 * into its own per-surface silo, and the daemon only ever read
 * `~/.goodvibes/tui/settings.json` — so a value written by, say, the agent
 * surface reported a successful save and configured nothing the daemon could
 * see.
 *
 * `migrateDaemonOwnedConfig` (SDK, `platform/config`) is idempotent and cheap
 * on the fast path (one file read + JSON parse), so it is safe and correct to
 * call this at every composition root that is about to construct a
 * `ConfigManager` — not just the first one to run in a given process. It
 * must never abort startup: any failure is caught, logged with the marker
 * path so the failure is diagnosable, and startup continues on whatever
 * config state already exists.
 */
import {
  migrateDaemonOwnedConfig,
  daemonConfigPath,
  daemonConfigMovedPath,
  type DaemonConfigMigrationResult,
} from '@pellux/goodvibes-sdk/platform/config';
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

/**
 * Run the daemon-owned-config migration for `homeDir`, tolerating any
 * failure. Returns the migration result on success, or `null` when the
 * migration itself threw (logged as a warning naming the marker path;
 * startup proceeds either way).
 */
export function runDaemonConfigMigration(homeDir: string): DaemonConfigMigrationResult | null {
  try {
    return migrateDaemonOwnedConfig({ homeDir, primarySurface: 'tui' });
  } catch (error) {
    const markerPath = daemonConfigMovedPath(daemonConfigPath(homeDir));
    logger.warn('daemon-owned config migration failed; continuing with existing config state', {
      markerPath,
      error: summarizeError(error),
    });
    return null;
  }
}
