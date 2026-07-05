/**
 * operator-token-cleanup.ts
 *
 * Shared helper that enumerates the legacy workspace-scoped `operator-tokens.json`
 * locations the TUI has written at various pre-0.21.28 versions. Used by both the
 * in-process bootstrap path (`src/runtime/bootstrap.ts`) and the standalone daemon
 * CLI (`src/daemon/cli.ts`) so F3 (stale-token pruning) has a single source of
 * truth for where to look.
 *
 * Adding a new legacy location: append to `workspaceOperatorTokenCandidates` and
 * the new path will be inspected on the next daemon boot.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { getOrCreateCompanionToken } from '@pellux/goodvibes-sdk/platform/pairing';
import type { CompanionPairingResult } from '@pellux/goodvibes-sdk/platform/pairing';

/**
 * Return the list of absolute operator-tokens.json paths the TUI may have written
 * at legacy (pre-0.21.28) workspace-scoped locations under `workingDirectory`.
 *
 * The canonical, current-SDK location is `<daemonHomeDir>/operator-tokens.json`;
 * this helper is strictly for legacy-cleanup candidates.
 */
export function workspaceOperatorTokenCandidates(workingDirectory: string): readonly string[] {
  return [
    join(workingDirectory, '.goodvibes', 'operator-tokens.json'),
    join(workingDirectory, '.goodvibes', 'tui', 'operator-tokens.json'),
  ];
}

/**
 * F1 (adopt-an-already-running-external-daemon): resolve the operator/companion
 * token this TUI process uses to authenticate with its daemon, honoring
 * `GOODVIBES_DAEMON_TOKEN` as a non-interactive override.
 *
 * Without this override, the only way to make a TUI instance adopt an
 * already-running external daemon that used an out-of-band or explicit token
 * (rather than one derived from `getOrCreateCompanionToken` under a *shared*
 * home directory) was to hand-write `<daemonHomeDir>/operator-tokens.json`
 * before startup — there was no env var or CLI flag equivalent.
 *
 * `GOODVIBES_DAEMON_TOKEN` is already the documented env var `bin/goodvibes-daemon`
 * honors for its own bearer token (see `src/daemon/cli.ts`'s `readDaemonCliTokens`)
 * and the one `src/verification/live-verifier.ts`'s `readDaemonToken` already falls
 * back to when probing a daemon's HTTP surface from the outside. Reusing the same
 * name here means one env var configures both sides of an adopted-daemon setup —
 * start the daemon with `GOODVIBES_DAEMON_TOKEN=<token>` and point the TUI at it
 * with the same `GOODVIBES_DAEMON_TOKEN=<token>` plus
 * `--config controlPlane.host=<host> --config controlPlane.port=<port>` — instead
 * of introducing a second, TUI-only flag.
 *
 * When the override is set and does not already match the on-disk record, the
 * file is rewritten so the override becomes durable for this home directory
 * (an existing peerId is kept when present, so companion-pairing identity does
 * not needlessly churn). Falls back to the existing `getOrCreateCompanionToken`
 * behavior — read the existing file, or mint a fresh random token — when the
 * override is unset.
 *
 * @param explicitToken - Takes precedence over `GOODVIBES_DAEMON_TOKEN` when
 * provided. Used by the onboarding wizard's "connect to an existing daemon"
 * action (a pasted token) so it shares this exact persistence logic with the
 * env-var path instead of duplicating it.
 */
export function resolveDaemonCompanionToken(daemonHomeDir: string, explicitToken?: string): CompanionPairingResult {
  const override = explicitToken?.trim() || process.env.GOODVIBES_DAEMON_TOKEN?.trim();
  if (!override) return getOrCreateCompanionToken('tui', { daemonHomeDir });

  const tokenPath = join(daemonHomeDir, 'operator-tokens.json');
  let existingPeerId: string | undefined;
  let existingCreatedAt: number | undefined;
  if (existsSync(tokenPath)) {
    try {
      const record = JSON.parse(readFileSync(tokenPath, 'utf-8')) as {
        token?: unknown;
        peerId?: unknown;
        createdAt?: unknown;
      };
      if (typeof record.token === 'string' && record.token === override) {
        return {
          token: override,
          peerId: typeof record.peerId === 'string' ? record.peerId : randomBytes(12).toString('hex'),
          createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
        };
      }
      if (typeof record.peerId === 'string') existingPeerId = record.peerId;
      if (typeof record.createdAt === 'number') existingCreatedAt = record.createdAt;
    } catch {
      // Malformed on-disk record — fall through and rewrite it with the override.
    }
  }

  const record: CompanionPairingResult = {
    token: override,
    peerId: existingPeerId ?? randomBytes(12).toString('hex'),
    createdAt: existingCreatedAt ?? Date.now(),
  };
  try {
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, JSON.stringify(record, null, 2), { encoding: 'utf-8', mode: 0o600 });
    chmodSync(tokenPath, 0o600);
  } catch {
    // Best-effort persistence — the override still applies for this process
    // even if the file could not be written (e.g. a read-only home directory).
  }
  return record;
}
