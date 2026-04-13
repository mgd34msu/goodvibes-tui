import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

export type SecretProviderSource =
  | 'env'
  | 'goodvibes'
  | 'file'
  | 'exec'
  | '1password'
  | 'onepassword'
  | 'bitwarden'
  | 'vaultwarden'
  | 'bitwarden-secrets-manager'
  | 'bws';

export type BitwardenSecretField =
  | 'password'
  | 'username'
  | 'notes'
  | 'totp'
  | 'item'
  | `login.${string}`
  | string;

export interface EnvSecretRef {
  readonly source: 'env';
  readonly id: string;
}

export interface GoodVibesSecretRef {
  readonly source: 'goodvibes';
  readonly id: string;
}

export interface FileSecretRef {
  readonly source: 'file';
  readonly path: string;
  readonly selector?: string;
}

export interface ExecSecretRef {
  readonly source: 'exec';
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

export interface OnePasswordSecretRef {
  readonly source: '1password' | 'onepassword';
  readonly ref?: string;
  readonly vault?: string;
  readonly item?: string;
  readonly field?: string;
  readonly account?: string;
  readonly cli?: string;
  readonly timeoutMs?: number;
}

export interface BitwardenSecretRef {
  readonly source: 'bitwarden' | 'vaultwarden';
  readonly item: string;
  readonly field?: BitwardenSecretField;
  readonly customField?: string;
  readonly cli?: string;
  readonly appDataDir?: string;
  readonly sessionEnv?: string;
  readonly server?: string;
  readonly serverEnv?: string;
  readonly validateServer?: boolean;
  readonly syncBeforeRead?: boolean;
  readonly timeoutMs?: number;
}

export interface BitwardenSecretsManagerRef {
  readonly source: 'bitwarden-secrets-manager' | 'bws';
  readonly id: string;
  readonly field?: string;
  readonly cli?: string;
  readonly accessTokenEnv?: string;
  readonly accessToken?: string;
  readonly profile?: string;
  readonly configFile?: string;
  readonly serverUrl?: string;
  readonly timeoutMs?: number;
}

export type SecretRef =
  | EnvSecretRef
  | GoodVibesSecretRef
  | FileSecretRef
  | ExecSecretRef
  | OnePasswordSecretRef
  | BitwardenSecretRef
  | BitwardenSecretsManagerRef;

export type SecretRefInput = string | SecretRef;

export interface SecretCommandRunOptions {
  readonly env?: Record<string, string>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

export interface SecretCommandRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type SecretCommandRunner = (
  command: string,
  args: readonly string[],
  options?: SecretCommandRunOptions,
) => Promise<SecretCommandRunResult>;

export interface SecretRefResolutionOptions {
  readonly resolveLocalSecret?: (key: string) => Promise<string | null>;
  readonly runCommand?: SecretCommandRunner;
  readonly homeDirectory?: string;
}

export interface SecretRefResolution {
  readonly source: SecretProviderSource;
  readonly value: string | null;
}

export const BUILTIN_SECRET_PROVIDER_SOURCES: readonly SecretProviderSource[] = [
  'env',
  'goodvibes',
  'file',
  'exec',
  '1password',
  'bitwarden',
  'vaultwarden',
  'bitwarden-secrets-manager',
];

const JSON_REF_PREFIX = 'secretref:';
const SECRET_URI_PREFIX = 'secret://';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') return undefined;
    result[key] = entry;
  }
  return result;
}

function expandUserPath(path: string, homeDirectory: string | undefined): string {
  if (path === '~' || path.startsWith('~/')) {
    if (!homeDirectory) {
      throw new Error('Secret reference expansion requires an explicit homeDirectory.');
    }
    if (path === '~') return homeDirectory;
    return resolvePath(homeDirectory, path.slice(2));
  }
  return path;
}

function normalizeSource(source: string): SecretProviderSource | null {
  const normalized = source.trim().toLowerCase();
  if (normalized === 'op') return '1password';
  if (normalized === 'one-password') return '1password';
  if (normalized === 'bitwarden-sm') return 'bitwarden-secrets-manager';
  if (normalized === 'bitwarden-secrets') return 'bitwarden-secrets-manager';
  if (normalized === 'bws') return 'bws';
  if (BUILTIN_SECRET_PROVIDER_SOURCES.includes(normalized as SecretProviderSource)) {
    return normalized as SecretProviderSource;
  }
  if (normalized === 'onepassword') return 'onepassword';
  return null;
}

