/**
 * ServiceRegistry — named service credential resolution.
 *
 * Reads service configs from .goodvibes/tui/services.json.
 * Each service entry declares its authType and the SecretsManager key
 * that holds the credential.
 *
 * Example services.json:
 * {
 *   "openai": { "name": "openai", "baseUrl": "https://api.openai.com", "authType": "bearer", "tokenKey": "OPENAI_API_KEY" },
 *   "github":  { "name": "github",  "baseUrl": "https://api.github.com",  "authType": "bearer", "tokenKey": "GITHUB_TOKEN" }
 * }
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { getSecretsManager } from './secrets.ts';
import type { OAuthProviderConfig } from './subscriptions.ts';
import { getSubscriptionManager } from './subscriptions.ts';
import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServiceConfig {
  /** Human-readable / lookup name. */
  name: string;
  /** Base URL for the service (informational). */
  baseUrl?: string;
  /** Auth type used by this service. */
  authType: 'bearer' | 'basic' | 'api-key' | 'oauth';
  /** SecretsManager key that holds the primary credential (token or API key). */
  tokenKey: string;
  /** For basic auth: SecretsManager key that holds the password. */
  passwordKey?: string;
  /** For api-key auth: the header name. Defaults to X-API-Key. */
  apiKeyHeader?: string;
  /** Optional secret key holding a webhook or callback URL for this service. */
  webhookUrlKey?: string;
  /** Optional secret key for inbound request signing/verification. */
  signingSecretKey?: string;
  /** Optional public-key secret used for inbound signature verification. */
  publicKeyKey?: string;
  /** Optional provider ID used for subscription token override lookup. */
  providerId?: string;
  /** OAuth metadata for subscription-backed services. */
  oauth?: OAuthProviderConfig;
}

export type ServiceSecretField =
  | 'primary'
  | 'password'
  | 'webhookUrl'
  | 'signingSecret'
  | 'publicKey';

export interface ServiceInspection {
  readonly config: ServiceConfig;
  readonly hasPrimaryCredential: boolean;
  readonly hasPasswordCredential: boolean;
  readonly hasWebhookUrl: boolean;
  readonly hasSigningSecret: boolean;
  readonly hasPublicKey: boolean;
}

export interface ServiceConnectionTestResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly testedUrl: string | null;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getServicesFilePath(): string {
  return join(process.cwd(), '.goodvibes', 'tui', 'services.json');
}

function readServicesFile(filePath: string): Record<string, ServiceConfig> {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, ServiceConfig>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.error('ServiceRegistry: failed to read services file — treating as empty', {
        path: filePath,
      });
    }
    return {};
  }
}

// ---------------------------------------------------------------------------
// ServiceRegistry
// ---------------------------------------------------------------------------

export class ServiceRegistry {
  private readonly servicesFilePath: string;

  constructor(servicesFilePath?: string) {
    this.servicesFilePath = servicesFilePath ?? getServicesFilePath();
  }

  /**
   * Return all registered service configs.
   */
  getAll(): Record<string, ServiceConfig> {
    return readServicesFile(this.servicesFilePath);
  }

  /**
   * Return the config for a named service, or null if not found.
   */
  get(serviceName: string): ServiceConfig | null {
    const all = this.getAll();
    return all[serviceName] ?? null;
  }

  /**
   * Resolve auth headers for a named service.
   * Looks up the service config, fetches credential from SecretsManager,
   * and returns the appropriate HTTP headers.
   *
   * Returns null if the service is not registered or credential is unavailable.
   */
  async resolveAuth(serviceName: string): Promise<Record<string, string> | null> {
    const config = this.get(serviceName);
    if (!config) {
      logger.debug('ServiceRegistry: unknown service', { serviceName });
      return null;
    }

    const secrets = getSecretsManager();
    const providerOverride = getSubscriptionManager().getAccessToken(config.providerId ?? serviceName);
    if (providerOverride) {
      return { Authorization: `Bearer ${providerOverride}` };
    }

    switch (config.authType) {
      case 'bearer': {
        const token = await secrets.get(config.tokenKey);
        if (!token) {
          logger.debug('ServiceRegistry: bearer token not found', { serviceName, key: config.tokenKey });
          return null;
        }
        return { Authorization: `Bearer ${token}` };
      }

      case 'basic': {
        const username = await secrets.get(config.tokenKey);
        const password = config.passwordKey ? await secrets.get(config.passwordKey) : null;
        if (!username) {
          logger.debug('ServiceRegistry: basic username not found', { serviceName, key: config.tokenKey });
          return null;
        }
        const encoded = Buffer.from(`${username}:${password ?? ''}`).toString('base64');
        return { Authorization: `Basic ${encoded}` };
      }

      case 'api-key': {
        const key = await secrets.get(config.tokenKey);
        if (!key) {
          logger.debug('ServiceRegistry: api key not found', { serviceName, key: config.tokenKey });
          return null;
        }
        const headerName = config.apiKeyHeader ?? 'X-API-Key';
        return { [headerName]: key };
      }

      case 'oauth': {
        const token = await secrets.get(config.tokenKey);
        if (!token) {
          logger.debug('ServiceRegistry: oauth token not found', { serviceName, key: config.tokenKey });
          return null;
        }
        return { Authorization: `Bearer ${token}` };
      }

      default:
        return null;
    }
  }

