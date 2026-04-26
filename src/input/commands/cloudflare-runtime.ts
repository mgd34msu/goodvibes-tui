import {
  CLOUDFLARE_COMPONENT_IDS,
  CLOUDFLARE_COMPONENT_LABELS,
  DEFAULT_CLOUDFLARE_COMPONENT_SELECTION,
  CloudflareDaemonRouteError,
  createCloudflareDaemonClient,
  type CloudflareComponent,
  type CloudflareComponentSelection,
  type CloudflareDaemonClient,
  type CloudflareProvisionStep,
} from '../../runtime/cloudflare-control-plane.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';

interface ParsedCloudflareArgs {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, readonly string[]>;
}

export function registerCloudflareRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'cloudflare',
    aliases: ['cf'],
    description: 'Inspect and manage optional Cloudflare batch/control-plane integration through daemon SDK routes',
    usage: '[status|setup|requirements|create-token|discover|validate|provision|verify|disable] [flags]',
    async handler(args, ctx) {
      const subcommand = (args[0] ?? 'status').toLowerCase();
      const parsed = parseCloudflareArgs(args.slice(1));
      if (subcommand === 'setup' || subcommand === 'onboarding') {
        ctx.openOnboardingWizard?.({ mode: 'edit', reset: true });
        ctx.print('Opening onboarding wizard. Select the Cloudflare batch capability to configure Cloudflare.');
        return;
      }

      let client: CloudflareDaemonClient;
      try {
        client = createCloudflareClient(ctx);
      } catch (error) {
        ctx.print(`Cloudflare command unavailable: ${formatCloudflareError(error)}`);
        return;
      }

      try {
        if (subcommand === 'status' || subcommand === 'show') {
          const status = await client.status();
          ctx.print([
            'Cloudflare Status',
            `  enabled: ${status.enabled ? 'yes' : 'no'}`,
            `  ready: ${status.ready ? 'yes' : 'no'}`,
            `  account: ${status.config.accountId || '(not set)'}`,
            `  token ref: ${status.config.apiTokenRef || '(CLOUDFLARE_API_TOKEN fallback)'}`,
            `  worker: ${status.config.workerName || '(not set)'}`,
            `  worker URL: ${status.config.workerBaseUrl || '(not set)'}`,
            `  queue: ${status.config.queueName || '(not set)'}`,
            `  DLQ: ${status.config.deadLetterQueueName || '(not set)'}`,
            `  batch mode: ${String(ctx.platform.configManager.get('batch.mode') ?? 'off')}`,
            `  queue backend: ${String(ctx.platform.configManager.get('batch.queueBackend') ?? 'local')}`,
            ...status.warnings.map((warning) => `  warning: ${warning}`),
          ].join('\n'));
          return;
        }

        if (subcommand === 'requirements') {
          const result = await client.tokenRequirements({
            components: componentsFromArgs(parsed),
            includeBootstrap: true,
          });
          ctx.print([
            'Cloudflare Token Requirements',
            `  components: ${formatComponents(result.components)}`,
            '  permissions:',
            ...result.permissions.map((permission) => `    ${permission.scope}: ${permission.permission} (${permission.component}) - ${permission.reason}`),
            ...(result.bootstrapToken.instructions.length > 0
              ? ['  bootstrap token:', ...result.bootstrapToken.instructions.map((line) => `    ${line}`)]
              : []),
          ].join('\n'));
          return;
        }

        if (subcommand === 'create-token') {
          const bootstrapToken = getFlag(parsed, 'bootstrap-token') || readTokenEnv(parsed, 'bootstrap-env');
          if (!bootstrapToken) {
            ctx.print('Usage: /cloudflare create-token --account <account-id> --bootstrap-token <token> or --bootstrap-env <env-name>');
            return;
          }
          const result = await client.createOperationalToken({
            components: componentsFromArgs(parsed),
            ...optionalString('accountId', getFlag(parsed, 'account') || getFlag(parsed, 'account-id')),
            ...optionalString('zoneId', getFlag(parsed, 'zone-id')),
            ...optionalString('zoneName', getFlag(parsed, 'zone') || getFlag(parsed, 'zone-name')),
            bootstrapToken,
            storeApiToken: true,
            persistConfig: true,
          });
          ctx.print([
            'Cloudflare Operational Token Created',
            `  token: ${result.tokenName}${result.tokenId ? ` (${result.tokenId})` : ''}`,
            `  account: ${result.accountId}`,
            `  zone: ${result.zoneId || '(none)'}`,
            `  stored ref: ${result.apiTokenRef ?? '(not stored)'}`,
            '  revoke or expire the temporary bootstrap token after validation.',
          ].join('\n'));
          return;
        }

        if (subcommand === 'discover') {
          const result = await client.discover({
            ...cloudflareAuthInput(parsed),
            components: componentsFromArgs(parsed),
            ...optionalString('zoneId', getFlag(parsed, 'zone-id')),
            ...optionalString('zoneName', getFlag(parsed, 'zone') || getFlag(parsed, 'zone-name')),
            includeResources: !hasFlag(parsed, 'fast'),
          });
          ctx.print([
            'Cloudflare Discovery',
            `  token source: ${result.tokenSource}`,
            `  accounts: ${result.accounts.length}`,
            ...result.accounts.slice(0, 12).map((account) => `    account ${account.id}: ${account.name}`),
            `  zones: ${result.zones.length}`,
            ...result.zones.slice(0, 12).map((zone) => `    zone ${zone.id}: ${zone.name}${zone.status ? ` (${zone.status})` : ''}`),
            `  worker subdomain: ${result.workerSubdomain || '(not detected)'}`,
            `  queues: ${result.queues?.length ?? 0}`,
            `  KV namespaces: ${result.kvNamespaces?.length ?? 0}`,
            `  R2 buckets: ${result.r2Buckets?.length ?? 0}`,
            ...result.warnings.map((warning) => `  warning: ${warning}`),
          ].join('\n'));
          return;
        }

        if (subcommand === 'validate') {
          const result = await client.validate(cloudflareAuthInput(parsed));
          ctx.print([
            'Cloudflare Token Validation',
            `  ok: ${result.ok ? 'yes' : 'no'}`,
            `  token source: ${result.tokenSource}`,
            result.account ? `  account: ${result.account.name} (${result.account.id})` : '  account: not resolved',
          ].join('\n'));
          return;
        }

        if (subcommand === 'provision') {
          const result = await client.provision({
            ...cloudflareAuthInput(parsed),
            components: componentsFromArgs(parsed),
            ...optionalString('accountId', getFlag(parsed, 'account') || getFlag(parsed, 'account-id')),
            ...optionalString('zoneId', getFlag(parsed, 'zone-id')),
            ...optionalString('zoneName', getFlag(parsed, 'zone') || getFlag(parsed, 'zone-name')),
            ...optionalString('daemonBaseUrl', getFlag(parsed, 'daemon-url')),
            ...optionalString('daemonHostname', getFlag(parsed, 'daemon-hostname')),
            ...optionalString('workerName', getFlag(parsed, 'worker-name')),
            ...optionalString('workerSubdomain', getFlag(parsed, 'worker-subdomain')),
            ...optionalString('workerHostname', getFlag(parsed, 'worker-hostname')),
            ...optionalString('workerBaseUrl', getFlag(parsed, 'worker-url')),
            ...optionalString('queueName', getFlag(parsed, 'queue') || getFlag(parsed, 'queue-name')),
            ...optionalString('deadLetterQueueName', getFlag(parsed, 'dlq') || getFlag(parsed, 'dead-letter-queue')),
            ...optionalBatchMode(readBatchMode(parsed)),
            persistConfig: true,
            verify: !hasFlag(parsed, 'no-verify'),
            storeApiToken: !hasFlag(parsed, 'no-store-token'),
            enableWorkersDev: !hasFlag(parsed, 'no-workers-dev'),
          });
          ctx.print([
            'Cloudflare Provisioning',
            `  ok: ${result.ok ? 'yes' : 'no'}`,
            ...(result.worker ? [`  worker: ${result.worker.name}${result.worker.baseUrl ? ` at ${result.worker.baseUrl}` : ''}`] : []),
            ...(result.queues ? [`  queues: ${result.queues.queueName}; DLQ ${result.queues.deadLetterQueueName}`] : []),
            ...formatProvisionSteps(result.steps),
          ].join('\n'));
          return;
        }

        if (subcommand === 'verify') {
          const result = await client.verify({
            ...optionalString('workerBaseUrl', getFlag(parsed, 'worker-url')),
            ...optionalString('workerClientToken', getFlag(parsed, 'worker-token')),
            ...optionalString('workerClientTokenRef', getFlag(parsed, 'worker-token-ref')),
          });
          ctx.print([
            'Cloudflare Verification',
            `  ok: ${result.ok ? 'yes' : 'no'}`,
            `  worker health: ${result.workerHealth.ok ? 'ok' : 'failed'} (HTTP ${result.workerHealth.status})${result.workerHealth.error ? ` - ${result.workerHealth.error}` : ''}`,
            ...(result.daemonBatchProxy ? [`  daemon batch proxy: ${result.daemonBatchProxy.ok ? 'ok' : 'failed'} (HTTP ${result.daemonBatchProxy.status})${result.daemonBatchProxy.error ? ` - ${result.daemonBatchProxy.error}` : ''}`] : []),
          ].join('\n'));
          return;
        }

        if (subcommand === 'disable') {
          const result = await client.disable({
            ...cloudflareAuthInput(parsed),
            ...optionalString('workerName', getFlag(parsed, 'worker-name')),
            disableWorkerSubdomain: hasFlag(parsed, 'disable-worker-subdomain'),
            disableCron: !hasFlag(parsed, 'keep-cron'),
            persistConfig: true,
          });
          ctx.print([
            'Cloudflare Disabled',
            `  ok: ${result.ok ? 'yes' : 'no'}`,
            ...formatProvisionSteps(result.steps),
          ].join('\n'));
          return;
        }

        ctx.print('Usage: /cloudflare [status|setup|requirements|create-token|discover|validate|provision|verify|disable] [flags]');
      } catch (error) {
        ctx.print(`Cloudflare ${subcommand} failed: ${formatCloudflareError(error)}`);
      }
    },
  });
}