function parseJsonRef(value: string): SecretRef | null {
  if (!value.startsWith(JSON_REF_PREFIX)) return null;
  const raw = value.slice(JSON_REF_PREFIX.length).trim();
  if (!raw) return null;
  try {
    return normalizeSecretRef(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseProviderUri(value: string): SecretRef | null {
  if (value.startsWith('op://')) {
    return { source: '1password', ref: value };
  }

  if (!value.startsWith(SECRET_URI_PREFIX) && !value.startsWith('bw://') && !value.startsWith('vaultwarden://') && !value.startsWith('bws://')) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = decodeURIComponent(url.hostname);
  const segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));

  if (url.protocol === 'bw:') {
    if (!host) return null;
    return {
      source: 'bitwarden',
      item: host,
      field: segments[0] ?? url.searchParams.get('field') ?? 'password',
      customField: url.searchParams.get('customField') ?? undefined,
      server: url.searchParams.get('server') ?? undefined,
      serverEnv: url.searchParams.get('serverEnv') ?? undefined,
      appDataDir: url.searchParams.get('appDataDir') ?? undefined,
      sessionEnv: url.searchParams.get('sessionEnv') ?? undefined,
    };
  }

  if (url.protocol === 'vaultwarden:') {
    if (!host) return null;
    return {
      source: 'vaultwarden',
      item: host,
      field: segments[0] ?? url.searchParams.get('field') ?? 'password',
      customField: url.searchParams.get('customField') ?? undefined,
      server: url.searchParams.get('server') ?? undefined,
      serverEnv: url.searchParams.get('serverEnv') ?? undefined,
      appDataDir: url.searchParams.get('appDataDir') ?? undefined,
      sessionEnv: url.searchParams.get('sessionEnv') ?? undefined,
    };
  }

  if (url.protocol === 'bws:') {
    if (!host) return null;
    return {
      source: 'bws',
      id: host,
      field: segments[0] ?? url.searchParams.get('field') ?? 'value',
      profile: url.searchParams.get('profile') ?? undefined,
      configFile: url.searchParams.get('configFile') ?? undefined,
      serverUrl: url.searchParams.get('serverUrl') ?? undefined,
      accessTokenEnv: url.searchParams.get('accessTokenEnv') ?? undefined,
    };
  }

  const source = normalizeSource(host);
  if (!source) return null;
  const first = segments[0];

  if (source === 'env') {
    return first ? { source: 'env', id: first } : null;
  }
  if (source === 'goodvibes') {
    return first ? { source: 'goodvibes', id: first } : null;
  }
  if (source === 'file') {
    const path = decodeURIComponent(url.pathname).replace(/^\/+/, '/');
    return path ? { source: 'file', path, selector: url.searchParams.get('selector') ?? undefined } : null;
  }
  if (source === 'bitwarden' || source === 'vaultwarden') {
    if (!first) return null;
    return {
      source,
      item: first,
      field: segments[1] ?? url.searchParams.get('field') ?? 'password',
      customField: url.searchParams.get('customField') ?? undefined,
      server: url.searchParams.get('server') ?? undefined,
      serverEnv: url.searchParams.get('serverEnv') ?? undefined,
      appDataDir: url.searchParams.get('appDataDir') ?? undefined,
      sessionEnv: url.searchParams.get('sessionEnv') ?? undefined,
    };
  }
  if (source === 'bws' || source === 'bitwarden-secrets-manager') {
    if (!first) return null;
    return {
      source,
      id: first,
      field: segments[1] ?? url.searchParams.get('field') ?? 'value',
      profile: url.searchParams.get('profile') ?? undefined,
      configFile: url.searchParams.get('configFile') ?? undefined,
      serverUrl: url.searchParams.get('serverUrl') ?? undefined,
      accessTokenEnv: url.searchParams.get('accessTokenEnv') ?? undefined,
    };
  }
  return null;
}

export function normalizeSecretRef(input: unknown): SecretRef | null {
  if (typeof input === 'string') {
    const value = input.trim();
    if (!value) return null;
    return parseJsonRef(value) ?? parseProviderUri(value);
  }

  const raw = asRecord(input);
  if (!raw) return null;
  const rawSource = readString(raw.source ?? raw.provider ?? raw.type);
  if (!rawSource) return null;
  const source = normalizeSource(rawSource);
  if (!source) return null;

  if (source === 'env') {
    const id = readString(raw.id ?? raw.key ?? raw.name);
    return id ? { source: 'env', id } : null;
  }

  if (source === 'goodvibes') {
    const id = readString(raw.id ?? raw.key ?? raw.name);
    return id ? { source: 'goodvibes', id } : null;
  }

  if (source === 'file') {
    const path = readString(raw.path);
    return path ? { source: 'file', path, selector: readString(raw.selector ?? raw.jsonPointer ?? raw.field) } : null;
  }

  if (source === 'exec') {
    const command = readString(raw.command);
    return command
      ? {
          source: 'exec',
          command,
          args: readStringArray(raw.args),
          env: readStringRecord(raw.env),
          stdin: readString(raw.stdin),
          timeoutMs: readNumber(raw.timeoutMs),
        }
      : null;
  }

  if (source === '1password' || source === 'onepassword') {
    const ref = readString(raw.ref ?? raw.uri);
    const vault = readString(raw.vault);
    const item = readString(raw.item ?? raw.id);
    const field = readString(raw.field);
    if (!ref && (!vault || !item || !field)) return null;
    return {
      source,
      ref,
      vault,
      item,
      field,
      account: readString(raw.account),
      cli: readString(raw.cli),
      timeoutMs: readNumber(raw.timeoutMs),
    };
  }

  if (source === 'bitwarden' || source === 'vaultwarden') {
    const item = readString(raw.item ?? raw.id ?? raw.name);
    if (!item) return null;
    return {
      source,
      item,
      field: readString(raw.field) ?? 'password',
      customField: readString(raw.customField),
      cli: readString(raw.cli),
      appDataDir: readString(raw.appDataDir),
      sessionEnv: readString(raw.sessionEnv),
      server: readString(raw.server ?? raw.serverUrl),
      serverEnv: readString(raw.serverEnv),
      validateServer: readBoolean(raw.validateServer),
      syncBeforeRead: readBoolean(raw.syncBeforeRead),
      timeoutMs: readNumber(raw.timeoutMs),
    };
  }

  if (source === 'bitwarden-secrets-manager' || source === 'bws') {
    const id = readString(raw.id ?? raw.secretId ?? raw.secret);
    if (!id) return null;
    return {
      source,
      id,
      field: readString(raw.field) ?? 'value',
      cli: readString(raw.cli),
      accessTokenEnv: readString(raw.accessTokenEnv),
      accessToken: readString(raw.accessToken),
      profile: readString(raw.profile),
      configFile: readString(raw.configFile),
      serverUrl: readString(raw.serverUrl),
      timeoutMs: readNumber(raw.timeoutMs),
    };
  }

  return null;
}

export function isSecretRefInput(input: unknown): input is SecretRefInput {
  return normalizeSecretRef(input) !== null;
}

export function getSecretRefSource(input: unknown): SecretProviderSource | null {
  return normalizeSecretRef(input)?.source ?? null;
}

export function describeSecretRef(input: unknown): string {
  const ref = normalizeSecretRef(input);
  if (!ref) return 'not-a-secret-ref';
  switch (ref.source) {
    case 'env':
      return `env:${ref.id}`;
    case 'goodvibes':
      return `goodvibes:${ref.id}`;
    case 'file':
      return `file:${ref.path}${ref.selector ? `#${ref.selector}` : ''}`;
    case 'exec':
      return `exec:${ref.command}`;
    case '1password':
    case 'onepassword':
      return ref.ref ?? `1password:${ref.vault}/${ref.item}/${ref.field}`;
    case 'bitwarden':
      return `bitwarden:${ref.item}/${ref.customField ?? ref.field ?? 'password'}`;
    case 'vaultwarden':
      return `vaultwarden:${ref.item}/${ref.customField ?? ref.field ?? 'password'}`;
    case 'bitwarden-secrets-manager':
    case 'bws':
      return `bws:${ref.id}/${ref.field ?? 'value'}`;
  }
}

function stripFinalNewline(value: string): string {
  return value.replace(/\r?\n$/, '');
}

async function defaultRunCommand(
  command: string,
  args: readonly string[],
  options: SecretCommandRunOptions = {},
): Promise<SecretCommandRunResult> {
  const proc = Bun.spawn([command, ...args], {
    env: { ...process.env, ...(options.env ?? {}) },
    stdin: options.stdin === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (options.stdin !== undefined && proc.stdin) {
    proc.stdin.write(options.stdin);
    proc.stdin.end();
  }

  let timedOut = false;
  const timeout = options.timeoutMs && options.timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, options.timeoutMs)
    : undefined;
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (timedOut) {
      return { exitCode: exitCode || 124, stdout, stderr: stderr || 'command timed out' };
    }
    return { exitCode, stdout, stderr };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runChecked(
  ref: SecretRef,
  command: string,
  args: readonly string[],
  options: SecretRefResolutionOptions,
  runOptions: SecretCommandRunOptions = {},
): Promise<string> {
  const runner = options.runCommand ?? defaultRunCommand;
  const result = await runner(command, args, runOptions);
  if (result.exitCode !== 0) {
    throw new Error(`Secret provider ${ref.source} command failed with exit ${result.exitCode}`);
  }
  return stripFinalNewline(result.stdout);
}

function selectPath(value: unknown, selector: string): unknown {
  if (!selector) return value;
  if (selector.startsWith('/')) {
    const segments = selector.split('/').slice(1).map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
    let current = value;
    for (const segment of segments) {
      if (Array.isArray(current)) current = current[Number(segment)];
      else if (current && typeof current === 'object') current = (current as Record<string, unknown>)[segment];
      else return undefined;
    }
    return current;
  }

  let current = value;
  for (const segment of selector.split('.').filter(Boolean)) {
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (current && typeof current === 'object') current = (current as Record<string, unknown>)[segment];
    else return undefined;
  }
  return current;
}

function resolveFileRef(ref: FileSecretRef, options: SecretRefResolutionOptions): string | null {
  const raw = readFileSync(expandUserPath(ref.path, options.homeDirectory), 'utf-8');
  if (!ref.selector) return stripFinalNewline(raw);
  const parsed = JSON.parse(raw) as unknown;
  const selected = selectPath(parsed, ref.selector);
  return selected === undefined || selected === null ? null : String(selected);
}

function buildOnePasswordRef(ref: OnePasswordSecretRef): string {
  if (ref.ref) return ref.ref;
  const vault = encodeURIComponent(ref.vault ?? '');
  const item = encodeURIComponent(ref.item ?? '');
  const field = encodeURIComponent(ref.field ?? '');
  return `op://${vault}/${item}/${field}`;
}

async function resolveOnePasswordRef(ref: OnePasswordSecretRef, options: SecretRefResolutionOptions): Promise<string | null> {
  const args = ['read', buildOnePasswordRef(ref)];
  if (ref.account) args.push('--account', ref.account);
  const output = await runChecked(ref, ref.cli ?? 'op', args, options, { timeoutMs: ref.timeoutMs ?? 10_000 });
  return output.length > 0 ? output : null;
}

function bitwardenEnv(ref: BitwardenSecretRef, options: SecretRefResolutionOptions): Record<string, string> {
  const env: Record<string, string> = {};
  if (ref.appDataDir) env.BITWARDENCLI_APPDATA_DIR = expandUserPath(ref.appDataDir, options.homeDirectory);
  if (ref.sessionEnv && process.env[ref.sessionEnv]) env.BW_SESSION = process.env[ref.sessionEnv]!;
  return env;
}

function expectedBitwardenServer(ref: BitwardenSecretRef): string | null {
  if (ref.server) return ref.server;
  if (ref.serverEnv && process.env[ref.serverEnv]) return process.env[ref.serverEnv]!;
  return null;
}

function normalizeUrlForCompare(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

async function validateBitwardenStatus(ref: BitwardenSecretRef, options: SecretRefResolutionOptions): Promise<void> {
  const expectedServer = expectedBitwardenServer(ref);
  const shouldValidate = ref.source === 'vaultwarden' || ref.validateServer === true || Boolean(expectedServer);
  if (!shouldValidate) return;
  const output = await runChecked(ref, ref.cli ?? 'bw', ['status', '--nointeraction'], options, {
    env: bitwardenEnv(ref, options),
    timeoutMs: ref.timeoutMs ?? 10_000,
  });
  const status = JSON.parse(output || '{}') as { serverUrl?: string; status?: string };
  if (status.status && status.status !== 'unlocked') {
    throw new Error(`Secret provider ${ref.source} vault is ${status.status}`);
  }
  if (expectedServer && status.serverUrl && normalizeUrlForCompare(status.serverUrl) !== normalizeUrlForCompare(expectedServer)) {
    throw new Error(`Secret provider ${ref.source} CLI server mismatch`);
  }
}

function extractBitwardenItemField(rawItem: string, ref: BitwardenSecretRef): string | null {
  const item = JSON.parse(rawItem) as Record<string, unknown>;
  const field = ref.field ?? 'password';

  if (ref.customField) {
    const fields = Array.isArray(item.fields) ? item.fields as Array<Record<string, unknown>> : [];
    const custom = fields.find((entry) => entry.name === ref.customField);
    const value = custom?.value;
    return value === undefined || value === null ? null : String(value);
  }

  if (field === 'item') return rawItem;
  if (field === 'notes') return item.notes === undefined || item.notes === null ? null : String(item.notes);

  const login = asRecord(item.login);
  if (field === 'username') return login?.username === undefined || login.username === null ? null : String(login.username);
  if (field === 'password') return login?.password === undefined || login.password === null ? null : String(login.password);
  if (field.startsWith('login.')) {
    const key = field.slice('login.'.length);
    const value = login?.[key];
    return value === undefined || value === null ? null : String(value);
  }

  const topLevel = item[field];
  if (topLevel !== undefined && topLevel !== null) return String(topLevel);

  const fields = Array.isArray(item.fields) ? item.fields as Array<Record<string, unknown>> : [];
  const custom = fields.find((entry) => entry.name === field);
  const value = custom?.value;
  return value === undefined || value === null ? null : String(value);
}

async function resolveBitwardenRef(ref: BitwardenSecretRef, options: SecretRefResolutionOptions): Promise<string | null> {
  await validateBitwardenStatus(ref, options);
  const env = bitwardenEnv(ref, options);
  if (ref.syncBeforeRead) {
    await runChecked(ref, ref.cli ?? 'bw', ['sync', '--nointeraction'], options, { env, timeoutMs: ref.timeoutMs ?? 20_000 });
  }

  const field = ref.field ?? 'password';
  const canUseDirectGet = !ref.customField && (field === 'password' || field === 'username' || field === 'notes' || field === 'totp');
  if (canUseDirectGet) {
    const output = await runChecked(ref, ref.cli ?? 'bw', ['get', field, ref.item, '--raw', '--nointeraction'], options, {
      env,
      timeoutMs: ref.timeoutMs ?? 10_000,
    });
    return output.length > 0 ? output : null;
  }

  const itemJson = await runChecked(ref, ref.cli ?? 'bw', ['get', 'item', ref.item, '--raw', '--nointeraction'], options, {
    env,
    timeoutMs: ref.timeoutMs ?? 10_000,
  });
  return extractBitwardenItemField(itemJson, ref);
}

async function resolveBitwardenSecretsManagerRef(
  ref: BitwardenSecretsManagerRef,
  options: SecretRefResolutionOptions,
): Promise<string | null> {
  const env: Record<string, string> = {};
  if (ref.accessToken) env.BWS_ACCESS_TOKEN = ref.accessToken;
  else if (ref.accessTokenEnv && process.env[ref.accessTokenEnv]) env.BWS_ACCESS_TOKEN = process.env[ref.accessTokenEnv]!;

  const args = ['secret', 'get', ref.id, '--output', 'json', '--color', 'no'];
  if (ref.profile) args.push('--profile', ref.profile);
  if (ref.configFile) args.push('--config-file', expandUserPath(ref.configFile, options.homeDirectory));
  if (ref.serverUrl) args.push('--server-url', ref.serverUrl);

  const output = await runChecked(ref, ref.cli ?? 'bws', args, options, { env, timeoutMs: ref.timeoutMs ?? 10_000 });
  const parsed = JSON.parse(output) as unknown;
  const secret = Array.isArray(parsed) ? parsed[0] : parsed;
  const record = asRecord(secret);
  if (!record) return null;
  const value = record[ref.field ?? 'value'];
  return value === undefined || value === null ? null : String(value);
}

export async function resolveSecretRef(
  input: SecretRefInput,
  options: SecretRefResolutionOptions = {},
): Promise<SecretRefResolution> {
  const ref = normalizeSecretRef(input);
  if (!ref) throw new Error('Invalid secret reference');

  switch (ref.source) {
    case 'env':
      return { source: ref.source, value: process.env[ref.id] ?? null };
    case 'goodvibes':
      if (!options.resolveLocalSecret) throw new Error('GoodVibes secret ref requires a local secret resolver');
      return { source: ref.source, value: await options.resolveLocalSecret(ref.id) };
    case 'file':
      return { source: ref.source, value: resolveFileRef(ref, options) };
    case 'exec': {
      const output = await runChecked(ref, ref.command, ref.args ?? [], options, {
        env: ref.env,
        stdin: ref.stdin,
        timeoutMs: ref.timeoutMs ?? 10_000,
      });
      return { source: ref.source, value: output.length > 0 ? output : null };
    }
    case '1password':
    case 'onepassword':
      return { source: ref.source, value: await resolveOnePasswordRef(ref, options) };
    case 'bitwarden':
    case 'vaultwarden':
      return { source: ref.source, value: await resolveBitwardenRef(ref, options) };
    case 'bitwarden-secrets-manager':
    case 'bws':
      return { source: ref.source, value: await resolveBitwardenSecretsManagerRef(ref, options) };
  }
}