  async resolveSecret(
    serviceName: string,
    field: ServiceSecretField,
  ): Promise<string | null> {
    const config = this.get(serviceName);
    if (!config) return null;

    const secrets = getSecretsManager();
    switch (field) {
      case 'primary':
        return secrets.get(config.tokenKey);
      case 'password':
        return config.passwordKey ? secrets.get(config.passwordKey) : null;
      case 'webhookUrl':
        return config.webhookUrlKey ? secrets.get(config.webhookUrlKey) : null;
      case 'signingSecret':
        return config.signingSecretKey ? secrets.get(config.signingSecretKey) : null;
      case 'publicKey':
        return config.publicKeyKey ? secrets.get(config.publicKeyKey) : null;
    }
  }

  async inspect(serviceName: string): Promise<ServiceInspection | null> {
    const config = this.get(serviceName);
    if (!config) return null;

    const [
      primary,
      password,
      webhookUrl,
      signingSecret,
      publicKey,
    ] = await Promise.all([
      this.resolveSecret(serviceName, 'primary'),
      this.resolveSecret(serviceName, 'password'),
      this.resolveSecret(serviceName, 'webhookUrl'),
      this.resolveSecret(serviceName, 'signingSecret'),
      this.resolveSecret(serviceName, 'publicKey'),
    ]);

    return {
      config,
      hasPrimaryCredential: primary !== null && primary.length > 0,
      hasPasswordCredential: password !== null && password.length > 0,
      hasWebhookUrl: webhookUrl !== null && webhookUrl.length > 0,
      hasSigningSecret: signingSecret !== null && signingSecret.length > 0,
      hasPublicKey: publicKey !== null && publicKey.length > 0,
    };
  }

  async testConnection(serviceName: string): Promise<ServiceConnectionTestResult> {
    const config = this.get(serviceName);
    if (!config) {
      return { ok: false, status: null, testedUrl: null, error: 'Unknown service' };
    }

    const baseUrl = config.baseUrl?.trim() ?? '';
    if (!baseUrl) {
      return { ok: false, status: null, testedUrl: null, error: 'No baseUrl configured' };
    }

    const headers = await this.resolveAuth(serviceName);
    const reqHeaders: Record<string, string> = {
      Accept: 'application/json',
      ...(headers ?? {}),
    };
    const candidates = [
      `${baseUrl.replace(/\/$/, '')}/health`,
      baseUrl.replace(/\/$/, ''),
    ];

    for (const url of candidates) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: reqHeaders,
          signal: AbortSignal.timeout(5000),
        });
        return {
          ok: response.ok,
          status: response.status,
          testedUrl: url,
          ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug('ServiceRegistry: service test failed', { serviceName, url, error: message });
      }
    }

    return {
      ok: false,
      status: null,
      testedUrl: candidates[candidates.length - 1] ?? null,
      error: 'Connection failed',
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _serviceRegistry: ServiceRegistry | undefined;

export function getServiceRegistry(): ServiceRegistry {
  if (!_serviceRegistry) _serviceRegistry = new ServiceRegistry();
  return _serviceRegistry;
}

/**
 * Resolve auth headers for a named service using the singleton registry.
 * Convenience wrapper for use in the fetch tool.
 */
export async function resolveServiceAuth(
  serviceName: string,
): Promise<Record<string, string> | null> {
  return getServiceRegistry().resolveAuth(serviceName);
}

/** Reset singleton — for testing only. */
export function _resetServiceRegistryForTesting(): void {
  _serviceRegistry = undefined;
}