function createCloudflareClient(ctx: CommandContext): CloudflareDaemonClient {
  const shellPaths = requireShellPaths(ctx);
  return createCloudflareDaemonClient({
    configManager: ctx.platform.configManager,
    homeDirectory: shellPaths.homeDirectory,
  });
}

function parseCloudflareArgs(args: readonly string[]): ParsedCloudflareArgs {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    const equalsIndex = raw.indexOf('=');
    if (equalsIndex >= 0) {
      const key = raw.slice(0, equalsIndex);
      const value = raw.slice(equalsIndex + 1);
      flags.set(key, [...(flags.get(key) ?? []), value]);
      continue;
    }
    const next = args[index + 1];
    if (next && !next.startsWith('--')) {
      flags.set(raw, [...(flags.get(raw) ?? []), next]);
      index += 1;
    } else {
      flags.set(raw, [...(flags.get(raw) ?? []), 'true']);
    }
  }
  return { positional, flags };
}

function hasFlag(args: ParsedCloudflareArgs, key: string): boolean {
  return args.flags.has(key);
}

function getFlag(args: ParsedCloudflareArgs, key: string): string {
  const values = args.flags.get(key);
  const value = values?.[values.length - 1] ?? '';
  return value === 'true' ? '' : value.trim();
}

function getFlagValues(args: ParsedCloudflareArgs, key: string): readonly string[] {
  return args.flags.get(key)?.map((value) => value.trim()).filter(Boolean) ?? [];
}

