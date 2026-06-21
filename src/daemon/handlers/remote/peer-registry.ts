import { HandlerSqliteStore } from '../sqlite-store.ts';
import {
  isSecretReferenceValue,
  isMalformedGoodVibesSecretReferenceValue,
} from '../../../config/secret-config.ts';

// ---------------------------------------------------------------------------
// Backend vocabulary + per-backend config shapes
// ---------------------------------------------------------------------------

export type BackendKind = 'docker' | 'ssh' | 'cloud-terminal' | 'local-process';

export type CloudProvider = 'gcp' | 'aws' | 'azure';

export interface DockerBackendConfig {
  containerName: string;
  /**
   * Optional Docker host. When it points at a remote daemon over TLS this MUST
   * be a goodvibes://secrets/ reference (never a raw URL with embedded creds).
   * A bare local socket path (unix://...) or tcp host without credentials is
   * also accepted.
   */
  dockerHost?: string;
}

export interface SshBackendConfig {
  sshHost: string;
  sshPort?: number;
  sshUser: string;
  /** goodvibes://secrets/ reference to the private key — never the raw key. */
  identityRef: string;
}

export interface CloudTerminalBackendConfig {
  provider: CloudProvider;
  projectId?: string;
  /** goodvibes://secrets/ reference to the provider credential. */
  credentialRef: string;
  /** Optional zone/region/location passed to the provider CLI. */
  location?: string;
  /** For gcp: the Cloud Shell / VM instance to target. */
  instance?: string;
}

export interface LocalProcessBackendConfig {
  /** Optional working directory for spawned processes. */
  cwd?: string;
  /** Optional allowlist of executables; when set, only these may be invoked. */
  allowedCommands?: string[];
}

export type BackendConfig =
  | ({ kind: 'docker' } & DockerBackendConfig)
  | ({ kind: 'ssh' } & SshBackendConfig)
  | ({ kind: 'cloud-terminal' } & CloudTerminalBackendConfig)
  | ({ kind: 'local-process' } & LocalProcessBackendConfig);

export interface PeerRecord {
  peerId: string;
  displayName: string;
  backendKind: BackendKind;
  backendConfig: BackendConfig;
}

export interface PeerRegistrationInput {
  peerId: string;
  displayName: string;
  backendKind: BackendKind;
  // Raw, untrusted config from the operator method body. Normalized + validated.
  backendConfig: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Validation helpers — backendConfig must hold ONLY secret refs for any
// credential-bearing field. Raw secrets are rejected outright.
// ---------------------------------------------------------------------------

class PeerRegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeerRegistryValidationError';
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PeerRegistryValidationError(`Field '${field}' is required and must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new PeerRegistryValidationError(`Field '${field}' must be a string when provided.`);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function requireSecretRef(value: unknown, field: string): string {
  const ref = requireString(value, field);
  if (!isSecretReferenceValue(ref)) {
    throw new PeerRegistryValidationError(
      `Field '${field}' must be a goodvibes://secrets/ reference, not a raw credential.`,
    );
  }
  return ref;
}

