import {
  CLOUDFLARE_COMPONENT_IDS,
  CLOUDFLARE_COMPONENT_LABELS,
  DEFAULT_CLOUDFLARE_COMPONENT_SELECTION,
  type CloudflareBatchMode,
  type CloudflareComponent,
  type CloudflareComponentSelection,
  type CloudflareProvisionRequest,
} from '../../runtime/cloudflare-control-plane.ts';
import { buildGoodVibesSecretRef, normalizeText } from './onboarding-wizard-helpers.ts';
import type { OnboardingWizardControllerLike } from './onboarding-wizard-types.ts';
import type { OnboardingWizardRadioOption } from './onboarding-wizard-types.ts';

export const CLOUDFLARE_SETUP_SOURCE_OPTIONS: readonly OnboardingWizardRadioOption[] = [
  {
    id: 'save-only',
    label: 'Save settings only',
    hint: 'Persist Cloudflare fields without passing a token to the daemon. Provision later from the Cloudflare command or settings.',
  },
  {
    id: 'bootstrap-token',
    label: 'Paste temporary bootstrap token',
    hint: 'Use a short-lived Cloudflare token once. The SDK creates and stores a narrower GoodVibes operational token.',
  },
  {
    id: 'bootstrap-env',
    label: 'Read bootstrap token from environment',
    hint: 'Read a temporary token from an environment variable and pass it once to the SDK. The value is not stored.',
  },
  {
    id: 'operational-token',
    label: 'Paste final operational token',
    hint: 'Use a token you already created. The SDK can store it as a GoodVibes secret during provisioning.',
  },
  {
    id: 'operational-env',
    label: 'Use final token from environment',
    hint: 'Use an environment-backed token reference such as CLOUDFLARE_API_TOKEN.',
  },
];

export const CLOUDFLARE_BATCH_MODE_OPTIONS: readonly OnboardingWizardRadioOption[] = [
  {
    id: 'off',
    label: 'Off',
    hint: 'Keep daemon requests on the immediate local path. Cloudflare resource settings can still be saved.',
  },
  {
    id: 'explicit',
    label: 'Explicit batch only',
    hint: 'Only requests explicitly marked for batch execution use the configured batch path.',
  },
  {
    id: 'eligible-by-default',
    label: 'Eligible requests batch by default',
    hint: 'Batch-capable daemon work can use the configured batch path unless the caller opts out.',
  },
];

export const CLOUDFLARE_YES_NO_OPTIONS: readonly OnboardingWizardRadioOption[] = [
  { id: 'yes', label: 'Yes', hint: 'Enable this behavior.' },
  { id: 'no', label: 'No', hint: 'Leave this behavior off.' },
];

export const CLOUDFLARE_PROVISION_OPTIONS: readonly OnboardingWizardRadioOption[] = [
  {
    id: 'no',
    label: 'No, save configuration only',
    hint: 'Final Apply saves the settings. Use the Cloudflare command or this wizard later to provision resources.',
  },
  {
    id: 'yes',
    label: 'Yes, create or update Cloudflare resources',
    hint: 'Final Apply asks the daemon SDK route to create/update selected Cloudflare resources and verify the Worker when possible.',
  },
];

export type CloudflareSetupSource =
  | 'save-only'
  | 'bootstrap-token'
  | 'bootstrap-env'
  | 'operational-token'
  | 'operational-env';

export function cloudflareComponentFieldId(component: CloudflareComponent): string {
  return `cloudflare.component.${component}`;
}

export function cloudflareComponentLabel(component: CloudflareComponent): string {
  return CLOUDFLARE_COMPONENT_LABELS[component];
}

export function isCloudflareConfigured(controller: OnboardingWizardControllerLike): boolean {
  const config = controller.runtimeSnapshot?.config.cloudflare;
  if (!config) return false;
  return config.enabled
    || normalizeText(config.accountId).length > 0
    || normalizeText(config.apiTokenRef).length > 0
    || normalizeText(config.workerBaseUrl).length > 0
    || normalizeText(config.workerName).length > 0;
}

export function shouldShowCloudflareStep(controller: OnboardingWizardControllerLike): boolean {
  return controller.isCapabilitySelected('cloudflare-batch') || isCloudflareConfigured(controller);
}