function componentsFromArgs(args: ParsedCloudflareArgs): Record<CloudflareComponent, boolean> {
  const components: Record<CloudflareComponent, boolean> = { ...DEFAULT_CLOUDFLARE_COMPONENT_SELECTION };
  if (hasFlag(args, 'all') || hasFlag(args, 'advanced')) {
    for (const component of CLOUDFLARE_COMPONENT_IDS) components[component] = true;
  }
  for (const raw of [...args.positional, ...getFlagValues(args, 'component')]) {
    const normalized = normalizeComponent(raw);
    if (normalized) components[normalized] = true;
  }
  for (const raw of getFlagValues(args, 'no-component')) {
    const normalized = normalizeComponent(raw);
    if (normalized) components[normalized] = false;
  }
  return components;
}

function normalizeComponent(value: string): CloudflareComponent | null {
  const normalized = value.trim().toLowerCase().replace(/[-_]/g, '');
  for (const component of CLOUDFLARE_COMPONENT_IDS) {
    if (component.toLowerCase() === normalized) return component;
  }
  if (normalized === 'workerscript' || normalized === 'worker') return 'workers';
  if (normalized === 'queue') return 'queues';
  if (normalized === 'tunnel') return 'zeroTrustTunnel';
  if (normalized === 'access') return 'zeroTrustAccess';
  if (normalized === 'domain' || normalized === 'hostname') return 'dns';
  if (normalized === 'do' || normalized === 'durableobject') return 'durableObjects';
  if (normalized === 'secret' || normalized === 'secrets') return 'secretsStore';
  return null;
}

