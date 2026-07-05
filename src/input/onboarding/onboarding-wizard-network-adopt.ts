/**
 * F1 (One-Platform Wave 2 friction fix): the Network step's daemon-source choice
 * — start a new daemon owned by this TUI (default) vs connect to one that is
 * already running elsewhere with a known token. Extracted from
 * onboarding-wizard-steps.ts to keep that file under the architecture line cap.
 */
import { normalizeText } from './onboarding-wizard-helpers.ts';
import type { OnboardingWizardControllerLike } from './onboarding-wizard-types.ts';
import type { OnboardingWizardFieldDefinition } from './onboarding-wizard-types.ts';

export const DAEMON_SOURCE_FIELD_ID = 'network.daemon-source';

/** Current daemon-source selection ('start' default, or 'adopt'). */
export function getDaemonSource(controller: OnboardingWizardControllerLike): string {
  return controller.getStringFieldValue(DAEMON_SOURCE_FIELD_ID, 'start');
}

/**
 * Push the daemon-source radio, plus the host/port/token/connect fields when
 * 'adopt' is selected, onto the Network step's field list. Independent of the
 * local/custom network mode — adopting someone else's daemon is a client-side
 * choice about which daemon THIS TUI talks to, not about how THIS TUI's own
 * daemon binds to the network.
 */
export function pushDaemonAdoptionFields(
  fields: OnboardingWizardFieldDefinition[],
  controller: OnboardingWizardControllerLike,
  daemonSource: string,
  bindSettings: { readonly controlPlane: { readonly host?: string | undefined; readonly port?: number | undefined } } | undefined,
): void {
  fields.push({
    kind: 'radio',
    id: DAEMON_SOURCE_FIELD_ID,
    label: 'GoodVibes daemon source',
    hint: 'Start a new daemon owned by this TUI (default), or connect to one that is already running elsewhere with a known token.',
    options: [
      { id: 'start', label: 'Start a new daemon', hint: 'This TUI starts and owns its own daemon (default).' },
      { id: 'adopt', label: 'Connect to an existing running daemon', hint: 'Point this TUI at a daemon someone already started, using its host, port, and token.' },
    ],
    defaultValue: 'start',
  });
  if (daemonSource !== 'adopt') return;
  fields.push(
    {
      kind: 'text',
      id: 'network.adopt-daemon-host',
      label: 'Existing daemon host',
      hint: 'Host or IP address of the already-running GoodVibes daemon.',
      placeholder: '127.0.0.1',
      defaultValue: controller.getStringFieldValue('network.adopt-daemon-host', normalizeText(bindSettings?.controlPlane.host) || '127.0.0.1'),
    },
    {
      kind: 'text',
      id: 'network.adopt-daemon-port',
      label: 'Existing daemon port',
      hint: 'Port the already-running GoodVibes daemon is bound to.',
      placeholder: '3421',
      defaultValue: controller.getStringFieldValue('network.adopt-daemon-port', String(bindSettings?.controlPlane.port ?? 3421)),
    },
    {
      kind: 'masked',
      id: 'network.adopt-daemon-token',
      label: 'Existing daemon token',
      hint: "Bearer token that daemon was started with. Connecting writes it into this home directory's operator-tokens.json so this TUI authenticates as that daemon instead of minting its own.",
      placeholder: 'gv_...',
      defaultValue: controller.getStringFieldValue('network.adopt-daemon-token', ''),
    },
    {
      kind: 'action',
      id: 'network.adopt-daemon-connect',
      label: 'Connect to this daemon now',
      hint: 'Apply the host/port above, install the token, and verify the connection immediately (before Apply at the end of the wizard). Result prints to the feed below.',
      action: 'connect-existing-daemon',
      defaultValue: 'Connect',
    },
  );
}
