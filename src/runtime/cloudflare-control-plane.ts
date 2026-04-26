import { join } from 'node:path';
import { getOrCreateCompanionToken } from '@pellux/goodvibes-sdk/platform/pairing/companion-token';
import type { ConfigManager } from '../config/index.ts';

export const CLOUDFLARE_COMPONENT_IDS = [
  'workers',
  'queues',
  'zeroTrustTunnel',
  'zeroTrustAccess',
  'dns',
  'kv',
  'durableObjects',
  'secretsStore',
  'r2',
] as const;

export type CloudflareComponent = typeof CLOUDFLARE_COMPONENT_IDS[number];
export type CloudflareComponentSelection = Partial<Record<CloudflareComponent, boolean>>;
export type CloudflareBatchMode = 'off' | 'explicit' | 'eligible-by-default';

export const DEFAULT_CLOUDFLARE_COMPONENT_SELECTION: Readonly<Record<CloudflareComponent, boolean>> = {
  workers: true,
  queues: true,
  zeroTrustTunnel: false,
  zeroTrustAccess: false,
  dns: false,
  kv: false,
  durableObjects: false,
  secretsStore: false,
  r2: false,
};

export const CLOUDFLARE_COMPONENT_LABELS: Readonly<Record<CloudflareComponent, string>> = {
  workers: 'Workers',
  queues: 'Queues',
  zeroTrustTunnel: 'Zero Trust Tunnel',
  zeroTrustAccess: 'Zero Trust Access',
  dns: 'DNS hostname',
  kv: 'KV',
  durableObjects: 'Durable Objects',
  secretsStore: 'Secrets Store',
  r2: 'R2 artifacts',
};

export interface CloudflareProvisionStep {
  readonly name: string;
  readonly status: 'ok' | 'skipped' | 'warning';
  readonly message?: string;
  readonly resourceId?: string;
}

export interface CloudflareControlPlaneStatus {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly configured: Record<string, boolean>;
  readonly config: Record<string, unknown>;
  readonly warnings: readonly string[];
}

export interface CloudflareTokenRequirement {
  readonly component: CloudflareComponent | 'bootstrap';
  readonly scope: 'account' | 'zone' | 'user' | 'r2';
  readonly permission: string;
  readonly alternatives?: readonly string[];
  readonly reason: string;
}

export interface CloudflareTokenRequirementsResult {
  readonly ok: true;
  readonly components: Readonly<Record<CloudflareComponent, boolean>>;
  readonly permissions: readonly CloudflareTokenRequirement[];
  readonly bootstrapToken: {
    readonly requiredForSdkCreation: boolean;
    readonly storeInGoodVibes: false;
    readonly instructions: readonly string[];
  };
}

export interface CloudflareValidateResult {
  readonly ok: boolean;
  readonly account?: {
    readonly id: string;
    readonly name: string;
    readonly type?: string;
  };
  readonly tokenSource: string;
}

export interface CloudflareOperationalTokenResult {
  readonly ok: true;
  readonly tokenId?: string;
  readonly tokenName: string;
  readonly tokenSource: 'bootstrap';
  readonly apiTokenRef?: string;
  readonly generatedToken?: string;
  readonly accountId: string;
  readonly zoneId?: string;
  readonly permissions: readonly CloudflareTokenRequirement[];
}

export interface CloudflareDiscoverResult {
  readonly ok: true;
  readonly tokenSource: string;
  readonly accounts: ReadonlyArray<{ readonly id: string; readonly name: string; readonly type?: string }>;
  readonly selectedAccount?: { readonly id: string; readonly name: string; readonly type?: string };
  readonly zones: ReadonlyArray<{ readonly id: string; readonly name: string; readonly status?: string; readonly type?: string }>;
  readonly selectedZone?: { readonly id: string; readonly name: string; readonly status?: string; readonly type?: string };
  readonly workerSubdomain?: string;
  readonly queues?: ReadonlyArray<{ readonly queue_id?: string; readonly queue_name?: string }>;
  readonly kvNamespaces?: ReadonlyArray<{ readonly id?: string; readonly title?: string }>;
  readonly durableObjectNamespaces?: ReadonlyArray<{ readonly id?: string; readonly name?: string; readonly class?: string }>;
  readonly r2Buckets?: ReadonlyArray<{ readonly name?: string; readonly storage_class?: string }>;
  readonly secretsStores?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly tunnels?: ReadonlyArray<{ readonly id?: string; readonly name?: string; readonly status?: string }>;
  readonly accessApplications?: ReadonlyArray<{ readonly id?: string; readonly name?: string; readonly domain?: string; readonly type?: string }>;
  readonly warnings: readonly string[];
}

