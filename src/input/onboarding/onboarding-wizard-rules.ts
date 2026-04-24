import type { OnboardingStep1CapabilityId } from '../../runtime/onboarding/index.ts';
import { INBOUND_EXTERNAL_SURFACE_IDS, REQUIRED_EXTERNAL_SETUP_FIELD_IDS } from './onboarding-wizard-constants.ts';
import { EXTERNAL_SURFACE_SPECS } from './onboarding-wizard-external-surfaces.ts';
import { getExternalSurfaceSpecByFieldId, normalizeText, uniqueNonEmpty } from './onboarding-wizard-helpers.ts';
import type { OnboardingWizardController } from './onboarding-wizard.ts';

export function getSharedIpDefault(
  controller: OnboardingWizardController,
    enabled: { readonly controlPlane: boolean; readonly httpListener: boolean; readonly web: boolean },
  ): boolean {
    if (!controller.runtimeSnapshot) return true;
    const hosts = uniqueNonEmpty([
      enabled.controlPlane ? controller.runtimeSnapshot.bindSettings.controlPlane.host : '',
      enabled.httpListener ? controller.runtimeSnapshot.bindSettings.httpListener.host : '',
      enabled.web ? controller.runtimeSnapshot.bindSettings.web.host : '',
    ]);
    return hosts.length <= 1;
  }

export function getSharedIpHostDefault(
  controller: OnboardingWizardController,
    enabled: { readonly controlPlane: boolean; readonly httpListener: boolean; readonly web: boolean },
  ): string {
    if (!controller.runtimeSnapshot) return '0.0.0.0';
    const hosts = uniqueNonEmpty([
      enabled.controlPlane ? controller.runtimeSnapshot.bindSettings.controlPlane.host : '',
      enabled.httpListener ? controller.runtimeSnapshot.bindSettings.httpListener.host : '',
      enabled.web ? controller.runtimeSnapshot.bindSettings.web.host : '',
    ]);
    return hosts[0] ?? '0.0.0.0';
  }

export function toggleCapability(controller: OnboardingWizardController, capabilityId: OnboardingStep1CapabilityId): void {
    if (capabilityId === 'local-tui-only') {
      for (const capability of controller.getCurrentCapabilities()) {
        controller.toggleState.set(`capabilities.${capability.id}`, capability.id === 'local-tui-only');
      }
      return;
    }

    const fieldId = `capabilities.${capabilityId}`;
    const nextValue = !(controller.toggleState.get(fieldId) ?? false);
    controller.toggleState.set(fieldId, nextValue);
    if (nextValue) {
      controller.toggleState.set('capabilities.local-tui-only', false);
      return;
    }

    const anyServerCapability = controller.getCurrentCapabilities().some((capability) => (
      capability.id !== 'local-tui-only'
      && (controller.toggleState.get(`capabilities.${capability.id}`) ?? false)
    ));
    if (!anyServerCapability) controller.toggleState.set('capabilities.local-tui-only', true);
  }

export function selectAllServerCapabilities(controller: OnboardingWizardController): void {
    for (const capability of controller.getCurrentCapabilities()) {
      controller.toggleState.set(`capabilities.${capability.id}`, capability.id !== 'local-tui-only');
    }
  }

export function selectLocalTuiOnly(controller: OnboardingWizardController): void {
    for (const capability of controller.getCurrentCapabilities()) {
      controller.toggleState.set(`capabilities.${capability.id}`, capability.id === 'local-tui-only');
    }
  }

export function selectAllExternalSurfaces(controller: OnboardingWizardController): void {
    for (const surface of EXTERNAL_SURFACE_SPECS) {
      controller.toggleState.set(surface.enabledFieldId, true);
    }
  }

export function clearExternalSurfaces(controller: OnboardingWizardController): void {
    for (const surface of EXTERNAL_SURFACE_SPECS) {
      controller.toggleState.set(surface.enabledFieldId, false);
    }
  }

export function setCapabilityValue(controller: OnboardingWizardController, capabilityId: OnboardingStep1CapabilityId, selected: boolean): void {
    if (capabilityId === 'local-tui-only') {
      if (selected) {
        for (const capability of controller.getCurrentCapabilities()) {
          controller.toggleState.set(`capabilities.${capability.id}`, capability.id === 'local-tui-only');
        }
        return;
      }

      const anyServerCapability = controller.getCurrentCapabilities().some((capability) => (
        capability.id !== 'local-tui-only'
        && (controller.toggleState.get(`capabilities.${capability.id}`) ?? false)
      ));
      controller.toggleState.set('capabilities.local-tui-only', !anyServerCapability);
      return;
    }

    controller.toggleState.set(`capabilities.${capabilityId}`, selected);
    if (selected) {
      controller.toggleState.set('capabilities.local-tui-only', false);
      return;
    }

    const anyServerCapability = controller.getCurrentCapabilities().some((capability) => (
      capability.id !== 'local-tui-only'
      && (controller.toggleState.get(`capabilities.${capability.id}`) ?? false)
    ));
    if (!anyServerCapability) controller.toggleState.set('capabilities.local-tui-only', true);
  }

export function isCapabilitySelected(controller: OnboardingWizardController, capabilityId: OnboardingStep1CapabilityId): boolean {
    return controller.getCapabilitySelectionState().some((capability) => capability.id === capabilityId && capability.selected);
  }

export function hasServerCapabilitiesSelected(controller: OnboardingWizardController): boolean {
    return controller.getCapabilitySelectionState().some((capability) => capability.id !== 'local-tui-only' && capability.selected);
  }

export function shouldEnableBrowserSurface(controller: OnboardingWizardController): boolean {
    return controller.hasServerCapabilitiesSelected()
      && (controller.isCapabilitySelected('browser-access') || controller.isCapabilitySelected('network-access'));
  }

