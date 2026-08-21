/**
 * Provider-agnostic API-key fields for the onboarding provider step.
 *
 * Kept out of onboarding-wizard-steps.ts so the step file stays focused on step
 * assembly. Both pieces read from the same registration-truth targets so the
 * inventory line and the per-provider masked fields never disagree.
 */

import type { ProviderKeyCaptureTarget, SubscriptionStatusTarget } from '../../runtime/onboarding/provider-key-capture.ts';
import { deriveSubscriptionStatusTargets, providerKeyFieldId, subscriptionStatusFieldId } from '../../runtime/onboarding/provider-key-capture.ts';
import type { OnboardingProviderAccountRecord } from '../../runtime/onboarding/types.ts';
import type {
  OnboardingWizardMaskedFieldDefinition,
  OnboardingWizardStatusFieldDefinition,
} from './onboarding-wizard-types.ts';

/**
 * Providers with a wired in-wizard subscription sign-in flow. This is DATA, the
 * set of providers whose OAuth login the wizard can start/finish itself, not an
 * assumption that any one vendor is the only subscription option.
 */
const SUBSCRIPTION_SIGN_IN_PROVIDER_IDS = new Set<string>(['openai']);

/**
 * One subscription-status row per subscription-capable provider. The row's copy
 * names the provider from data, never a vendor hardcoded in the field set, so
 * the status surface tracks whatever subscription-capable providers the runtime
 * reports, not a single assumed one.
 */
export function buildSubscriptionStatusFields(
  targets: readonly SubscriptionStatusTarget[],
): OnboardingWizardStatusFieldDefinition[] {
  return targets.map((target) => ({
    kind: 'status',
    id: subscriptionStatusFieldId(target.providerId),
    label: `${target.providerId} subscription status`,
    hint: target.active
      ? `A ${target.providerId} subscription session is already available.`
      : target.pending
        ? `A ${target.providerId} subscription login is pending.`
        : `No ${target.providerId} subscription session was found in the current runtime state.`,
    defaultValue: target.active ? 'Active' : target.pending ? 'Pending' : 'Not detected',
  }));
}

/** The provider-agnostic subscription posture the provider step renders. */
export interface SubscriptionPosture {
  readonly statusFields: OnboardingWizardStatusFieldDefinition[];
  /** The provider whose in-wizard sign-in flow applies now, or null. */
  readonly signInProviderId: string | null;
  readonly signInPending: boolean;
  readonly summaryLine: string;
}

/**
 * Derive the subscription posture for the provider step: one status row per
 * subscription-capable provider, plus which (if any) provider's in-wizard OAuth
 * sign-in flow applies right now (a subscription-capable, sign-in-wired provider
 * that is not already active).
 */
export function buildSubscriptionPosture(
  activeProviderIds: readonly string[],
  pendingProviderIds: readonly string[],
  providers: readonly OnboardingProviderAccountRecord[] | undefined,
): SubscriptionPosture {
  const targets = deriveSubscriptionStatusTargets(providers, activeProviderIds, pendingProviderIds);
  const signIn = targets.find((target) => SUBSCRIPTION_SIGN_IN_PROVIDER_IDS.has(target.providerId) && !target.active);
  const activeCount = targets.filter((target) => target.active).length;
  const pendingCount = targets.filter((target) => target.pending).length;
  return {
    statusFields: buildSubscriptionStatusFields(targets),
    signInProviderId: signIn?.providerId ?? null,
    signInPending: signIn?.pending ?? false,
    summaryLine: targets.length === 0
      ? 'Subscriptions: none detected'
      : `Subscriptions: ${activeCount} active, ${pendingCount} pending across ${targets.length} provider(s)`,
  };
}

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
