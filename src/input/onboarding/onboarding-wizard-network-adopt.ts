/**
 * F1 (One-Platform Wave 2 friction fix): the Network step's daemon-source choice
 * — start a new daemon owned by this TUI (default) vs connect to one that is
 * already running elsewhere with a known token. Extracted from
 * onboarding-wizard-steps.ts to keep that file under the architecture line cap.
 */
import { legacyUnitNote, MANAGED_SERVICE_NAME } from '../../runtime/legacy-daemon-migration.ts';
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

/**
 * W4-D1: the guided, visible entry point for migrating a detected legacy
 * `goodvibes-daemon.service` unit — closes the fast-follow-up flagged when
 * `handleMigrateLegacyDaemonServiceForHandler` (handler-onboarding-daemon-adopt.ts)
 * shipped fully built but not wired to any onboarding control. Independent of
 * the daemon-source radio above: this offers to retire an old unmanaged unit
 * regardless of whether the wizard is set to start a new daemon or adopt an
 * existing one.
 *
 * Visible ONLY when the runtime snapshot's read-only `legacyDaemon` detection
 * (collected via `detectLegacyUnit`, see `../../runtime/legacy-daemon-migration.ts`)
 * found a unit file present — never rendered speculatively. Confirm-gated on
 * top of the engine's own consent requirement: a checklist toggle must be
 * checked before the action executes the real migration (`confirmMigration:
 * true`); left unchecked, pressing the action still works but only prints the
 * engine's dry-run plan (`confirmMigration: false`) — see
 * `runLegacyDaemonMigration`'s honest dry-run branch. The action label and
 * hint change to make which mode is armed unambiguous before it is pressed.
 */
export function pushLegacyDaemonMigrationFields(
  fields: OnboardingWizardFieldDefinition[],
  controller: OnboardingWizardControllerLike,
): void {
  const legacy = controller.runtimeSnapshot?.legacyDaemon;
  if (!legacy || !legacy.present) return;

  fields.push({
    kind: 'status',
    id: 'network.migrate-legacy-daemon-detected',
    label: 'Legacy daemon service detected',
    // F2 follow-up: name the unit this host actually resolves (carried on the
    // snapshot from `resolveConfiguredServiceName` at collection time) — the
    // MANAGED_SERVICE_NAME fallback only covers snapshots built without it.
    hint: legacyUnitNote(legacy, legacy.trackedServiceName ?? MANAGED_SERVICE_NAME),
    defaultValue: legacy.active ? 'Installed and running' : 'Installed (not active)',
  });

  const confirmFieldId = 'network.migrate-legacy-daemon-confirm';
  const confirmed = controller.getBooleanFieldValue(confirmFieldId, false);
  fields.push({
    kind: 'checklist',
    id: confirmFieldId,
    label: 'Confirm migration execution',
    hint: 'When checked, the action below performs the real migration: install and start the new managed service, verify it comes up healthy, and only then stop, disable, and remove the legacy unit. Leave unchecked to preview the plan without changing anything.',
    defaultValue: false,
  });
  fields.push({
    kind: 'action',
    id: 'network.migrate-legacy-daemon',
    label: confirmed ? 'Migrate legacy daemon service now' : 'Preview migration plan',
    hint: confirmed
      ? 'Executes the migration now: new-up-then-old-down, never touching the legacy unit until the new one is verified healthy. Result prints to the feed below.'
      : 'Prints the migration plan without changing anything. Check "Confirm migration execution" above to arm the real migration.',
    action: 'migrate-legacy-daemon-service',
    defaultValue: confirmed ? 'Migrate' : 'Preview',
  });
}