function formatComponents(components: CloudflareComponentSelection): string {
  const selected = CLOUDFLARE_COMPONENT_IDS
    .filter((component) => components[component] === true)
    .map((component) => CLOUDFLARE_COMPONENT_LABELS[component]);
  return selected.length > 0 ? selected.join(', ') : 'none';
}

function cloudflareAuthInput(args: ParsedCloudflareArgs): {
  readonly accountId?: string;
  readonly apiToken?: string;
  readonly apiTokenRef?: string;
} {
  const token = getFlag(args, 'token') || readTokenEnv(args, 'token-env');
  const tokenRef = getFlag(args, 'token-ref');
  return {
    ...optionalString('accountId', getFlag(args, 'account') || getFlag(args, 'account-id')),
    ...(token ? { apiToken: token } : tokenRef ? { apiTokenRef: tokenRef } : {}),
  };
}

function readTokenEnv(args: ParsedCloudflareArgs, key: string): string {
  const envName = getFlag(args, key);
  if (!envName) return '';
  return process.env[envName] ?? '';
}

function readBatchMode(args: ParsedCloudflareArgs): 'off' | 'explicit' | 'eligible-by-default' | undefined {
  const value = getFlag(args, 'batch-mode');
  if (value === 'off' || value === 'explicit' || value === 'eligible-by-default') return value;
  return undefined;
}

function optionalString<K extends string>(key: K, value: string): Partial<Record<K, string>> {
  return value.trim().length > 0 ? { [key]: value.trim() } as Partial<Record<K, string>> : {};
}

function optionalBatchMode(value: ReturnType<typeof readBatchMode>): { readonly batchMode?: 'off' | 'explicit' | 'eligible-by-default' } {
  return value ? { batchMode: value } : {};
}

function formatProvisionSteps(steps: readonly CloudflareProvisionStep[]): string[] {
  return steps.length > 0
    ? steps.map((step) => `  ${step.status}: ${step.name}${step.message ? ` - ${step.message}` : ''}`)
    : ['  no steps returned'];
}

function formatCloudflareError(error: unknown): string {
  if (error instanceof CloudflareDaemonRouteError) {
    return `${error.message} (HTTP ${error.status}, ${error.code})`;
  }
  return error instanceof Error ? error.message : String(error);
}
