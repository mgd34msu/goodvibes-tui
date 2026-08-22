import { describe, expect, test } from 'bun:test';
import type { LLMProvider } from '@pellux/goodvibes-sdk/platform/providers';
import {
  deriveProviderKeyCaptureTargets,
  deriveSubscriptionStatusTargets,
  enrichProviderAccountsSnapshot,
  providerKeyFieldId,
  readProviderApiKeyEnvVar,
  subscriptionStatusFieldId,
  type ProviderKeyRegistryLike,
} from '../../runtime/onboarding/provider-key-capture.ts';
import type {
  OnboardingProviderAccountRecord,
  OnboardingProviderAccountsSnapshot,
} from '../../runtime/onboarding/types.ts';
import { buildProvidersStep } from '../../input/onboarding/onboarding-wizard-steps.ts';
import type { OnboardingWizardControllerLike } from '../../input/onboarding/onboarding-wizard-types.ts';

function providerWithEnvVars(envVars: readonly string[]): LLMProvider {
  return {
    name: 'p',
    models: [],
    chat: async () => { throw new Error('unused'); },
    describeAuthState: () => ({ configured: false, allowAnonymous: false, anonymousReady: false, authEnvVars: envVars }),
  } as unknown as LLMProvider;
}

function registryOf(map: Record<string, LLMProvider | undefined>): ProviderKeyRegistryLike {
  return { tryGet: (name) => map[name] };
}

function record(providerId: string, over: Partial<OnboardingProviderAccountRecord> = {}): OnboardingProviderAccountRecord {
  return {
    providerId,
    configured: false,
    active: false,
    oauthReady: false,
    pendingLogin: false,
    availableRoutes: ['api-key'],
    activeRoute: 'unconfigured',
    authFreshness: 'unconfigured',
    ...over,
  };
}

describe('provider key capture helpers', () => {
  test("readProviderApiKeyEnvVar reads the provider's first declared auth env var", () => {
    const registry = registryOf({ acme: providerWithEnvVars(['ACME_API_KEY', 'ACME_TOKEN']), local: providerWithEnvVars([]) });
    expect(readProviderApiKeyEnvVar(registry, 'acme')).toBe('ACME_API_KEY');
    expect(readProviderApiKeyEnvVar(registry, 'local')).toBeUndefined();
    expect(readProviderApiKeyEnvVar(registry, 'missing')).toBeUndefined();
  });

  test('enrichProviderAccountsSnapshot stamps the env var only where the provider accepts a key', () => {
    const snapshot: OnboardingProviderAccountsSnapshot = {
      capturedAt: 1,
      configuredCount: 0,
      issueCount: 0,
      providers: [record('acme'), record('subonly', { availableRoutes: ['subscription'] })],
    };
    const registry = registryOf({ acme: providerWithEnvVars(['ACME_API_KEY']), subonly: providerWithEnvVars([]) });
    const enriched = enrichProviderAccountsSnapshot(snapshot, registry);
    expect(enriched.providers.find((p) => p.providerId === 'acme')?.apiKeyEnvVar).toBe('ACME_API_KEY');
    expect(enriched.providers.find((p) => p.providerId === 'subonly')?.apiKeyEnvVar).toBeUndefined();
  });

  test('deriveProviderKeyCaptureTargets keeps only key-accepting providers, sorted', () => {
    const targets = deriveProviderKeyCaptureTargets([
      record('zeta', { apiKeyEnvVar: 'ZETA_API_KEY' }),
      record('acme', { apiKeyEnvVar: 'ACME_API_KEY', configured: true }),
      record('subonly', { availableRoutes: ['subscription'] }),
      record('nokey', { availableRoutes: ['api-key'] }),
    ]);
    expect(targets.map((t) => t.providerId)).toEqual(['acme', 'zeta']);
    expect(targets[0]).toEqual({ providerId: 'acme', apiKeyEnvVar: 'ACME_API_KEY', configured: true });
  });
});

