/**
 * install-self-check-startup.ts — the boot-time surfacing of the install
 * self-check (install-self-check.ts). Called once from the runtime bootstrap,
 * it wires the real host inputs (process exec path, the packaged root, the
 * real daemon resolution, and existsSync) into the pure evaluator and prints
 * any findings through the same SystemMessageRouter the rest of startup uses.
 *
 * It is intentionally cheap (existsSync-level, no network) and non-fatal:
 * every failure is swallowed so a self-check can never block or crash boot.
 * Each finding is printed as one high-priority system message ending in the
 * exact repair command for the detected install kind.
 *
 * This module lives in the runtime layer and imports the daemon resolver from
 * the cli layer; nothing in cli imports it back, so no import cycle forms.
 */

import { existsSync } from 'node:fs';
import { getGoodVibesPackageRoot, resolveGoodVibesDaemonExecutable } from '../cli/service-posture.ts';
import { runInstallSelfCheck } from './install-self-check.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';

export function announceInstallSelfCheck(router: SystemMessageRouter): void {
  try {
    const findings = runInstallSelfCheck({
      execPath: process.execPath,
      packageRoot: getGoodVibesPackageRoot(),
      daemon: resolveGoodVibesDaemonExecutable(),
      fileExists: existsSync,
    });
    for (const finding of findings) {
      router.high(`[Install] ${finding.summary} ${finding.detail} Repair: ${finding.repairCommand}`);
    }
  } catch {
    // Best-effort — an install self-check must never block or crash boot.
  }
}
