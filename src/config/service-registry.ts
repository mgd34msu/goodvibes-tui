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
 *   "github":  { "name": "github",  "baseUrl": "https://api.github.com",  "authType": "bearer", "tokenKey": "GITHUB_TOKEN" },
 *   "slack":   { "name": "slack", "authType": "bearer", "tokenKey": "SLACK_BOT_TOKEN", "tokenRef": { "source": "vaultwarden", "item": "GoodVibes Slack", "field": "password", "server": "https://vault.example.test" } }
 * }
 */

import { readFileSync } from 'fs';
import { SecretsManager } from './secrets.ts';
import {
  describeSecretRef,
  isSecretRefInput,
  resolveSecretRef,
  type SecretRefInput,
} from '@pellux/goodvibes-sdk/platform/config/secret-refs';
import type { OAuthProviderConfig } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

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
  /** Optional external/local secret reference for the primary credential. */
  tokenRef?: SecretRefInput;
  /** For basic auth: SecretsManager key that holds the password. */
  passwordKey?: string;
  /** Optional external/local secret reference for the basic-auth password. */
  passwordRef?: SecretRefInput;
  /** For api-key auth: the header name. Defaults to X-API-Key. */
  apiKeyHeader?: string;
  /** Optional secret key holding a webhook or callback URL for this service. */
  webhookUrlKey?: string;
  /** Optional external/local secret reference for a webhook or callback URL. */
  webhookUrlRef?: SecretRefInput;
  /** Optional secret key for inbound request signing/verification. */
  signingSecretKey?: string;
  /** Optional external/local secret reference for inbound request signing/verification. */
  signingSecretRef?: SecretRefInput;
  /** Optional public-key secret used for inbound signature verification. */
  publicKeyKey?: string;
  /** Optional external/local secret reference for inbound public-key verification. */
  publicKeyRef?: SecretRefInput;
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

export interface ServiceRegistryOptions {
  readonly secretsManager: SecretsManager;
  readonly subscriptionManager: SubscriptionManager;
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
  private readonly secretsManager: SecretsManager;
  private readonly subscriptionManager: SubscriptionManager;

  constructor(servicesFilePath: string, options: ServiceRegistryOptions) {
    this.servicesFilePath = servicesFilePath;
    this.secretsManager = options.secretsManager;
    this.subscriptionManager = options.subscriptionManager;
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

  private async resolveConfiguredSecret(
    serviceName: string,
    field: ServiceSecretField,
    keyOrRef?: string,
    ref?: SecretRefInput,
  ): Promise<string | null> {
    const candidate = ref ?? (keyOrRef && isSecretRefInput(keyOrRef) ? keyOrRef : undefined);
    if (candidate) {
      try {
        const resolved = await resolveSecretRef(candidate, {
          resolveLocalSecret: (key) => this.secretsManager.get(key),
          homeDirectory: this.secretsManager.getGlobalHome?.() ?? undefined,
        });
        return resolved.value;
      } catch (error) {
        logger.warn('ServiceRegistry: failed to resolve secret reference', {
          serviceName,
          field,
          ref: describeSecretRef(candidate),
          error: summarizeError(error),
        });
        return null;
      }
    }

    return keyOrRef ? this.secretsManager.get(keyOrRef) : null;
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

    const providerOverride = this.subscriptionManager.getAccessToken(config.providerId ?? serviceName);
    if (providerOverride) {
      return { Authorization: `Bearer ${providerOverride}` };
    }

    switch (config.authType) {
      case 'bearer': {
        const token = await this.resolveConfiguredSecret(serviceName, 'primary', config.tokenKey, config.tokenRef);
        if (!token) {
          logger.debug('ServiceRegistry: bearer token not found', { serviceName, key: config.tokenKey });
          return null;
        }
        return { Authorization: `Bearer ${token}` };
      }

      case 'basic': {
        const username = await this.resolveConfiguredSecret(serviceName, 'primary', config.tokenKey, config.tokenRef);
        const password = await this.resolveConfiguredSecret(serviceName, 'password', config.passwordKey, config.passwordRef);
        if (!username) {
          logger.debug('ServiceRegistry: basic username not found', { serviceName, key: config.tokenKey });
          return null;
        }
        const encoded = Buffer.from(`${username}:${password ?? ''}`).toString('base64');
        return { Authorization: `Basic ${encoded}` };
      }

      case 'api-key': {
        const key = await this.resolveConfiguredSecret(serviceName, 'primary', config.tokenKey, config.tokenRef);
        if (!key) {
          logger.debug('ServiceRegistry: api key not found', { serviceName, key: config.tokenKey });
          return null;
        }
        const headerName = config.apiKeyHeader ?? 'X-API-Key';
        return { [headerName]: key };
      }

      case 'oauth': {
        const token = await this.resolveConfiguredSecret(serviceName, 'primary', config.tokenKey, config.tokenRef);
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

    switch (field) {
      case 'primary':
        return this.resolveConfiguredSecret(serviceName, field, config.tokenKey, config.tokenRef);
      case 'password':
        return this.resolveConfiguredSecret(serviceName, field, config.passwordKey, config.passwordRef);
      case 'webhookUrl':
        return this.resolveConfiguredSecret(serviceName, field, config.webhookUrlKey, config.webhookUrlRef);
      case 'signingSecret':
        return this.resolveConfiguredSecret(serviceName, field, config.signingSecretKey, config.signingSecretRef);
      case 'publicKey':
        return this.resolveConfiguredSecret(serviceName, field, config.publicKeyKey, config.publicKeyRef);
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
        const message = summarizeError(error);
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
