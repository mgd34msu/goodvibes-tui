/**
 * provider-classification.ts, how a provider is paid for: a raw API key, a
 * cloud account, a stored subscription/OAuth session, a local runtime, or
 * honestly unknown.
 *
 * Lives in the foundation `providers` layer (it imports nothing) because both
 * the CLI management surfaces and the in-session failover notice need it: when
 * automatic failover moves a turn onto a different backend, the notice names
 * the billing class it moved from and to, so a switch from a metered API key
 * onto the user's own subscription is something the user can see and object to
 * rather than discover on an invoice.
 */
export type ProviderSetupClass =
  | 'api-key'
  | 'cloud-account'
  | 'local'
  | 'no-key-free'
  | 'self-hosted'
  | 'subscription'
  | 'unknown';

export interface ProviderSetupClassificationInput {
  readonly providerId: string;
  readonly authMode?: string;
  readonly configured?: boolean;
  readonly modelCount?: number;
}

export interface ProviderSetupClassification {
  readonly setupClass: ProviderSetupClass;
  readonly setupLabel: string;
  readonly setupDetail: string;
}

const SUBSCRIPTION_PROVIDERS = new Set([
  'openai-subscriber',
]);

const LOCAL_PROVIDERS = new Set([
  'ollama',
  'synthetic',
]);

const SELF_HOSTED_PROVIDERS = new Set([
  'copilot-proxy',
  'litellm',
  'sglang',
]);

const CLOUD_ACCOUNT_PROVIDERS = new Set([
  'amazon-bedrock',
  'amazon-bedrock-mantle',
  'anthropic-vertex',
  'microsoft-foundry',
]);

function byClass(setupClass: ProviderSetupClass): ProviderSetupClassification {
  switch (setupClass) {
    case 'api-key':
      return {
        setupClass,
        setupLabel: 'API key',
        setupDetail: 'Requires a provider API key or equivalent secret.',
      };
    case 'cloud-account':
      return {
        setupClass,
        setupLabel: 'Cloud account',
        setupDetail: 'Requires cloud account credentials or workload identity.',
      };
    case 'local':
      return {
        setupClass,
        setupLabel: 'Local/no-key',
        setupDetail: 'Runs locally or through a built-in test/local path without a paid API key.',
      };
    case 'no-key-free':
      return {
        setupClass,
        setupLabel: 'No-key/free',
        setupDetail: 'Can be listed or used without a configured paid API key in this runtime.',
      };
    case 'self-hosted':
      return {
        setupClass,
        setupLabel: 'Self-hosted',
        setupDetail: 'Uses an operator-managed local or self-hosted gateway.',
      };
    case 'subscription':
      return {
        setupClass,
        setupLabel: 'Subscription',
        setupDetail: 'Uses a stored subscription/OAuth session instead of a raw API key.',
      };
    case 'unknown':
      return {
        setupClass,
        setupLabel: 'Unknown',
        setupDetail: 'Setup path is not available from runtime metadata.',
      };
  }
}

export function classifyProviderSetup(input: ProviderSetupClassificationInput): ProviderSetupClassification {
  const providerId = input.providerId.trim().toLowerCase();
  const authMode = input.authMode?.trim().toLowerCase() ?? '';
  const configured = input.configured ?? false;
  const modelCount = input.modelCount ?? 0;

  if (SUBSCRIPTION_PROVIDERS.has(providerId) || authMode === 'oauth') return byClass('subscription');
  if (LOCAL_PROVIDERS.has(providerId)) return byClass('local');
  if (SELF_HOSTED_PROVIDERS.has(providerId)) return byClass('self-hosted');
  if (CLOUD_ACCOUNT_PROVIDERS.has(providerId)) return byClass('cloud-account');
  if (authMode === 'api-key' || authMode === 'bearer') return byClass('api-key');
  if (authMode === 'anonymous' || authMode === 'none') {
    return configured || modelCount > 0 ? byClass('no-key-free') : byClass('unknown');
  }
  return byClass('unknown');
}