export interface CloudflareProvisionResult {
  readonly ok: boolean;
  readonly dryRun: false;
  readonly steps: readonly CloudflareProvisionStep[];
  readonly account?: { readonly id: string; readonly name: string };
  readonly worker?: { readonly name: string; readonly baseUrl?: string; readonly subdomain?: string; readonly hostname?: string; readonly cron?: string };
  readonly queues?: { readonly queueName: string; readonly queueId: string; readonly deadLetterQueueName: string; readonly deadLetterQueueId: string; readonly consumerId?: string };
  readonly verification?: CloudflareVerifyResult;
}

export interface CloudflareVerifyResult {
  readonly ok: boolean;
  readonly workerHealth: {
    readonly ok: boolean;
    readonly status: number;
    readonly error?: string;
  };
  readonly daemonBatchProxy?: {
    readonly ok: boolean;
    readonly status: number;
    readonly error?: string;
  };
}

export interface CloudflareDisableResult {
  readonly ok: boolean;
  readonly steps: readonly CloudflareProvisionStep[];
}

export interface CloudflareTokenRequirementsRequest {
  readonly components?: CloudflareComponentSelection;
  readonly includeBootstrap?: boolean;
}

export interface CloudflareOperationalTokenRequest extends CloudflareTokenRequirementsRequest {
  readonly accountId?: string;
  readonly zoneId?: string;
  readonly zoneName?: string;
  readonly bootstrapToken?: string;
  readonly tokenName?: string;
  readonly expiresOn?: string;
  readonly persistConfig?: boolean;
  readonly storeApiToken?: boolean;
  readonly returnGeneratedToken?: boolean;
}

export interface CloudflareValidateRequest {
  readonly accountId?: string;
  readonly apiToken?: string;
  readonly apiTokenRef?: string;
}

export interface CloudflareDiscoverRequest extends CloudflareValidateRequest {
  readonly components?: CloudflareComponentSelection;
  readonly zoneId?: string;
  readonly zoneName?: string;
  readonly includeResources?: boolean;
}

export interface CloudflareProvisionRequest extends CloudflareDiscoverRequest {
  readonly workerName?: string;
  readonly workerSubdomain?: string;
  readonly workerHostname?: string;
  readonly workerBaseUrl?: string;
  readonly daemonBaseUrl?: string;
  readonly daemonHostname?: string;
  readonly queueName?: string;
  readonly deadLetterQueueName?: string;
  readonly tunnelName?: string;
  readonly tunnelId?: string;
  readonly tunnelServiceUrl?: string;
  readonly kvNamespaceName?: string;
  readonly kvNamespaceId?: string;
  readonly durableObjectNamespaceName?: string;
  readonly durableObjectNamespaceId?: string;
  readonly r2BucketName?: string;
  readonly secretsStoreName?: string;
  readonly secretsStoreId?: string;
  readonly workerCron?: string;
  readonly operatorToken?: string;
  readonly operatorTokenRef?: string;
  readonly workerClientToken?: string;
  readonly workerClientTokenRef?: string;
  readonly storeApiToken?: boolean;
  readonly storeOperatorToken?: boolean;
  readonly storeWorkerClientToken?: boolean;
  readonly returnGeneratedSecrets?: boolean;
  readonly enableWorkersDev?: boolean;
  readonly queueJobPayloads?: boolean;
  readonly verify?: boolean;
  readonly persistConfig?: boolean;
  readonly batchMode?: CloudflareBatchMode;
}

export interface CloudflareVerifyRequest {
  readonly workerBaseUrl?: string;
  readonly workerClientToken?: string;
  readonly workerClientTokenRef?: string;
}

export interface CloudflareDisableRequest extends CloudflareValidateRequest {
  readonly workerName?: string;
  readonly disableWorkerSubdomain?: boolean;
  readonly disableCron?: boolean;
  readonly persistConfig?: boolean;
}

export class CloudflareDaemonRouteError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'CloudflareDaemonRouteError';
    this.status = status;
    this.code = code;
  }
}