export function hasSelectedInboundExternalSurface(controller: OnboardingWizardController): boolean {
    if (!controller.isCapabilitySelected('external-integrations')) return false;
    return EXTERNAL_SURFACE_SPECS.some((surface) => (
      INBOUND_EXTERNAL_SURFACE_IDS.has(surface.id)
      && controller.getBooleanFieldValue(surface.enabledFieldId, surface.defaultEnabled(controller.runtimeSnapshot))
    ));
  }

export function isRequiredExternalSetupField(controller: OnboardingWizardController, fieldId: string): boolean {
    if (!REQUIRED_EXTERNAL_SETUP_FIELD_IDS.has(fieldId)) return false;
    const surface = getExternalSurfaceSpecByFieldId(fieldId);
    if (!surface) return false;
    if (!controller.isCapabilitySelected('external-integrations')
      || !controller.getBooleanFieldValue(surface.enabledFieldId, surface.defaultEnabled(controller.runtimeSnapshot))) {
      return false;
    }
    if (fieldId === 'external-services.telegram.webhook-secret') {
      return controller.getStringFieldValue('external-services.telegram.mode', 'webhook') === 'webhook';
    }
    if (
      fieldId === 'external-services.whatsapp.verify-token'
      || fieldId === 'external-services.whatsapp.phone-number-id'
    ) {
      return controller.getStringFieldValue('external-services.whatsapp.provider', 'meta-cloud') === 'meta-cloud';
    }
    return true;
  }

export function getSelectedSecretMedium(controller: OnboardingWizardController): 'secure' | 'plaintext' {
    const policy = controller.getStringFieldValue(
      'external-services.secret-policy',
      controller.runtimeSnapshot?.runtimeDefaults.secretStoragePolicy ?? 'preferred_secure',
    );
    if (policy === 'require_secure') return 'secure';
    if (policy === 'plaintext_allowed') return 'plaintext';
    if (controller.runtimeSnapshot?.secrets.review.secureAvailable) return 'secure';
    return 'plaintext';
  }

export function shouldEnableHttpListener(controller: OnboardingWizardController): boolean {
    return controller.hasServerCapabilitiesSelected()
      && (controller.isCapabilitySelected('webhook-events') || controller.hasSelectedInboundExternalSurface());
  }

export function shouldExposeHttpListenerNetworkFields(controller: OnboardingWizardController): boolean {
    return controller.hasServerCapabilitiesSelected()
      && (
        controller.isCapabilitySelected('webhook-events')
        || controller.isCapabilitySelected('external-integrations')
        || controller.hasSelectedInboundExternalSurface()
      );
  }

export function shouldExposeControlPlaneNetwork(controller: OnboardingWizardController): boolean {
    return controller.hasServerCapabilitiesSelected()
      && (controller.isCapabilitySelected('browser-access') || controller.isCapabilitySelected('network-access'));
  }

export function requiresAuthBootstrap(controller: OnboardingWizardController): boolean {
    return controller.hasServerCapabilitiesSelected()
      && (!controller.hasLocalAuthUser() || controller.hasBootstrapCredentialPresent());
  }

export function hasAdminAuthUser(controller: OnboardingWizardController): boolean {
    return (controller.runtimeSnapshot?.auth.snapshot.users ?? [])
      .some((user) => user.roles.includes('admin'));
  }

export function hasLocalAuthUser(controller: OnboardingWizardController): boolean {
    return (controller.runtimeSnapshot?.auth.snapshot.userCount ?? 0) > 0
      || (controller.runtimeSnapshot?.auth.snapshot.users ?? []).length > 0;
  }

export function hasBootstrapCredentialPresent(controller: OnboardingWizardController): boolean {
    return controller.runtimeSnapshot?.auth.snapshot.bootstrapCredentialPresent === true;
  }

export function getDefaultAdminUsername(controller: OnboardingWizardController): string {
    const users = controller.runtimeSnapshot?.auth.snapshot.users ?? [];
    const candidates = controller.hasBootstrapCredentialPresent()
      ? ['goodvibes-admin', 'admin']
      : ['admin', 'goodvibes-admin'];
    const candidate = candidates.find((username) => !users.some((user) => user.username === username));
    return candidate ?? `goodvibes-admin-${users.length + 1}`;
  }

export function getBooleanFieldValue(controller: OnboardingWizardController, fieldId: string, fallback: boolean): boolean {
    return controller.toggleState.get(fieldId) ?? fallback;
  }

export function getStringFieldValue(controller: OnboardingWizardController, fieldId: string, fallback: string): string {
    const value = controller.textState.get(fieldId) ?? controller.radioState.get(fieldId);
    return normalizeText(value ?? fallback);
  }

export function parseIntegerFieldValue(controller: OnboardingWizardController, fieldId: string, fallback: number): number | null {
    const raw = controller.getStringFieldValue(fieldId, String(fallback));
    if (!/^-?\d+$/.test(raw)) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) ? parsed : null;
  }

export function getPortFieldValue(controller: OnboardingWizardController, fieldId: string, fallback: number): number {
    const parsed = controller.parseIntegerFieldValue(fieldId, fallback);
    if (parsed === null || parsed < 1 || parsed > 65535) return fallback;
    return parsed;
  }

export function getNumberFieldValue(controller: OnboardingWizardController, fieldId: string, fallback: number, min?: number, max?: number): number {
    const parsed = controller.parseIntegerFieldValue(fieldId, fallback);
    if (parsed === null) return fallback;
    if (min !== undefined && parsed < min) return fallback;
    if (max !== undefined && parsed > max) return fallback;
    return parsed;
  }
