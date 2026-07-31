import { CLOUDFLARE_COMPONENT_IDS, DEFAULT_CLOUDFLARE_COMPONENT_SELECTION } from '../../runtime/cloudflare-control-plane.ts';
import { normalizeText } from './onboarding-wizard-helpers.ts';
import type { OnboardingWizardControllerLike } from './onboarding-wizard-types.ts';
import type { OnboardingWizardFieldDefinition, OnboardingWizardStepDefinition } from './onboarding-wizard-types.ts';
import {
  CLOUDFLARE_BATCH_MODE_OPTIONS,
  CLOUDFLARE_PROVISION_OPTIONS,
  CLOUDFLARE_SETUP_SOURCE_OPTIONS,
  CLOUDFLARE_YES_NO_OPTIONS,
  cloudflareComponentFieldId,
  cloudflareComponentLabel,
  getCloudflareBatchMode,
  getCloudflareComponentSelection,
  getCloudflareSetupSource,
} from './onboarding-wizard-cloudflare.ts';

export function buildCloudflareStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
  const config = controller.runtimeSnapshot?.config.cloudflare;
  const batch = controller.runtimeSnapshot?.config.batch;
  const enabledDefault = controller.isCapabilitySelected('cloudflare-batch') || config?.enabled === true;
  const enabled = controller.getBooleanFieldValue('cloudflare.enabled', enabledDefault);
  const components = getCloudflareComponentSelection(controller);
  const componentCount = Object.values(components).filter(Boolean).length;
  const setupSource = getCloudflareSetupSource(controller);
  const batchMode = getCloudflareBatchMode(controller);
  const bind = controller.runtimeSnapshot?.bindSettings.controlPlane;
  const defaultDaemonBaseUrl = normalizeText(config?.daemonBaseUrl)
    || `http://${bind?.host && bind.host !== '0.0.0.0' && bind.host !== '::' ? bind.host : '127.0.0.1'}:${bind?.port ?? 3421}`;
  const resultMessage = controller.textState.get('cloudflare.action-status') ?? 'No Cloudflare daemon action has run in this wizard session.';
  const fields: OnboardingWizardFieldDefinition[] = [
    {
      kind: 'checklist',
      id: 'cloudflare.enabled',
      label: 'Enable Cloudflare integration',
      hint: 'Turns on GoodVibes Cloudflare config. Batch execution remains opt-in through the batch mode below.',
      defaultValue: enabledDefault,
    },
  ];

  if (enabled) {
    fields.push(
      {
        kind: 'radio',
        id: 'cloudflare.batch-mode',
        label: 'Batch mode',
        hint: 'Controls when daemon work uses the batch path. Off keeps normal immediate behavior.',
        options: CLOUDFLARE_BATCH_MODE_OPTIONS,
        defaultValue: batch?.mode ?? 'off',
      },
      {
        kind: 'radio',
        id: 'cloudflare.free-tier-mode',
        label: 'Free-tier guardrails',
        hint: 'Keep conservative queue-operation limits visible for free-tier Cloudflare accounts.',
        options: CLOUDFLARE_YES_NO_OPTIONS,
        defaultValue: config?.freeTierMode === false ? 'no' : 'yes',
      },
    );

    for (const component of CLOUDFLARE_COMPONENT_IDS) {
      const advanced = component !== 'workers' && component !== 'queues';
      fields.push({
        kind: 'checklist',
        id: cloudflareComponentFieldId(component),
        label: `${cloudflareComponentLabel(component)}${advanced ? ' (advanced)' : ''}`,
        hint: cloudflareComponentHint(component),
        defaultValue: config?.enabled === true
          ? component === 'workers' || component === 'queues'
          : DEFAULT_CLOUDFLARE_COMPONENT_SELECTION[component],
      });
    }

    fields.push(
      {
        kind: 'radio',
        id: 'cloudflare.setup-source',
        label: 'Cloudflare token setup path',
        hint: 'Choose whether the daemon SDK route creates/stores an operational token, uses an existing token, or only saves settings.',
        options: CLOUDFLARE_SETUP_SOURCE_OPTIONS,
        defaultValue: getCloudflareSetupSource(controller),
      },
    );

    if (setupSource === 'bootstrap-token') {
      fields.push({
        kind: 'masked',
        id: 'cloudflare.bootstrap-token',
        label: 'Temporary bootstrap token',
        hint: 'Used once by the SDK route to create a narrower GoodVibes operational token. It is never persisted.',
        placeholder: 'temporary Cloudflare token',
        defaultValue: '',
      });
    }
    if (setupSource === 'bootstrap-env') {
      fields.push({
        kind: 'text',
        id: 'cloudflare.bootstrap-env-name',
        label: 'Bootstrap token environment variable',
        hint: 'The TUI reads this environment variable once and passes the value to the SDK token-create route. It is not persisted.',
        placeholder: 'GOODVIBES_CLOUDFLARE_BOOTSTRAP_TOKEN',
        defaultValue: 'GOODVIBES_CLOUDFLARE_BOOTSTRAP_TOKEN',
      });
    }
    if (setupSource === 'operational-token') {
      fields.push({
        kind: 'masked',
        id: 'cloudflare.operational-token',
        label: 'Final Cloudflare API token',
        hint: 'A fully-created operational token. Provisioning can store it as goodvibes://secrets/goodvibes/CLOUDFLARE_API_TOKEN.',
        placeholder: 'Cloudflare API token',
        defaultValue: '',
      });
    }
    if (setupSource === 'operational-env') {
      fields.push({
        kind: 'text',
        id: 'cloudflare.operational-env-name',
        label: 'Operational token environment variable',
        hint: 'Defaults to CLOUDFLARE_API_TOKEN. The SDK can also resolve goodvibes://secrets/env/<name>.',
        placeholder: 'CLOUDFLARE_API_TOKEN',
        defaultValue: config?.apiTokenRef?.startsWith('goodvibes://secrets/env/')
          ? decodeURIComponent(config.apiTokenRef.slice('goodvibes://secrets/env/'.length))
          : 'CLOUDFLARE_API_TOKEN',
      });
    }

    fields.push(
      {
        kind: 'text',
        id: 'cloudflare.account-id',
        label: 'Cloudflare account id',
        hint: 'Required for validation, token creation, discovery, and provisioning. Discovery can list accounts when the token permits it.',
        placeholder: 'account id',
        defaultValue: config?.accountId ?? '',
      },
      {
        kind: 'text',
        id: 'cloudflare.zone-id',
        label: 'Zone id',
        hint: 'Optional unless DNS or Access hostname automation is selected. Use the zone that owns the chosen hostname.',
        placeholder: 'optional zone id',
        defaultValue: config?.zoneId ?? '',
      },
      {
        kind: 'text',
        id: 'cloudflare.zone-name',
        label: 'Zone name',
        hint: 'Optional unless DNS or Access hostname automation is selected. Example: example.com for goodvibes.example.com.',
        placeholder: 'example.com',
        defaultValue: config?.zoneName ?? '',
      },
      {
        kind: 'text',
        id: 'cloudflare.daemon-base-url',
        label: 'Daemon base URL for Worker calls',
        hint: 'The URL Cloudflare Worker/Tunnel uses to reach the GoodVibes daemon. 127.0.0.1 only works for local verification, not remote Cloudflare calls.',
        placeholder: 'https://daemon.example.com or http://127.0.0.1:3421',
        defaultValue: defaultDaemonBaseUrl,
      },
      {
        kind: 'text',
        id: 'cloudflare.daemon-hostname',
        label: 'Daemon hostname',
        hint: 'Optional hostname used by Tunnel, Access, and DNS automation. Leave blank to infer it from daemon base URL when possible.',
        placeholder: 'daemon.example.com',
        defaultValue: config?.daemonHostname ?? '',
      },
      {
        kind: 'text',
        id: 'cloudflare.worker-name',
        label: 'Worker name',
        hint: 'Cloudflare Worker script name to create or update.',
        placeholder: 'goodvibes-batch-worker',
        defaultValue: config?.workerName || 'goodvibes-batch-worker',
      },
      {
        kind: 'text',
        id: 'cloudflare.worker-subdomain',
        label: 'workers.dev subdomain',
        hint: 'Optional workers.dev subdomain. If unavailable or blank, a custom route can still be used later.',
        placeholder: 'account-subdomain',
        defaultValue: config?.workerSubdomain ?? '',
      },
      {
        kind: 'text',
        id: 'cloudflare.worker-hostname',
        label: 'Worker custom hostname',
        hint: 'Optional custom hostname for Worker DNS/route automation.',
        placeholder: 'goodvibes.example.com',
        defaultValue: config?.workerHostname ?? '',
      },
      {
        kind: 'text',
        id: 'cloudflare.worker-base-url',
        label: 'Worker base URL',
        hint: 'Optional existing Worker URL. Provisioning fills this when it can infer the workers.dev URL.',
        placeholder: 'https://goodvibes-batch-worker.account.workers.dev',
        defaultValue: config?.workerBaseUrl ?? '',
      },
    );

    if (components.queues) {
      fields.push(
        {
          kind: 'text',
          id: 'cloudflare.queue-name',
          label: 'Queue name',
          hint: 'Cloudflare Queue used for GoodVibes batch job signals.',
          placeholder: 'goodvibes-batch',
          defaultValue: config?.queueName || 'goodvibes-batch',
        },
        {
          kind: 'text',
          id: 'cloudflare.dead-letter-queue-name',
          label: 'Dead-letter queue name',
          hint: 'Cloudflare dead-letter queue for failed batch signals.',
          placeholder: 'goodvibes-batch-dlq',
          defaultValue: config?.deadLetterQueueName || 'goodvibes-batch-dlq',
        },
      );
    }

    if (components.zeroTrustTunnel) {
      fields.push(
        {
          kind: 'text',
          id: 'cloudflare.tunnel-name',
          label: 'Tunnel name',
          hint: 'Cloudflare Tunnel name to create or reuse.',
          placeholder: 'goodvibes-daemon',
          defaultValue: config?.tunnelName || 'goodvibes-daemon',
        },
        {
          kind: 'text',
          id: 'cloudflare.tunnel-id',
          label: 'Existing tunnel id',
          hint: 'Optional existing Tunnel id. Leave blank to let provisioning create or discover one by name.',
          placeholder: 'optional tunnel id',
          defaultValue: config?.tunnelId ?? '',
        },
        {
          kind: 'text',
          id: 'cloudflare.tunnel-service-url',
          label: 'Tunnel service URL',
          hint: 'Optional origin service URL for Tunnel ingress. Leave blank to use the daemon base URL.',
          placeholder: 'http://127.0.0.1:3421',
          defaultValue: '',
        },
        {
          kind: 'text',
          id: 'cloudflare.tunnel-token-ref',
          label: 'Tunnel token secret ref',
          hint: 'Optional existing goodvibes:// secret ref for a Cloudflare Tunnel token.',
          placeholder: 'goodvibes://secrets/goodvibes/CLOUDFLARE_TUNNEL_TOKEN',
          defaultValue: config?.tunnelTokenRef ?? '',
        },
      );
    }

    // Trust-proxy notice — shown when Tunnel is selected so the
    // operator sees the security implication before applying.
    const tunnelSelected = enabled && components.zeroTrustTunnel;
    if (tunnelSelected) {
      fields.push({
        kind: 'status',
        id: 'cloudflare.trust-proxy-notice',
        label: 'trustProxy will be enabled for control plane and HTTP listener',
        defaultValue: 'Notice',
        hint: 'Selecting Zero Trust Tunnel auto-writes controlPlane.trustProxy=true and httpListener.trustProxy=true so the login rate-limiter keys on the client address the tunnel forwards rather than the tunnel egress address. That address is read from X-Forwarded-For, which a client reaching the listener directly can set for itself, so it can still rotate its own rate-limit bucket. The stricter read — accept CF-Connecting-IP only from a peer inside Cloudflare published ranges — ships in the SDK listener but has no setting behind it yet, so keep the listener reachable only through the tunnel. See docs/deployment-and-services.md for the full risk posture.',
      });
    }

    if (components.zeroTrustAccess) {
      fields.push(
        {
          kind: 'text',
          id: 'cloudflare.access-app-id',
          label: 'Access app id',
          hint: 'Optional existing Cloudflare Access application id. Leave blank to let provisioning create or discover one.',
          placeholder: 'optional Access app id',
          defaultValue: config?.accessAppId ?? '',
        },
        {
          kind: 'text',
          id: 'cloudflare.access-service-token-id',
          label: 'Access service token id',
          hint: 'Optional existing Access service token id.',
          placeholder: 'optional service token id',
          defaultValue: config?.accessServiceTokenId ?? '',
        },
        {
          kind: 'text',
          id: 'cloudflare.access-service-token-ref',
          label: 'Access service token secret ref',
          hint: 'Optional existing goodvibes:// secret ref for Access service token material.',
          placeholder: 'goodvibes://secrets/goodvibes/CLOUDFLARE_ACCESS_SERVICE_TOKEN',
          defaultValue: config?.accessServiceTokenRef ?? '',
        },
      );
    }

    if (components.kv) {
      fields.push(
        {
          kind: 'text',
          id: 'cloudflare.kv-namespace-name',
          label: 'KV namespace name',
          hint: 'Cloudflare KV namespace for optional batch/runtime state.',
          placeholder: 'goodvibes-runtime',
          defaultValue: config?.kvNamespaceName || 'goodvibes-runtime',
        },
        {
          kind: 'text',
          id: 'cloudflare.kv-namespace-id',
          label: 'Existing KV namespace id',
          hint: 'Optional existing KV namespace id.',
          placeholder: 'optional KV id',
          defaultValue: config?.kvNamespaceId ?? '',
        },
      );
    }

    if (components.durableObjects) {
      fields.push(
        {
          kind: 'text',
          id: 'cloudflare.do-namespace-name',
          label: 'Durable Object namespace name',
          hint: 'Durable Object namespace expected by the Worker when this advanced component is selected.',
          placeholder: 'GoodVibesCoordinator',
          defaultValue: config?.durableObjectNamespaceName || 'GoodVibesCoordinator',
        },
        {
          kind: 'text',
          id: 'cloudflare.do-namespace-id',
          label: 'Durable Object namespace id',
          hint: 'Optional existing Durable Object namespace id.',
          placeholder: 'optional Durable Object id',
          defaultValue: config?.durableObjectNamespaceId ?? '',
        },
      );
    }

    if (components.r2) {
      fields.push({
        kind: 'text',
        id: 'cloudflare.r2-bucket-name',
        label: 'R2 bucket name',
        hint: 'R2 Standard bucket for optional batch artifacts.',
        placeholder: 'goodvibes-artifacts',
        defaultValue: config?.r2BucketName || 'goodvibes-artifacts',
      });
    }

    if (components.secretsStore) {
      fields.push(
        {
          kind: 'text',
          id: 'cloudflare.secrets-store-name',
          label: 'Secrets Store name',
          hint: 'Cloudflare Secrets Store name for optional account-level secrets.',
          placeholder: 'goodvibes',
          defaultValue: config?.secretsStoreName || 'goodvibes',
        },
        {
          kind: 'text',
          id: 'cloudflare.secrets-store-id',
          label: 'Secrets Store id',
          hint: 'Optional existing Cloudflare Secrets Store id.',
          placeholder: 'optional Secrets Store id',
          defaultValue: config?.secretsStoreId ?? '',
        },
      );
    }

    fields.push(
      {
        kind: 'text',
        id: 'cloudflare.worker-cron',
        label: 'Worker cron',
        hint: 'Cron trigger installed on the Worker for batch scheduler ticks. Leave blank to skip cron automation.',
        placeholder: '*/5 * * * *',
        defaultValue: config?.workerCron || '*/5 * * * *',
      },
      {
        kind: 'text',
        id: 'cloudflare.max-queue-ops-per-day',
        label: 'Max queue ops per day',
        hint: 'Free-tier queue-operation budget used for local warnings.',
        placeholder: '10000',
        defaultValue: String(config?.maxQueueOpsPerDay ?? 10000),
      },
      {
        kind: 'radio',
        id: 'cloudflare.provision-on-apply',
        label: 'Provision Cloudflare on final apply',
        hint: 'If yes, final Apply calls SDK daemon routes to create/update resources and verify them. Failure is reported as a warning; settings still save.',
        options: CLOUDFLARE_PROVISION_OPTIONS,
        defaultValue: 'no',
      },
      {
        kind: 'status',
        id: 'cloudflare.action-status',
        label: 'Last Cloudflare daemon action',
        hint: resultMessage,
        defaultValue: resultMessage,
      },
      {
        kind: 'action',
        id: 'cloudflare.requirements',
        action: 'cloudflare-token-requirements',
        label: 'Show token requirements',
        hint: 'Calls the daemon SDK route and displays the required token permissions for the selected components.',
        defaultValue: 'Action',
      },
      {
        kind: 'action',
        id: 'cloudflare.create-token',
        action: 'cloudflare-create-operational-token',
        label: 'Create operational token from bootstrap token',
        hint: 'Uses a pasted or environment bootstrap token once. The SDK stores the generated operational token as a goodvibes:// secret.',
        defaultValue: 'Action',
      },
      {
        kind: 'action',
        id: 'cloudflare.discover',
        action: 'cloudflare-discover',
        label: 'Discover accounts, zones, and resources',
        hint: 'Calls the daemon SDK route using the configured or supplied token and summarizes discoverable Cloudflare resources.',
        defaultValue: 'Action',
      },
      {
        kind: 'action',
        id: 'cloudflare.validate',
        action: 'cloudflare-validate',
        label: 'Validate Cloudflare token',
        hint: 'Calls the daemon SDK route to validate account access with the configured or supplied token.',
        defaultValue: 'Action',
      },
      {
        kind: 'action',
        id: 'cloudflare.provision',
        action: 'cloudflare-provision',
        label: 'Provision and verify now',
        hint: 'Calls the daemon SDK route immediately with the current wizard values. This creates/updates selected Cloudflare resources.',
        defaultValue: 'Action',
      },
      {
        kind: 'action',
        id: 'cloudflare.verify',
        action: 'cloudflare-verify',
        label: 'Verify Worker now',
        hint: 'Calls the daemon SDK route to verify Worker health and daemon batch proxy readiness.',
        defaultValue: 'Action',
      },
      {
        kind: 'action',
        id: 'cloudflare.disable',
        action: 'cloudflare-disable',
        label: 'Disable Cloudflare integration',
        hint: 'Calls the daemon SDK route to disable local Cloudflare usage and return the batch queue backend to local behavior.',
        defaultValue: 'Action',
      },
    );
  }

  return {
    id: 'cloudflare',
    title: 'Cloudflare batch setup',
    shortLabel: 'Cloudflare',
    description: 'Optional Cloudflare Workers and Queues setup. GoodVibes uses local immediate daemon behavior unless Cloudflare and a batch mode are enabled.',
    summaryTitle: 'Cloudflare summary',
    summaryLines: [
      `Enabled: ${enabled ? 'yes' : 'no'}`,
      `Batch mode: ${enabled ? batchMode : 'off'}`,
      `Components: ${enabled ? componentCount : 0} selected`,
      `Token setup: ${enabled ? setupSource : 'not used'}`,
      `Provision on final apply: ${enabled ? controller.getStringFieldValue('cloudflare.provision-on-apply', 'no') : 'no'}`,
      ...(enabled && components.zeroTrustTunnel ? ['trustProxy: enabled for control plane and HTTP listener (see security notice)'] : []),
    ],
    fields,
  };
}

function cloudflareComponentHint(component: string): string {
  switch (component) {
    case 'workers':
      return 'Deploy the GoodVibes Worker used for batch signals and optional public ingress.';
    case 'queues':
      return 'Create Cloudflare Queue and dead-letter queue resources for batch job signals.';
    case 'zeroTrustTunnel':
      return 'Create or reuse a Cloudflare Tunnel so Cloudflare can reach the daemon through a controlled path.';
    case 'zeroTrustAccess':
      return 'Configure Cloudflare Access application/service-token protection around the daemon hostname.';
    case 'dns':
      return 'Create DNS records for selected custom hostnames. Requires a Cloudflare-managed zone.';
    case 'kv':
      return 'Create or reuse KV for optional Worker-side state.';
    case 'durableObjects':
      return 'Use Durable Objects for advanced Worker coordination where supported.';
    case 'secretsStore':
      return 'Create or reuse a Cloudflare Secrets Store for optional account-level secrets.';
    case 'r2':
      return 'Create or reuse an R2 Standard bucket for optional batch artifacts.';
    default:
      return 'Optional Cloudflare component.';
  }
}