export interface CloudflareDaemonClient {
  status(): Promise<CloudflareControlPlaneStatus>;
  tokenRequirements(input?: CloudflareTokenRequirementsRequest): Promise<CloudflareTokenRequirementsResult>;
  createOperationalToken(input: CloudflareOperationalTokenRequest): Promise<CloudflareOperationalTokenResult>;
  discover(input?: CloudflareDiscoverRequest): Promise<CloudflareDiscoverResult>;
  validate(input?: CloudflareValidateRequest): Promise<CloudflareValidateResult>;
  provision(input: CloudflareProvisionRequest): Promise<CloudflareProvisionResult>;
  verify(input?: CloudflareVerifyRequest): Promise<CloudflareVerifyResult>;
  disable(input?: CloudflareDisableRequest): Promise<CloudflareDisableResult>;
}

export interface CloudflareDaemonClientOptions {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly homeDirectory: string;
}

function connectHostForBindHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host.trim().length === 0) return '127.0.0.1';
  return host;
}

function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function resolveCloudflareDaemonBaseUrl(configManager: Pick<ConfigManager, 'get'>): string {
  const configuredBaseUrl = String(configManager.get('controlPlane.baseUrl' as never) ?? '').trim();
  if (configuredBaseUrl) return configuredBaseUrl.replace(/\/+$/, '');
  const host = hostForUrl(connectHostForBindHost(String(configManager.get('controlPlane.host' as never) ?? '127.0.0.1')));
  const portValue = Number(configManager.get('controlPlane.port' as never) ?? 3421);
  const port = Number.isFinite(portValue) && portValue > 0 ? portValue : 3421;
  return `http://${host}:${port}`;
}

export function buildDefaultCloudflareDaemonBaseUrl(configManager: Pick<ConfigManager, 'get'>): string {
  return resolveCloudflareDaemonBaseUrl(configManager);
}

function readDaemonToken(homeDirectory: string): string {
  const daemonHomeDir = join(homeDirectory, '.goodvibes', 'daemon');
  return getOrCreateCompanionToken('tui', { daemonHomeDir }).token;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text.trim().length > 0 ? JSON.parse(text) as unknown : {};
  if (!response.ok) {
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const message = typeof record.error === 'string' ? record.error : `Cloudflare daemon route failed with HTTP ${response.status}`;
    const code = typeof record.code === 'string' ? record.code : 'CLOUDFLARE_DAEMON_ROUTE_ERROR';
    throw new CloudflareDaemonRouteError(message, response.status, code);
  }
  return body as T;
}

export function createCloudflareDaemonClient(options: CloudflareDaemonClientOptions): CloudflareDaemonClient {
  const baseUrl = resolveCloudflareDaemonBaseUrl(options.configManager);
  const token = readDaemonToken(options.homeDirectory);

  const requestJson = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    return await readJsonResponse<T>(response);
  };

  const postJson = <T>(path: string, body: unknown): Promise<T> => requestJson<T>(path, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  });

  return {
    status: () => requestJson<CloudflareControlPlaneStatus>('/api/cloudflare/status'),
    tokenRequirements: (input = {}) => postJson<CloudflareTokenRequirementsResult>('/api/cloudflare/token/requirements', input),
    createOperationalToken: (input) => postJson<CloudflareOperationalTokenResult>('/api/cloudflare/token/create', input),
    discover: (input = {}) => postJson<CloudflareDiscoverResult>('/api/cloudflare/discover', input),
    validate: (input = {}) => postJson<CloudflareValidateResult>('/api/cloudflare/validate', input),
    provision: (input) => postJson<CloudflareProvisionResult>('/api/cloudflare/provision', input),
    verify: (input = {}) => postJson<CloudflareVerifyResult>('/api/cloudflare/verify', input),
    disable: (input = {}) => postJson<CloudflareDisableResult>('/api/cloudflare/disable', input),
  };
}

export function normalizeCloudflareComponents(selection: CloudflareComponentSelection | undefined): Record<CloudflareComponent, boolean> {
  const result: Record<CloudflareComponent, boolean> = { ...DEFAULT_CLOUDFLARE_COMPONENT_SELECTION };
  for (const component of CLOUDFLARE_COMPONENT_IDS) {
    if (typeof selection?.[component] === 'boolean') result[component] = selection[component] === true;
  }
  return result;
}
