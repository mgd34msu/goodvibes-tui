/**
 * F1 (One-Platform Wave 2 friction fix): the onboarding wizard's "Connect to
 * this daemon now" action, wired from the Network step's `network.daemon-source`
 * = 'adopt' fields. Extracted from handler-onboarding.ts to keep that file
 * under the architecture line cap.
 */
import { join } from 'node:path';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { resolveDaemonCompanionToken } from '../runtime/operator-token-cleanup.ts';
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