export function getCloudflareSetupSource(controller: OnboardingWizardControllerLike): CloudflareSetupSource {
  const configuredTokenRef = controller.runtimeSnapshot?.config.cloudflare.apiTokenRef ?? '';
  const defaultValue = configuredTokenRef.startsWith('goodvibes://secrets/env/') ? 'operational-env' : 'save-only';
  const value = controller.getStringFieldValue('cloudflare.setup-source', defaultValue);
  if (
    value === 'bootstrap-token'
    || value === 'bootstrap-env'
    || value === 'operational-token'
    || value === 'operational-env'
    || value === 'save-only'
  ) {
    return value;
  }
  return 'save-only';
}

export function getCloudflareComponentSelection(controller: OnboardingWizardControllerLike): Record<CloudflareComponent, boolean> {
  const selected: Record<CloudflareComponent, boolean> = { ...DEFAULT_CLOUDFLARE_COMPONENT_SELECTION };
  const configured = controller.runtimeSnapshot?.config.cloudflare;
  for (const component of CLOUDFLARE_COMPONENT_IDS) {
    const fallback = configured?.enabled === true
      ? component === 'workers' || component === 'queues'
      : DEFAULT_CLOUDFLARE_COMPONENT_SELECTION[component];
    selected[component] = controller.getBooleanFieldValue(cloudflareComponentFieldId(component), fallback);
  }
  return selected;
}

export function getSelectedCloudflareComponents(controller: OnboardingWizardControllerLike): CloudflareComponentSelection {
  return getCloudflareComponentSelection(controller);
}

export function getCloudflareBatchMode(controller: OnboardingWizardControllerLike): CloudflareBatchMode {
  const value = controller.getStringFieldValue('cloudflare.batch-mode', controller.runtimeSnapshot?.config.batch.mode ?? 'off');
  return value === 'explicit' || value === 'eligible-by-default' ? value : 'off';
}

export function buildCloudflareApiTokenRef(envName: string): string {
  const normalized = normalizeText(envName) || 'CLOUDFLARE_API_TOKEN';
  return `goodvibes://secrets/env/${encodeURIComponent(normalized)}`;
}

