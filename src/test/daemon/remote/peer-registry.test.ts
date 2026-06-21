import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PeerRegistry,
  PeerRegistryValidationError,
  normalizeBackendConfig,
} from '../../../daemon/remote/index.ts';

let workDir: string;
let registry: PeerRegistry;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'gv-remote-peers-'));
  registry = new PeerRegistry(workDir);
  await registry.init();
});

afterEach(async () => {
  registry.close();
  await rm(workDir, { recursive: true, force: true });
});

describe('normalizeBackendConfig', () => {
  test('docker requires containerName', () => {
    expect(() => normalizeBackendConfig('docker', {})).toThrow(PeerRegistryValidationError);
    const cfg = normalizeBackendConfig('docker', { containerName: 'web' });
    expect(cfg).toEqual({ kind: 'docker', containerName: 'web' });
  });

  test('docker rejects dockerHost that embeds credentials but accepts a secret ref', () => {
    expect(() =>
      normalizeBackendConfig('docker', { containerName: 'web', dockerHost: 'tcp://user:pw@host:2376' }),
    ).toThrow(PeerRegistryValidationError);
    const cfg = normalizeBackendConfig('docker', {
      containerName: 'web',
      dockerHost: 'goodvibes://secrets/goodvibes/DOCKER_HOST',
    });
    expect(cfg).toMatchObject({ dockerHost: 'goodvibes://secrets/goodvibes/DOCKER_HOST' });
  });

  test('ssh requires a secret reference for identityRef', () => {
    expect(() =>
      normalizeBackendConfig('ssh', { sshHost: 'h', sshUser: 'u', identityRef: '-----BEGIN KEY-----' }),
    ).toThrow(/goodvibes:\/\/secrets/);
    const cfg = normalizeBackendConfig('ssh', {
      sshHost: 'h',
      sshUser: 'u',
      sshPort: 2222,
      identityRef: 'goodvibes://secrets/goodvibes/SSH_KEY',
    });
    expect(cfg).toEqual({
      kind: 'ssh',
      sshHost: 'h',
      sshUser: 'u',
      sshPort: 2222,
      identityRef: 'goodvibes://secrets/goodvibes/SSH_KEY',
    });
  });

  test('ssh rejects invalid port', () => {
    expect(() =>
      normalizeBackendConfig('ssh', {
        sshHost: 'h',
        sshUser: 'u',
        sshPort: 70000,
        identityRef: 'goodvibes://secrets/goodvibes/SSH_KEY',
      }),
    ).toThrow(PeerRegistryValidationError);
  });

  test('cloud-terminal requires provider + credentialRef ref', () => {
    expect(() =>
      normalizeBackendConfig('cloud-terminal', { provider: 'gcp', credentialRef: 'raw-token' }),
    ).toThrow(PeerRegistryValidationError);
    expect(() =>
      normalizeBackendConfig('cloud-terminal', {
        provider: 'digitalocean',
        credentialRef: 'goodvibes://secrets/goodvibes/CRED',
      }),
    ).toThrow(PeerRegistryValidationError);
    const cfg = normalizeBackendConfig('cloud-terminal', {
      provider: 'aws',
      projectId: 'proj',
      location: 'us-east-1',
      instance: 'i-123',
      credentialRef: 'goodvibes://secrets/goodvibes/CRED',
    });
    expect(cfg).toEqual({
      kind: 'cloud-terminal',
      provider: 'aws',
      projectId: 'proj',
      location: 'us-east-1',
      instance: 'i-123',
      credentialRef: 'goodvibes://secrets/goodvibes/CRED',
    });
  });

  test('local-process normalizes allowlist', () => {
    const cfg = normalizeBackendConfig('local-process', {
      cwd: '/tmp',
      allowedCommands: ['echo', '  ', 'ls'],
    });
    expect(cfg).toEqual({ kind: 'local-process', cwd: '/tmp', allowedCommands: ['echo', 'ls'] });
  });
});

describe('PeerRegistry persistence', () => {
  test('register + get round-trips and stores only refs', async () => {
    const record = await registry.register({
      peerId: 'peer-ssh',
      displayName: 'SSH Box',
      backendKind: 'ssh',
      backendConfig: {
        sshHost: 'host.example',
        sshUser: 'deploy',
        identityRef: 'goodvibes://secrets/goodvibes/SSH_KEY',
      },
    });
    expect(record.peerId).toBe('peer-ssh');
    const fetched = registry.get('peer-ssh');
    expect(fetched?.backendKind).toBe('ssh');
    expect(fetched?.backendConfig).toMatchObject({
      identityRef: 'goodvibes://secrets/goodvibes/SSH_KEY',
    });
    // Ensure no raw key material leaked into persisted config.
    expect(JSON.stringify(fetched?.backendConfig)).not.toContain('BEGIN');
  });

  test('register upserts by peerId', async () => {
    await registry.register({
      peerId: 'p1',
      displayName: 'First',
      backendKind: 'local-process',
      backendConfig: {},
    });
    await registry.register({
      peerId: 'p1',
      displayName: 'Second',
      backendKind: 'docker',
      backendConfig: { containerName: 'box' },
    });
    const fetched = registry.get('p1');
    expect(fetched?.displayName).toBe('Second');
    expect(fetched?.backendKind).toBe('docker');
    expect(registry.list()).toHaveLength(1);
  });

  test('persists across store reopen', async () => {
    await registry.register({
      peerId: 'persist',
      displayName: 'Persist',
      backendKind: 'local-process',
      backendConfig: { allowedCommands: ['echo'] },
    });
    registry.close();
    const reopened = new PeerRegistry(workDir);
    await reopened.init();
    const fetched = reopened.get('persist');
    expect(fetched?.displayName).toBe('Persist');
    reopened.close();
    // re-init for afterEach close
    registry = new PeerRegistry(workDir);
    await registry.init();
  });

  test('remove deletes the peer', async () => {
    await registry.register({
      peerId: 'rm',
      displayName: 'Remove',
      backendKind: 'local-process',
      backendConfig: {},
    });
    expect(await registry.remove('rm')).toBe(true);
    expect(registry.get('rm')).toBeNull();
    expect(await registry.remove('rm')).toBe(false);
  });

  test('register rejects empty peerId', async () => {
    await expect(
      registry.register({
        peerId: '   ',
        displayName: 'x',
        backendKind: 'local-process',
        backendConfig: {},
      }),
    ).rejects.toThrow();
  });
});
