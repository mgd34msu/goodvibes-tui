import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  describeSecretRef,
  normalizeSecretRef,
  resolveSecretRef,
  type SecretCommandRunner,
} from '@pellux/goodvibes-sdk/platform/config/secret-refs';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '../../config/service-registry.ts';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-secret-refs-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function jsonRef(value: unknown): string {
  return `secretref:${JSON.stringify(value)}`;
}

describe('secret refs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    delete process.env.GV_SECRET_REF_TEST;
    delete process.env.GV_BW_SESSION;
    delete process.env.GV_VAULTWARDEN_SERVER;
    delete process.env.GV_BWS_TOKEN;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('normalizes first-class provider refs', () => {
    expect(normalizeSecretRef('op://Private/GoodVibes/API%20Key')?.source).toBe('1password');
    expect(normalizeSecretRef('bw://GoodVibes%20Slack/password?sessionEnv=BW_SESSION')).toMatchObject({
      source: 'bitwarden',
      item: 'GoodVibes Slack',
      field: 'password',
      sessionEnv: 'BW_SESSION',
    });
    expect(normalizeSecretRef('vaultwarden://GoodVibes%20Slack/password?server=https%3A%2F%2Fvault.example.test')).toMatchObject({
      source: 'vaultwarden',
      item: 'GoodVibes Slack',
      server: 'https://vault.example.test',
    });
    expect(normalizeSecretRef('bws://secret-id/value?accessTokenEnv=GV_BWS_TOKEN')).toMatchObject({
      source: 'bws',
      id: 'secret-id',
      field: 'value',
      accessTokenEnv: 'GV_BWS_TOKEN',
    });
  });

  test('resolves env, file, and exec refs without leaking values into descriptions', async () => {
    process.env.GV_SECRET_REF_TEST = 'env-secret';
    const filePath = join(tmpDir, 'secret.json');
    writeFileSync(filePath, JSON.stringify({ nested: { value: 'file-secret' } }), 'utf-8');
    writeFileSync(join(tmpDir, 'tilde-secret.txt'), 'tilde-secret\n', 'utf-8');
    const runner: SecretCommandRunner = async (command, args) => ({
      exitCode: 0,
      stdout: `${command}:${args.join(',')}\n`,
      stderr: '',
    });

    await expect(resolveSecretRef({ source: 'env', id: 'GV_SECRET_REF_TEST' })).resolves.toEqual({
      source: 'env',
      value: 'env-secret',
    });
    await expect(resolveSecretRef({ source: 'file', path: filePath, selector: 'nested.value' })).resolves.toEqual({
      source: 'file',
      value: 'file-secret',
    });
    await expect(resolveSecretRef({ source: 'file', path: '~/tilde-secret.txt' }, { homeDirectory: tmpDir })).resolves.toEqual({
      source: 'file',
      value: 'tilde-secret',
    });
    await expect(resolveSecretRef({ source: 'exec', command: 'print-secret', args: ['one'] }, { runCommand: runner })).resolves.toEqual({
      source: 'exec',
      value: 'print-secret:one',
    });
    expect(describeSecretRef({ source: 'file', path: filePath, selector: 'nested.value' })).not.toContain('file-secret');
  });

  test('resolves Bitwarden Password Manager refs through bw CLI', async () => {
    process.env.GV_BW_SESSION = 'session-secret';
    const calls: Array<{ command: string; args: readonly string[]; env?: Record<string, string> }> = [];
    const runner: SecretCommandRunner = async (command, args, options) => {
      calls.push({ command, args, env: options?.env });
      return { exitCode: 0, stdout: 'bw-password\n', stderr: '' };
    };

    const result = await resolveSecretRef({
      source: 'bitwarden',
      item: 'GoodVibes Slack',
      field: 'password',
      sessionEnv: 'GV_BW_SESSION',
      appDataDir: '~/bitwarden-cli-goodvibes',
    }, { runCommand: runner, homeDirectory: tmpDir });

    expect(result.value).toBe('bw-password');
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('bw');
    expect(calls[0].args).toEqual(['get', 'password', 'GoodVibes Slack', '--raw', '--nointeraction']);
    expect(calls[0].env?.BW_SESSION).toBe('session-secret');
    expect(calls[0].env?.BITWARDENCLI_APPDATA_DIR).toContain('bitwarden-cli-goodvibes');
  });

  test('validates Vaultwarden server posture and uses the shared bw CLI read path', async () => {
    process.env.GV_VAULTWARDEN_SERVER = 'https://vault.example.test';
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner: SecretCommandRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === 'status') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ serverUrl: 'https://vault.example.test/', status: 'unlocked' }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: 'vaultwarden-password\n', stderr: '' };
    };

    const result = await resolveSecretRef({
      source: 'vaultwarden',
      item: 'GoodVibes Slack',
      field: 'password',
      serverEnv: 'GV_VAULTWARDEN_SERVER',
    }, { runCommand: runner, homeDirectory: tmpDir });

    expect(result.value).toBe('vaultwarden-password');
    expect(calls.map((call) => call.args[0])).toEqual(['status', 'get']);
    expect(calls[1].args).toEqual(['get', 'password', 'GoodVibes Slack', '--raw', '--nointeraction']);
  });

  test('extracts Bitwarden custom fields from item JSON when direct get is not enough', async () => {
    const runner: SecretCommandRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        login: { username: 'user', password: 'pass' },
        fields: [{ name: 'api token', value: 'custom-token' }],
      }),
      stderr: '',
    });

    const result = await resolveSecretRef({
      source: 'bitwarden',
      item: 'GoodVibes API',
      customField: 'api token',
    }, { runCommand: runner });

    expect(result.value).toBe('custom-token');
  });

  test('resolves Bitwarden Secrets Manager refs through bws CLI', async () => {
    process.env.GV_BWS_TOKEN = 'bws-token';
    const calls: Array<{ command: string; args: readonly string[]; env?: Record<string, string> }> = [];
    const runner: SecretCommandRunner = async (command, args, options) => {
      calls.push({ command, args, env: options?.env });
      return { exitCode: 0, stdout: JSON.stringify({ id: 'secret-id', value: 'bws-secret', note: 'n/a' }), stderr: '' };
    };

    const result = await resolveSecretRef({
      source: 'bitwarden-secrets-manager',
      id: 'secret-id',
      accessTokenEnv: 'GV_BWS_TOKEN',
      profile: 'dev',
      serverUrl: 'https://vault.bitwarden.example',
    }, { runCommand: runner });

    expect(result.value).toBe('bws-secret');
    expect(calls[0].command).toBe('bws');
    expect(calls[0].args).toEqual(['secret', 'get', 'secret-id', '--output', 'json', '--color', 'no', '--profile', 'dev', '--server-url', 'https://vault.bitwarden.example']);
    expect(calls[0].env?.BWS_ACCESS_TOKEN).toBe('bws-token');
  });

  test('SecretsManager resolves stored SecretRef values with local indirection', async () => {
    const manager = new SecretsManager({ projectRoot: tmpDir, globalHome: join(tmpDir, 'home') });
    await manager.set('GV_INNER_SECRET', 'stored-secret', { scope: 'project', medium: 'secure' });
    await manager.set('GV_OUTER_SECRET', jsonRef({ source: 'goodvibes', id: 'GV_INNER_SECRET' }), { scope: 'project', medium: 'secure' });

    expect(await manager.get('GV_OUTER_SECRET')).toBe('stored-secret');
    const records = await manager.listDetailed();
    expect(records.find((record) => record.key === 'GV_OUTER_SECRET')?.refSource).toBe('goodvibes');
  });

  test('ServiceRegistry resolves tokenRef without requiring a local tokenKey value', async () => {
    const serviceFile = join(tmpDir, 'services.json');
    writeFileSync(serviceFile, JSON.stringify({
      slack: {
        name: 'slack',
        authType: 'bearer',
        tokenKey: 'SLACK_BOT_TOKEN',
        tokenRef: { source: 'file', path: join(tmpDir, 'slack-token.txt') },
      },
    }), 'utf-8');
    writeFileSync(join(tmpDir, 'slack-token.txt'), 'xoxb-from-file\n', 'utf-8');

    const registry = new ServiceRegistry(serviceFile, {
      secretsManager: new SecretsManager({ projectRoot: tmpDir, globalHome: tmpDir }),
      subscriptionManager: new SubscriptionManager(join(tmpDir, 'subscriptions.json')),
    });
    const headers = await registry.resolveAuth('slack');
    expect(headers).toEqual({ Authorization: 'Bearer xoxb-from-file' });
  });
});
