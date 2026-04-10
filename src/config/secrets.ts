/**
 * SecretsManager — hierarchy-aware secret resolution and persistence.
 *
 * Resolution order:
 *   1. Environment variable (process.env[key])
 *   2. Project/ancestor secure stores (.goodvibes/tui/secrets.enc), nearest first
 *   3. Project/ancestor plaintext stores (.goodvibes/goodvibes.secrets.json), nearest first
 *   4. User secure store (~/.goodvibes/tui/secrets.enc)
 *   5. User plaintext store (~/.goodvibes/goodvibes.secrets.json)
 *   6. If a resolved value is a SecretRef, resolve through the referenced provider
 *
 * The active policy decides whether plaintext stores are eligible:
 *   - plaintext_allowed  → read/write plaintext or secure
 *   - preferred_secure   → prefer secure, allow plaintext fallback with warning
 *   - require_secure     → never read/write plaintext
 *
 * Secret values are never logged.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { dirname, join, resolve } from 'path';
import { hostname, homedir, userInfo } from 'os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { ConfigManager } from './manager.ts';
import { getSecretRefSource, isSecretRefInput, resolveSecretRef } from './secret-refs.ts';
import { logger } from '../utils/logger.ts';

export type SecretStorageMode = 'plaintext_allowed' | 'preferred_secure' | 'require_secure';
export type SecretScope = 'project' | 'user';
export type SecretStorageMedium = 'secure' | 'plaintext';
export type SecretSource =
  | 'env'
  | 'project-secure'
  | 'project-plaintext'
  | 'user-secure'
  | 'user-plaintext';

export interface SecretRecord {
  readonly key: string;
  readonly source: SecretSource;
  readonly scope: SecretScope | 'env';
  readonly secure: boolean;
  readonly path?: string;
  readonly overriddenByEnv: boolean;
  readonly refSource?: string;
}

export interface SecretWriteOptions {
  readonly scope?: SecretScope;
  readonly medium?: SecretStorageMedium;
}

export interface SecretDeleteOptions {
  readonly scope?: SecretScope;
  readonly medium?: SecretStorageMedium;
}

export interface SecretStorageReview {
  readonly policy: SecretStorageMode;
  readonly secureAvailable: boolean;
  readonly storedKeys: number;
  readonly envBackedKeys: number;
  readonly secureKeys: number;
  readonly plaintextKeys: number;
  readonly warnings: readonly string[];
  readonly locations: readonly {
    readonly source: Exclude<SecretSource, 'env'>;
    readonly path: string;
    readonly exists: boolean;
    readonly readable: boolean;
  }[];
}

interface EncryptedStore {
  iv: string;
  tag: string;
  data: string;
}

interface PlaintextStore {
  readonly version: 1;
  readonly secrets: Record<string, string>;
}

interface SecretStorePath {
  readonly source: Exclude<SecretSource, 'env'>;
  readonly path: string;
  readonly secure: boolean;
  readonly scope: SecretScope;
}

export interface SecretsManagerOptions {
  readonly projectRoot?: string;
  readonly globalHome?: string;
  readonly policy?: SecretStorageMode;
  readonly secureProjectFilePath?: string;
  readonly secureUserFilePath?: string;
  readonly plaintextProjectFilePath?: string;
  readonly plaintextUserFilePath?: string;
}

function deriveEncryptionKey(): Buffer {
  const seed = hostname() + userInfo().username + 'goodvibes-secrets';
  return createHash('sha256').update(seed, 'utf8').digest();
}

function encrypt(plaintext: string, key: Buffer): EncryptedStore {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('hex'), tag: tag.toString('hex'), data: encrypted.toString('hex') };
}

function decrypt(store: EncryptedStore, key: Buffer): string {
  const iv = Buffer.from(store.iv, 'hex');
  const tag = Buffer.from(store.tag, 'hex');
  const data = Buffer.from(store.data, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

function loadConfiguredSecretPolicy(): SecretStorageMode {
  try {
    const manager = new ConfigManager();
    return (manager.get('storage.secretPolicy') as SecretStorageMode | undefined) ?? 'preferred_secure';
  } catch {
    return 'preferred_secure';
  }
}

function uniquePaths(paths: readonly SecretStorePath[]): SecretStorePath[] {
  const seen = new Set<string>();
  const ordered: SecretStorePath[] = [];
  for (const path of paths) {
    const key = `${path.source}:${path.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(path);
  }
  return ordered;
}

function collectAncestorRoots(start: string): string[] {
  const roots: string[] = [];
  let current = resolve(start);
  while (true) {
    roots.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

export class SecretsManager {
  private readonly encKey: Buffer;
  private readonly legacySecureProjectFilePath?: string;
  private readonly options: SecretsManagerOptions;

  constructor(pathOrOptions?: string | SecretsManagerOptions) {
    this.encKey = deriveEncryptionKey();
    if (typeof pathOrOptions === 'string') {
      this.legacySecureProjectFilePath = pathOrOptions;
      this.options = {
        projectRoot: process.cwd(),
        globalHome: homedir(),
      };
      return;
    }
    this.options = pathOrOptions ?? {
      projectRoot: process.cwd(),
      globalHome: homedir(),
    };
  }

  async get(key: string): Promise<string | null> {
    return this.getInternal(key, new Set([key]));
  }

  private async getInternal(key: string, seen: Set<string>): Promise<string | null> {
    const envValue = process.env[key];
    if (envValue !== undefined) {
      logger.debug('SecretsManager: resolved from env', { key });
      return this.resolveMaybeReferencedValue(key, envValue, seen);
    }

    for (const path of this.getReadOrder()) {
      const secrets = path.secure
        ? this.readEncryptedFile(path.path)
        : this.readPlaintextFile(path.path);
      if (secrets !== null && key in secrets) {
        logger.debug('SecretsManager: resolved from store', { key, source: path.source });
        const value = secrets[key];
        return value === undefined ? null : this.resolveMaybeReferencedValue(key, value, seen);
      }
    }

    return null;
  }

  private async resolveMaybeReferencedValue(key: string, value: string, seen: Set<string>): Promise<string | null> {
    if (!isSecretRefInput(value)) return value;

    try {
      const resolved = await resolveSecretRef(value, {
        resolveLocalSecret: async (nextKey) => {
          if (seen.has(nextKey)) {
            throw new Error(`Recursive GoodVibes secret reference for ${nextKey}`);
          }
          const nextSeen = new Set(seen);
          nextSeen.add(nextKey);
          return this.getInternal(nextKey, nextSeen);
        },
      });
      logger.debug('SecretsManager: resolved secret reference', { key, refSource: resolved.source });
      return resolved.value;
    } catch (error) {
      logger.warn('SecretsManager: failed to resolve secret reference', {
        key,
        refSource: getSecretRefSource(value) ?? 'unknown',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async set(key: string, value: string, options: SecretWriteOptions = {}): Promise<void> {
    const policy = this.getPolicy();
    const medium = options.medium ?? this.getDefaultWriteMedium(policy);
    const scope = options.scope ?? 'project';

    if (policy === 'require_secure' && medium === 'plaintext') {
      throw new Error('Secret policy require_secure forbids plaintext persistence');
    }

    const target = this.resolveWriteTarget(scope, medium);
    const existing = target.secure
      ? this.readEncryptedFile(target.path) ?? {}
      : this.readPlaintextFile(target.path) ?? {};
    existing[key] = value;

    try {
      if (target.secure) {
        this.writeEncryptedFile(target.path, existing);
      } else {
        this.writePlaintextFile(target.path, existing);
      }
      logger.debug('SecretsManager: stored secret', { key, source: target.source });
      return;
    } catch (error) {
      if (policy === 'preferred_secure' && target.secure) {
        const fallback = this.resolveWriteTarget(scope, 'plaintext');
        const fallbackExisting = this.readPlaintextFile(fallback.path) ?? {};
        fallbackExisting[key] = value;
        this.writePlaintextFile(fallback.path, fallbackExisting);
        logger.warn('SecretsManager: secure write failed, fell back to plaintext', {
          key,
          path: fallback.path,
          error: String(error),
        });
        return;
      }
      throw error;
    }
  }

  async list(): Promise<string[]> {
    const keys = new Set<string>();
    for (const path of this.getReadOrder()) {
      const values = path.secure
        ? this.readEncryptedFile(path.path)
        : this.readPlaintextFile(path.path);
      if (!values) continue;
      for (const key of Object.keys(values)) keys.add(key);
    }
    return [...keys].sort((a, b) => a.localeCompare(b));
  }

  async listDetailed(): Promise<SecretRecord[]> {
    const envKeys = new Set(Object.keys(process.env));
    const records: SecretRecord[] = [];

    for (const path of this.getReadOrder()) {
      const values = path.secure
        ? this.readEncryptedFile(path.path)
        : this.readPlaintextFile(path.path);
      if (!values) continue;
      for (const key of Object.keys(values)) {
        const refSource = getSecretRefSource(values[key]);
        records.push({
          key,
          source: path.source,
          scope: path.scope,
          secure: path.secure,
          path: path.path,
          overriddenByEnv: envKeys.has(key),
          ...(refSource ? { refSource } : {}),
        });
      }
    }

    for (const key of envKeys) {
      records.push({
        key,
        source: 'env',
        scope: 'env',
        secure: false,
        overriddenByEnv: false,
      });
    }

    return records.sort((a, b) => a.key.localeCompare(b.key) || a.source.localeCompare(b.source));
  }

  async inspect(): Promise<SecretStorageReview> {
    const policy = this.getPolicy();
    const records = await this.listDetailed();
    const storedRecords = records.filter((record) => record.source !== 'env');
    const locations = uniquePaths(this.getAllCandidateStores()).map((path) => ({
      source: path.source,
      path: path.path,
      exists: existsSync(path.path),
      readable: (path.secure ? this.readEncryptedFile(path.path) : this.readPlaintextFile(path.path)) !== null,
    }));
    const warnings: string[] = [];
    if (policy === 'preferred_secure' && storedRecords.some((record) => !record.secure)) {
      warnings.push('plaintext fallback secrets are present');
    }
    if (policy === 'require_secure' && storedRecords.some((record) => !record.secure)) {
      warnings.push('plaintext secrets exist but are ignored by current policy');
    }

    return {
      policy,
      secureAvailable: true,
      storedKeys: new Set(storedRecords.map((record) => record.key)).size,
      envBackedKeys: new Set(records.filter((record) => record.source === 'env').map((record) => record.key)).size,
      secureKeys: new Set(storedRecords.filter((record) => record.secure).map((record) => record.key)).size,
      plaintextKeys: new Set(storedRecords.filter((record) => !record.secure).map((record) => record.key)).size,
      warnings,
      locations,
    };
  }

  async delete(key: string, options: SecretDeleteOptions = {}): Promise<void> {
    const stores = this.getAllCandidateStores().filter((store) => {
      if (options.scope && store.scope !== options.scope) return false;
      if (options.medium && (options.medium === 'secure') !== store.secure) return false;
      return true;
    });

    for (const store of stores) {
      const values = store.secure
        ? this.readEncryptedFile(store.path)
        : this.readPlaintextFile(store.path);
      if (!values || !(key in values)) continue;
      delete values[key];
      if (store.secure) this.writeEncryptedFile(store.path, values);
      else this.writePlaintextFile(store.path, values);
      logger.debug('SecretsManager: deleted secret', { key, source: store.source });
    }
  }

  private getPolicy(): SecretStorageMode {
    return this.options.policy ?? loadConfiguredSecretPolicy();
  }

  private getDefaultWriteMedium(policy: SecretStorageMode): SecretStorageMedium {
    return policy === 'plaintext_allowed' ? 'plaintext' : 'secure';
  }

  private getReadOrder(): SecretStorePath[] {
    if (this.legacySecureProjectFilePath) {
      return [{
        source: 'project-secure',
        path: this.legacySecureProjectFilePath,
        secure: true,
        scope: 'project',
      }];
    }

    const policy = this.getPolicy();
    const includePlaintext = policy !== 'require_secure';
    const ordered: SecretStorePath[] = [];
    const projectRoot = this.options.projectRoot ?? process.cwd();
    const userHome = this.options.globalHome ?? homedir();

    for (const root of collectAncestorRoots(projectRoot)) {
      ordered.push({
        source: 'project-secure',
        path: join(root, '.goodvibes', 'tui', 'secrets.enc'),
        secure: true,
        scope: 'project',
      });
      if (includePlaintext) {
        ordered.push({
          source: 'project-plaintext',
          path: join(root, '.goodvibes', 'goodvibes.secrets.json'),
          secure: false,
          scope: 'project',
        });
      }
    }

    ordered.push({
      source: 'user-secure',
      path: this.options.secureUserFilePath ?? join(userHome, '.goodvibes', 'tui', 'secrets.enc'),
      secure: true,
      scope: 'user',
    });

    if (includePlaintext) {
      ordered.push({
        source: 'user-plaintext',
        path: this.options.plaintextUserFilePath ?? join(userHome, '.goodvibes', 'goodvibes.secrets.json'),
        secure: false,
        scope: 'user',
      });
    }

    return uniquePaths(ordered);
  }

  private getAllCandidateStores(): SecretStorePath[] {
    if (this.legacySecureProjectFilePath) {
      return [{
        source: 'project-secure',
        path: this.legacySecureProjectFilePath,
        secure: true,
        scope: 'project',
      }];
    }

    const projectRoot = this.options.projectRoot ?? process.cwd();
    const userHome = this.options.globalHome ?? homedir();
    const ordered: SecretStorePath[] = [];
    for (const root of collectAncestorRoots(projectRoot)) {
      ordered.push({
        source: 'project-secure',
        path: this.options.secureProjectFilePath ?? join(root, '.goodvibes', 'tui', 'secrets.enc'),
        secure: true,
        scope: 'project',
      });
      ordered.push({
        source: 'project-plaintext',
        path: this.options.plaintextProjectFilePath ?? join(root, '.goodvibes', 'goodvibes.secrets.json'),
        secure: false,
        scope: 'project',
      });
    }
    ordered.push({
      source: 'user-secure',
      path: this.options.secureUserFilePath ?? join(userHome, '.goodvibes', 'tui', 'secrets.enc'),
      secure: true,
      scope: 'user',
    });
    ordered.push({
      source: 'user-plaintext',
      path: this.options.plaintextUserFilePath ?? join(userHome, '.goodvibes', 'goodvibes.secrets.json'),
      secure: false,
      scope: 'user',
    });
    return uniquePaths(ordered);
  }

  private resolveWriteTarget(scope: SecretScope, medium: SecretStorageMedium): SecretStorePath {
    if (this.legacySecureProjectFilePath) {
      return {
        source: 'project-secure',
        path: this.legacySecureProjectFilePath,
        secure: true,
        scope: 'project',
      };
    }

    if (scope === 'project') {
      const root = this.options.projectRoot ?? process.cwd();
      return medium === 'secure'
        ? {
          source: 'project-secure',
          path: this.options.secureProjectFilePath ?? join(root, '.goodvibes', 'tui', 'secrets.enc'),
          secure: true,
          scope,
        }
        : {
          source: 'project-plaintext',
          path: this.options.plaintextProjectFilePath ?? join(root, '.goodvibes', 'goodvibes.secrets.json'),
          secure: false,
          scope,
        };
    }

    const userHome = this.options.globalHome ?? homedir();
    return medium === 'secure'
      ? {
        source: 'user-secure',
        path: this.options.secureUserFilePath ?? join(userHome, '.goodvibes', 'tui', 'secrets.enc'),
        secure: true,
        scope,
      }
      : {
        source: 'user-plaintext',
        path: this.options.plaintextUserFilePath ?? join(userHome, '.goodvibes', 'goodvibes.secrets.json'),
        secure: false,
        scope,
      };
  }

  private readEncryptedFile(filePath: string): Record<string, string> | null {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const store: EncryptedStore = JSON.parse(raw);
      return JSON.parse(decrypt(store, this.encKey)) as Record<string, string>;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.error('SecretsManager: failed to read encrypted store', { path: filePath });
      }
      return null;
    }
  }

  private writeEncryptedFile(filePath: string, secrets: Record<string, string>): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const plaintext = JSON.stringify(secrets);
    const store = encrypt(plaintext, this.encKey);
    writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
  }

  private readPlaintextFile(filePath: string): Record<string, string> | null {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') return null;
      if ('version' in parsed && 'secrets' in parsed) {
        const secrets = (parsed as PlaintextStore).secrets;
        return secrets && typeof secrets === 'object' ? secrets : null;
      }
      return parsed as Record<string, string>;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.error('SecretsManager: failed to read plaintext store', { path: filePath });
      }
      return null;
    }
  }

  private writePlaintextFile(filePath: string, secrets: Record<string, string>): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const payload: PlaintextStore = { version: 1, secrets };
    writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  }
}

let _secretsManager: SecretsManager | undefined;

export function getSecretsManager(options?: SecretsManagerOptions): SecretsManager {
  if (!_secretsManager || options) {
    _secretsManager = new SecretsManager(options);
  }
  return _secretsManager;
}

export function _resetSecretsManagerForTesting(): void {
  _secretsManager = undefined;
}
