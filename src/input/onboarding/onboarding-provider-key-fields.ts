/**
 * Provider-agnostic API-key fields for the onboarding provider step.
 *
 * Kept out of onboarding-wizard-steps.ts so the step file stays focused on step
 * assembly. Both pieces read from the same registration-truth targets so the
 * inventory line and the per-provider masked fields never disagree.
 */

import type { ProviderKeyCaptureTarget } from '../../runtime/onboarding/provider-key-capture.ts';
import { providerKeyFieldId } from '../../runtime/onboarding/provider-key-capture.ts';
import type {
  OnboardingWizardMaskedFieldDefinition,
  OnboardingWizardStatusFieldDefinition,
} from './onboarding-wizard-types.ts';

/** The status line summarizing how many key-accepting providers are configured. */
export function buildProviderKeyInventoryField(
  targets: readonly ProviderKeyCaptureTarget[],
): OnboardingWizardStatusFieldDefinition {
  const configuredCount = targets.filter((target) => target.configured).length;
  return {
    kind: 'status',
    id: 'providers.api-key-inventory',
    label: 'Provider API keys',
    hint: targets.length === 0
      ? 'No key-accepting providers are registered yet in the current runtime state.'
      : `${targets.length} provider(s) accept an API key; ${configuredCount} already configured. Values stay masked.`,
    defaultValue: targets.length === 0
      ? 'None detected'
      : `${configuredCount}/${targets.length} configured`,
  };
}

/** One masked field per key-accepting provider, keyed off registration truth. */
export function buildProviderKeyMaskedFields(
  targets: readonly ProviderKeyCaptureTarget[],
): OnboardingWizardMaskedFieldDefinition[] {
  return targets.map((target) => ({
    kind: 'masked',
    id: providerKeyFieldId(target.providerId),
    label: `${target.providerId} API key`,
    hint: target.configured
      ? `A key for ${target.providerId} is already stored. Leave blank to keep it; enter a new key to replace it through the secret manager.`
      : `Optional: enter an API key for ${target.providerId} now. The value is stored through the secret manager, not in config.`,
    placeholder: target.configured ? 'already configured' : 'paste key',
    defaultValue: '',
  }));
}