export function buildCloudflareProvisionRequest(controller: OnboardingWizardControllerLike, options: {
  readonly includeTransientSecrets?: boolean;
} = {}): CloudflareProvisionRequest {
  const components = getCloudflareComponentSelection(controller);
  const setupSource = getCloudflareSetupSource(controller);
  const accountId = controller.getStringFieldValue('cloudflare.account-id', controller.runtimeSnapshot?.config.cloudflare.accountId ?? '');
  const zoneId = controller.getStringFieldValue('cloudflare.zone-id', controller.runtimeSnapshot?.config.cloudflare.zoneId ?? '');
  const zoneName = controller.getStringFieldValue('cloudflare.zone-name', controller.runtimeSnapshot?.config.cloudflare.zoneName ?? '');
  const apiToken = setupSource === 'operational-token' && options.includeTransientSecrets
    ? controller.getStringFieldValue('cloudflare.operational-token', '')
    : '';
  const apiTokenRef = setupSource === 'operational-env'
    ? buildCloudflareApiTokenRef(controller.getStringFieldValue('cloudflare.operational-env-name', 'CLOUDFLARE_API_TOKEN'))
    : controller.runtimeSnapshot?.config.cloudflare.apiTokenRef ?? '';

  return {
    components,
    ...(accountId ? { accountId } : {}),
    ...(zoneId ? { zoneId } : {}),
    ...(zoneName ? { zoneName } : {}),
    ...(apiToken ? { apiToken, storeApiToken: true } : {}),
    ...(!apiToken && apiTokenRef ? { apiTokenRef } : {}),
    workerName: controller.getStringFieldValue('cloudflare.worker-name', controller.runtimeSnapshot?.config.cloudflare.workerName ?? 'goodvibes-batch-worker'),
    workerSubdomain: controller.getStringFieldValue('cloudflare.worker-subdomain', controller.runtimeSnapshot?.config.cloudflare.workerSubdomain ?? ''),
    workerHostname: controller.getStringFieldValue('cloudflare.worker-hostname', controller.runtimeSnapshot?.config.cloudflare.workerHostname ?? ''),
    workerBaseUrl: controller.getStringFieldValue('cloudflare.worker-base-url', controller.runtimeSnapshot?.config.cloudflare.workerBaseUrl ?? ''),
    daemonBaseUrl: controller.getStringFieldValue('cloudflare.daemon-base-url', controller.runtimeSnapshot?.config.cloudflare.daemonBaseUrl ?? ''),
    daemonHostname: controller.getStringFieldValue('cloudflare.daemon-hostname', controller.runtimeSnapshot?.config.cloudflare.daemonHostname ?? ''),
    queueName: controller.getStringFieldValue('cloudflare.queue-name', controller.runtimeSnapshot?.config.cloudflare.queueName ?? 'goodvibes-batch'),
    deadLetterQueueName: controller.getStringFieldValue('cloudflare.dead-letter-queue-name', controller.runtimeSnapshot?.config.cloudflare.deadLetterQueueName ?? 'goodvibes-batch-dlq'),
    tunnelName: controller.getStringFieldValue('cloudflare.tunnel-name', controller.runtimeSnapshot?.config.cloudflare.tunnelName ?? 'goodvibes-daemon'),
    tunnelId: controller.getStringFieldValue('cloudflare.tunnel-id', controller.runtimeSnapshot?.config.cloudflare.tunnelId ?? ''),
    tunnelServiceUrl: controller.getStringFieldValue('cloudflare.tunnel-service-url', ''),
    tunnelTokenRef: controller.getStringFieldValue('cloudflare.tunnel-token-ref', controller.runtimeSnapshot?.config.cloudflare.tunnelTokenRef ?? ''),
    accessAppId: controller.getStringFieldValue('cloudflare.access-app-id', controller.runtimeSnapshot?.config.cloudflare.accessAppId ?? ''),
    accessServiceTokenId: controller.getStringFieldValue('cloudflare.access-service-token-id', controller.runtimeSnapshot?.config.cloudflare.accessServiceTokenId ?? ''),
    accessServiceTokenRef: controller.getStringFieldValue('cloudflare.access-service-token-ref', controller.runtimeSnapshot?.config.cloudflare.accessServiceTokenRef ?? ''),
    kvNamespaceName: controller.getStringFieldValue('cloudflare.kv-namespace-name', controller.runtimeSnapshot?.config.cloudflare.kvNamespaceName ?? 'goodvibes-runtime'),
    kvNamespaceId: controller.getStringFieldValue('cloudflare.kv-namespace-id', controller.runtimeSnapshot?.config.cloudflare.kvNamespaceId ?? ''),
    durableObjectNamespaceName: controller.getStringFieldValue('cloudflare.do-namespace-name', controller.runtimeSnapshot?.config.cloudflare.durableObjectNamespaceName ?? 'GoodVibesCoordinator'),
    durableObjectNamespaceId: controller.getStringFieldValue('cloudflare.do-namespace-id', controller.runtimeSnapshot?.config.cloudflare.durableObjectNamespaceId ?? ''),
    r2BucketName: controller.getStringFieldValue('cloudflare.r2-bucket-name', controller.runtimeSnapshot?.config.cloudflare.r2BucketName ?? 'goodvibes-artifacts'),
    secretsStoreName: controller.getStringFieldValue('cloudflare.secrets-store-name', controller.runtimeSnapshot?.config.cloudflare.secretsStoreName ?? 'goodvibes'),
    secretsStoreId: controller.getStringFieldValue('cloudflare.secrets-store-id', controller.runtimeSnapshot?.config.cloudflare.secretsStoreId ?? ''),
    workerCron: controller.getStringFieldValue('cloudflare.worker-cron', controller.runtimeSnapshot?.config.cloudflare.workerCron ?? '*/5 * * * *'),
    enableWorkersDev: true,
    queueJobPayloads: false,
    persistConfig: true,
    verify: true,
    batchMode: getCloudflareBatchMode(controller),
  };
}

export function buildCloudflareOperationalTokenRef(): string {
  return buildGoodVibesSecretRef('CLOUDFLARE_API_TOKEN');
}