function assertDockerHostSafe(value: string | undefined, field: string): void {
  // A dockerHost is accepted in exactly two shapes, mirroring how docker.ts
  // resolves it (docker.ts: `startsWith('goodvibes://') ? resolveRef(...) : raw`):
  //   1. A goodvibes://secrets/ reference — resolved from the credential store.
  //   2. A credential-free local/plain address (unix:// socket, or a bare
  //      tcp/host with no embedded userinfo) — used verbatim.
  // Enforcement here must match that resolution so no credential-bearing or
  // unresolvable value slips through to docker.ts.
  if (value === undefined) return;

  // A valid secret ref is always allowed: docker.ts resolves it from the store.
  if (isSecretReferenceValue(value)) return;

  // A `goodvibes://` value that is NOT a well-formed secret ref would be handed
  // to credentials.resolveRef() and fail opaquely (REMOTE_BACKEND_CREDENTIAL_MISSING)
  // — or, worse, a near-miss could be treated as a literal host. Reject it at
  // registration so the misconfiguration surfaces immediately.
  if (isMalformedGoodVibesSecretReferenceValue(value)) {
    throw new PeerRegistryValidationError(
      `Field '${field}' looks like a goodvibes:// reference but is malformed; use a valid goodvibes://secrets/ reference.`,
    );
  }

  // Embedded userinfo credentials (e.g. tcp://user:pass@host) must never be
  // stored raw — docker.ts would pass them verbatim as DOCKER_HOST.
  if (value.includes('@')) {
    throw new PeerRegistryValidationError(
      `Field '${field}' appears to embed credentials; pass a goodvibes://secrets/ reference instead.`,
    );
  }

  // A remote daemon reached over TLS carries its credentials out-of-band and
  // MUST be referenced through the credential store, never pinned as a raw
  // host string the daemon would use unauthenticated. docker.ts only treats a
  // goodvibes:// value as a secret, so a raw `https://`/`tcp+tls://` endpoint
  // here would bypass credential resolution entirely.
  const lowered = value.toLowerCase();
  if (lowered.startsWith('https://') || lowered.startsWith('tcp+tls://')) {
    throw new PeerRegistryValidationError(
      `Field '${field}' points at a TLS Docker daemon; pass a goodvibes://secrets/ reference instead of a raw URL.`,
    );
  }
}

/** Normalize + validate raw backendConfig into a typed, ref-only BackendConfig. */
export function normalizeBackendConfig(
  backendKind: BackendKind,
  raw: Record<string, unknown>,
): BackendConfig {
  switch (backendKind) {
    case 'docker': {
      const dockerHost = optionalString(raw.dockerHost, 'dockerHost');
      assertDockerHostSafe(dockerHost, 'dockerHost');
      return {
        kind: 'docker',
        containerName: requireString(raw.containerName, 'containerName'),
        ...(dockerHost !== undefined ? { dockerHost } : {}),
      };
    }
    case 'ssh': {
      const portValue = raw.sshPort;
      let sshPort: number | undefined;
      if (portValue !== undefined && portValue !== null) {
        const parsed = typeof portValue === 'number' ? portValue : Number(portValue);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
          throw new PeerRegistryValidationError("Field 'sshPort' must be an integer between 1 and 65535.");
        }
        sshPort = parsed;
      }
      return {
        kind: 'ssh',
        sshHost: requireString(raw.sshHost, 'sshHost'),
        sshUser: requireString(raw.sshUser, 'sshUser'),
        identityRef: requireSecretRef(raw.identityRef, 'identityRef'),
        ...(sshPort !== undefined ? { sshPort } : {}),
      };
    }
    case 'cloud-terminal': {
      const provider = requireString(raw.provider, 'provider');
      if (provider !== 'gcp' && provider !== 'aws' && provider !== 'azure') {
        throw new PeerRegistryValidationError("Field 'provider' must be one of 'gcp' | 'aws' | 'azure'.");
      }
      const projectId = optionalString(raw.projectId, 'projectId');
      const location = optionalString(raw.location, 'location');
      const instance = optionalString(raw.instance, 'instance');
      return {
        kind: 'cloud-terminal',
        provider,
        credentialRef: requireSecretRef(raw.credentialRef, 'credentialRef'),
        ...(projectId !== undefined ? { projectId } : {}),
        ...(location !== undefined ? { location } : {}),
        ...(instance !== undefined ? { instance } : {}),
      };
    }
    case 'local-process': {
      const cwd = optionalString(raw.cwd, 'cwd');
      let allowedCommands: string[] | undefined;
      if (raw.allowedCommands !== undefined && raw.allowedCommands !== null) {
        if (!Array.isArray(raw.allowedCommands)) {
          throw new PeerRegistryValidationError("Field 'allowedCommands' must be an array of strings.");
        }
        const list = raw.allowedCommands
          .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
          .filter((entry) => entry.length > 0);
        allowedCommands = list;
      }
      return {
        kind: 'local-process',
        ...(cwd !== undefined ? { cwd } : {}),
        ...(allowedCommands !== undefined ? { allowedCommands } : {}),
      };
    }
    default:
      throw new PeerRegistryValidationError(`Unknown backendKind: ${String(backendKind)}`);
  }
}