describe('deriveSubscriptionStatusTargets', () => {
  test('one target per subscription-capable provider, unioned with live/pending sessions', () => {
    const targets = deriveSubscriptionStatusTargets(
      [
        record('acme', { availableRoutes: ['subscription'] }),
        record('zephyr', { availableRoutes: ['subscription'] }),
        record('keyonly', { availableRoutes: ['api-key'] }),
      ],
      ['acme'],
      ['orbit'],
    );
    expect(targets.map((t) => t.providerId)).toEqual(['acme', 'orbit', 'zephyr']);
    expect(targets.find((t) => t.providerId === 'acme')).toEqual({ providerId: 'acme', active: true, pending: false });
    expect(targets.find((t) => t.providerId === 'orbit')).toEqual({ providerId: 'orbit', active: false, pending: true });
    expect(targets.find((t) => t.providerId === 'zephyr')).toEqual({ providerId: 'zephyr', active: false, pending: false });
    // A key-only provider is never surfaced as a subscription row.
    expect(targets.some((t) => t.providerId === 'keyonly')).toBe(false);
  });

  test('surfaces a live subscription even with no account records', () => {
    const targets = deriveSubscriptionStatusTargets(undefined, ['orbit'], []);
    expect(targets).toEqual([{ providerId: 'orbit', active: true, pending: false }]);
  });
});

// Minimal controller stub exercising only what buildProvidersStep reads.
function stubController(providers: OnboardingProviderAccountRecord[]): OnboardingWizardControllerLike {
  return {
    mode: 'new',
    runtimeDerived: {
      reopenEditAcknowledgements: {
        providers: { detail: '', accepted: false, required: false, reason: 'first-run' },
      },
    },
    runtimeSnapshot: {
      subscriptions: { active: [], pending: [] },
      providerAccounts: { capturedAt: 1, configuredCount: 0, issueCount: 0, providers },
    },
    getFieldValueLabel: () => 'pending',
  } as unknown as OnboardingWizardControllerLike;
}

describe('onboarding provider step: provider-agnostic key fields', () => {
  test('emits one masked key field per key-accepting provider and never a single hardcoded vendor', () => {
    const step = buildProvidersStep(stubController([
      record('acme', { apiKeyEnvVar: 'ACME_API_KEY' }),
      record('zephyr', { apiKeyEnvVar: 'ZEPHYR_API_KEY' }),
      record('subonly', { availableRoutes: ['subscription'] }),
    ]));

    const maskedIds = step.fields.filter((f) => f.kind === 'masked').map((f) => f.id);
    expect(maskedIds).toContain(providerKeyFieldId('acme'));
    expect(maskedIds).toContain(providerKeyFieldId('zephyr'));
    // The retired hardcoded OpenAI field is gone; no vendor is the sole option.
    expect(maskedIds).not.toContain('providers.openai-api-key');
    expect(step.description).not.toContain('OpenAI API key');

    const acmeField = step.fields.find((f) => f.id === providerKeyFieldId('acme'));
    expect(acmeField?.label).toBe('acme API key');
  });

  test('with no key-accepting providers, no key fields are generated', () => {
    const step = buildProvidersStep(stubController([record('subonly', { availableRoutes: ['subscription'] })]));
    const maskedIds = step.fields.filter((f) => f.kind === 'masked').map((f) => f.id);
    expect(maskedIds.filter((id) => id.startsWith('providers.api-key.'))).toHaveLength(0);
  });

  test('emits one subscription-status row per subscription-capable provider, no hardcoded vendor row', () => {
    const step = buildProvidersStep(stubController([
      record('acme', { availableRoutes: ['subscription'] }),
      record('zephyr', { availableRoutes: ['subscription'] }),
    ]));
    const statusIds = step.fields.filter((f) => f.kind === 'status').map((f) => f.id);
    expect(statusIds).toContain(subscriptionStatusFieldId('acme'));
    expect(statusIds).toContain(subscriptionStatusFieldId('zephyr'));
    // The retired single-vendor status row id is gone.
    expect(statusIds).not.toContain('providers.openai-subscription');
  });
});
