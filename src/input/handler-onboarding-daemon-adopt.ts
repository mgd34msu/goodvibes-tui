/**
 * Friction fix: the onboarding wizard's "Connect to
 * this daemon now" action, wired from the Network step's `network.daemon-source`
 * = 'adopt' fields. Extracted from handler-onboarding.ts to keep that file
 * under the architecture line cap.
 */
import { join } from 'node:path';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { resolveDaemonCompanionToken } from '../runtime/operator-token-cleanup.ts';
import {
  buildManagedDaemonServiceManager,
  detectLegacyUnit,
  resolveInstalledDaemonBinary,
  runLegacyDaemonMigration,
  MANAGED_SERVICE_NAME,
} from '../runtime/legacy-daemon-migration.ts';
import type { InputHandlerLike as InputHandler } from './handler-types.ts';
import {
  formatRuntimeActiveSuccessMessage,
  getRuntimeEndpointStatus,
  isRuntimeEndpointActive,
  runtimePortDiagnostic,
} from './onboarding/onboarding-runtime-status.ts';

/**
 * Immediately (not deferred to the final wizard Apply):
 *   1. Installs the pasted token into <homeDirectory>/.goodvibes/daemon/operator-tokens.json
 *      via `resolveDaemonCompanionToken` — the same durable-persistence logic
 *      the `GOODVIBES_DAEMON_TOKEN` non-interactive override uses.
 *   2. Points `controlPlane.host`/`controlPlane.port` at the pasted host/port.
 *   3. Restarts the external-services controller and reports back, honestly,
 *      whether the daemon at that host/port was actually adopted — reusing
 *      the same `onboarding-runtime-status.ts` helpers the normal
 *      start-a-new-daemon path uses to report success/failure after Apply.
 *
 * Feedback is printed to the conversation feed (matching the existing
 * start-openai-subscription action's pattern) rather than stored as wizard
 * field state, because a 'status' field's value is recomputed fresh from the
 * step builder on every render and is not a place to durably stash an
 * out-of-band result.
 */
export async function handleConnectExistingDaemonForHandler(handler: InputHandler): Promise<void> {
  if (handler.onboardingApplyPending) return;
  const host = handler.onboardingWizard.getStringFieldValue('network.adopt-daemon-host', '127.0.0.1').trim() || '127.0.0.1';
  const port = handler.onboardingWizard.getPortFieldValue('network.adopt-daemon-port', 3421);
  const token = handler.onboardingWizard.getStringFieldValue('network.adopt-daemon-token', '').trim();
  if (token.length === 0) {
    handler.commandContext?.print?.('Connect to existing daemon: paste that daemon\'s token first.');
    return;
  }

  const externalServices = handler.uiServices.platform.externalServices;
  if (!externalServices) {
    handler.commandContext?.print?.('Connect to existing daemon: background service controller is unavailable in this build.');
    return;
  }

  handler.onboardingApplyPending = true;
  handler.requestRender();
  try {
    const daemonHomeDir = join(handler.uiServices.environment.homeDirectory, '.goodvibes', 'daemon');
    resolveDaemonCompanionToken(daemonHomeDir, token);
    handler.uiServices.platform.configManager.setDynamic('controlPlane.host', host);
    handler.uiServices.platform.configManager.setDynamic('controlPlane.port', port);

    const state = await externalServices.restart();
    const binding = { label: 'GoodVibes daemon', host, port };
    if (isRuntimeEndpointActive(state, 'daemon')) {
      handler.commandContext?.print?.([
        'Connect to existing daemon: succeeded.',
        `  ${formatRuntimeActiveSuccessMessage('daemon', state)}`,
        '  This host/port and token are applied now; Apply at the end of the wizard will persist them.',
      ].join('\n'));
    } else {
      const status = getRuntimeEndpointStatus(state, 'daemon');
      handler.commandContext?.print?.([
        'Connect to existing daemon: could not verify a connection.',
        `  ${runtimePortDiagnostic(binding, undefined, status)}`,
        '  Check the host, port, and token, then try again.',
      ].join('\n'));
    }
  } catch (error) {
    handler.commandContext?.print?.(`Connect to existing daemon failed: ${summarizeError(error)}`);
  } finally {
    handler.onboardingApplyPending = false;
    handler.requestRender();
  }
}

/**
 * The guided UX entry point for migrating a legacy
 * `goodvibes-daemon.service` unit (an earlier release shipped detect+disclose only; this
 * closes that inheritance). This is a thin wrapper over
 * `detectLegacyUnit` + `runLegacyDaemonMigration`
 * (`../runtime/legacy-daemon-migration.ts`) — the actual migration mechanics
 * (never auto-migrate, new-up-then-old-down with a health check before the
 * legacy unit is touched, adopt-or-warn for an unrecognized process on the
 * port) live there and are exercised against fakes in
 * `src/test/daemon/service-commands.test.ts`; this function only builds the
 * same `PlatformServiceManager` the daemon CLI's `migrate-service` subcommand
 * builds (via the shared `buildManagedDaemonServiceManager`, so a migration
 * triggered from either surface installs the identical unit) and prints the
 * honest result lines to the conversation feed, mirroring
 * `handleConnectExistingDaemonForHandler`'s pattern above.
 *
 * This lives in `src/input/` rather than importing
 * `../daemon/service-commands.ts` directly because the architecture gate's
 * `input-no-entrypoints` rule forbids `src/input/**` from depending on
 * `src/daemon/**` (input must stay a pure event-handling layer) — the shared
 * engine lives in the entrypoint-agnostic `src/runtime/` layer instead.
 *
 * `confirm` is caller-supplied rather than read from a fixed field name here
 * so this stays reusable from any surface: the onboarding wizard's Network
 * step (`onboarding-wizard-network-adopt.ts`'s `pushLegacyDaemonMigrationFields`,
 * dispatched from `handler-onboarding.ts`'s `migrate-legacy-daemon-service`
 * action) reads its own `network.migrate-legacy-daemon-confirm` checklist
 * toggle and passes it through as this parameter — unchecked previews the
 * dry-run plan (`confirm: false`), checked executes the real migration
 * (`confirm: true`).
 */
export async function handleMigrateLegacyDaemonServiceForHandler(handler: InputHandler, confirm: boolean): Promise<void> {
  if (handler.onboardingApplyPending) return;

  handler.onboardingApplyPending = true;
  handler.requestRender();
  try {
    const homeDirectory = handler.uiServices.environment.homeDirectory;
    const configManager = handler.uiServices.platform.configManager;
    const host = String(configManager.get('controlPlane.host') ?? '127.0.0.1');
    const port = Number(configManager.get('controlPlane.port') ?? 3421);
    const binaryPath = resolveInstalledDaemonBinary({ moduleUrl: import.meta.url });

    const manager = buildManagedDaemonServiceManager({ binaryPath, homeDir: homeDirectory, host, port });
    const legacy = detectLegacyUnit({ homeDir: homeDirectory });
    const result = await runLegacyDaemonMigration(
      { host, port, trackedServiceName: MANAGED_SERVICE_NAME, confirmMigration: confirm },
      manager,
      legacy,
    );
    handler.commandContext?.print?.(
      ['Migrate install-script daemon service:', ...result.lines.map((line: string) => `  ${line}`)].join('\n'),
    );
  } catch (error) {
    handler.commandContext?.print?.(`Migrate install-script daemon service failed: ${summarizeError(error)}`);
  } finally {
    handler.onboardingApplyPending = false;
    handler.requestRender();
  }
}