// ---------------------------------------------------------------------------
// Peer registry — persisted via HandlerSqliteStore (peer-registry.sqlite)
// ---------------------------------------------------------------------------

const PEER_REGISTRY_FILE = 'peer-registry.sqlite';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS peers (
     peerId TEXT PRIMARY KEY,
     displayName TEXT NOT NULL,
     backendKind TEXT NOT NULL,
     backendConfig TEXT NOT NULL
   )`,
];

interface PeerRow {
  peerId: string;
  displayName: string;
  backendKind: string;
  backendConfig: string;
}

const VALID_BACKEND_KINDS: ReadonlySet<BackendKind> = new Set([
  'docker',
  'ssh',
  'cloud-terminal',
  'local-process',
]);

function rowToRecord(row: PeerRow): PeerRecord {
  const backendKind = row.backendKind as BackendKind;
  const parsed = JSON.parse(row.backendConfig) as BackendConfig;
  return {
    peerId: row.peerId,
    displayName: row.displayName,
    backendKind,
    backendConfig: parsed,
  };
}

export class PeerRegistry {
  private readonly store: HandlerSqliteStore;
  private initialized = false;

  constructor(workingDirectory: string) {
    this.store = new HandlerSqliteStore({
      workingDirectory,
      fileName: PEER_REGISTRY_FILE,
      schema: SCHEMA,
    });
  }

  get dbPath(): string {
    return this.store.dbPath;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.store.init();
    this.initialized = true;
  }

  private requireInit(): void {
    if (!this.initialized) {
      throw new Error('PeerRegistry not initialized: call init() first.');
    }
  }

  /** Register (upsert) a peer. Validates + normalizes backendConfig to refs-only. */
  async register(input: PeerRegistrationInput): Promise<PeerRecord> {
    this.requireInit();
    const peerId = requireString(input.peerId, 'peerId');
    const displayName = requireString(input.displayName, 'displayName');
    if (!VALID_BACKEND_KINDS.has(input.backendKind)) {
      throw new PeerRegistryValidationError(`Unknown backendKind: ${String(input.backendKind)}`);
    }
    const backendConfig = normalizeBackendConfig(input.backendKind, input.backendConfig ?? {});
    const serialized = JSON.stringify(backendConfig);
    this.store.run(
      `INSERT INTO peers (peerId, displayName, backendKind, backendConfig)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(peerId) DO UPDATE SET
         displayName = excluded.displayName,
         backendKind = excluded.backendKind,
         backendConfig = excluded.backendConfig`,
      [peerId, displayName, input.backendKind, serialized],
    );
    await this.store.save();
    return { peerId, displayName, backendKind: input.backendKind, backendConfig };
  }

  /** Look up a peer by id. Returns null when not registered. */
  get(peerId: string): PeerRecord | null {
    this.requireInit();
    const row = this.store.get<PeerRow>(
      'SELECT peerId, displayName, backendKind, backendConfig FROM peers WHERE peerId = ?',
      [peerId],
    );
    return row ? rowToRecord(row) : null;
  }

  /** List all registered peers (config included; contains only secret refs). */
  list(): PeerRecord[] {
    this.requireInit();
    const rows = this.store.all<PeerRow>(
      'SELECT peerId, displayName, backendKind, backendConfig FROM peers ORDER BY peerId ASC',
    );
    return rows.map(rowToRecord);
  }

  /** Remove a peer. Returns true when a row was deleted. */
  async remove(peerId: string): Promise<boolean> {
    this.requireInit();
    const existed = this.get(peerId) !== null;
    if (existed) {
      this.store.run('DELETE FROM peers WHERE peerId = ?', [peerId]);
      await this.store.save();
    }
    return existed;
  }

  close(): void {
    if (this.initialized) {
      this.store.close();
      this.initialized = false;
    }
  }
}

export { PeerRegistryValidationError };
