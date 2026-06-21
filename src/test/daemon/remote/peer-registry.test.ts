import { describe, expect, it } from 'bun:test';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';
import {
  PeerRegistry,
  PeerRegistryValidationError,
  normalizeBackendConfig,
} from '../../../daemon/handlers/remote/peer-registry.ts';

const SECRET_REF = 'goodvibes://secrets/goodvibes/REMOTE_SSH_KEY';
const CRED_REF = 'goodvibes://secrets/goodvibes/CLOUD_CRED';

async function freshRegistry(): Promise<PeerRegistry> {
  const registry = new PeerRegistry(makeProjectTempDir('remote-peers'));
  await registry.init();
  return registry;
}

describe('normalizeBackendConfig', () => {
  it('normalizes a docker config without credentials', () => {
    const config = normalizeBackendConfig('docker', { containerName: 'web', extra: 'ignored' });
    expect(config).toEqual({ kind: 'docker', containerName: 'web' });
  });

  it('accepts a docker host socket path with no embedded credentials', () => {
    const config = normalizeBackendConfig('docker', {
      containerName: 'web',
      dockerHost: 'unix:///var/run/docker.sock',
    });
    expect(config).toMatchObject({ kind: 'docker', dockerHost: 'unix:///var/run/docker.sock' });
  });

  it('rejects a docker host that embeds credentials and is not a secret ref', () => {
    expect(() =>
      normalizeBackendConfig('docker', {
        containerName: 'web',
        dockerHost: 'tcp://user:wordfake@10.0.0.1:2376',
      }),
    ).toThrow(PeerRegistryValidationError);
  });

  it('accepts a docker host that is a valid goodvibes://secrets/ reference', () => {
    const config = normalizeBackendConfig('docker', {
      containerName: 'web',
      dockerHost: 'goodvibes://secrets/goodvibes/DOCKER_TLS_HOST',
    });
    expect(config).toMatchObject({
      kind: 'docker',
      dockerHost: 'goodvibes://secrets/goodvibes/DOCKER_TLS_HOST',
    });
  });

  it('rejects a TLS docker host given as a raw URL (must be a secret ref)', () => {
    // A TLS daemon endpoint carries credentials out-of-band; docker.ts only
    // resolves goodvibes:// values, so a raw https:// host would bypass the
    // credential store entirely. Registration must reject it up front.
    expect(() =>
      normalizeBackendConfig('docker', {
        containerName: 'web',
        dockerHost: 'https://10.0.0.1:2376',
      }),
    ).toThrow(/TLS Docker daemon/);
  });

  it('rejects a malformed goodvibes:// docker host that is not a valid secret ref', () => {
    // Would be handed to credentials.resolveRef() and fail opaquely; reject now.
    expect(() =>
      normalizeBackendConfig('docker', {
        containerName: 'web',
        dockerHost: 'goodvibes://docker-host-typo',
      }),
    ).toThrow(/malformed/);
  });

  it('requires a secret reference for the ssh identity', () => {
    expect(() =>
      normalizeBackendConfig('ssh', {
        sshHost: 'host.example',
        sshUser: 'deploy',
        identityRef: 'word-style-fake-private-key-not-a-ref',
      }),
    ).toThrow(/goodvibes:\/\/secrets/);
  });

  it('normalizes a valid ssh config with a secret ref and port', () => {
    const config = normalizeBackendConfig('ssh', {
      sshHost: 'host.example',
      sshUser: 'deploy',
      identityRef: SECRET_REF,
      sshPort: 2222,
    });
    expect(config).toEqual({
      kind: 'ssh',
      sshHost: 'host.example',
      sshUser: 'deploy',
      identityRef: SECRET_REF,
      sshPort: 2222,
    });
  });

  it('rejects an out-of-range ssh port', () => {
    expect(() =>
      normalizeBackendConfig('ssh', {
        sshHost: 'host.example',
        sshUser: 'deploy',
        identityRef: SECRET_REF,
        sshPort: 70000,
      }),
    ).toThrow(PeerRegistryValidationError);
  });

  it('requires a secret reference for the cloud credential and validates provider', () => {
    expect(() =>
      normalizeBackendConfig('cloud-terminal', {
        provider: 'gcp',
        credentialRef: 'raw-word-fake-credential',
      }),
    ).toThrow(/goodvibes:\/\/secrets/);
    expect(() =>
      normalizeBackendConfig('cloud-terminal', {
        provider: 'digitalocean',
        credentialRef: CRED_REF,
      }),
    ).toThrow(/provider/);
  });

  it('normalizes a cloud-terminal config with optional location/instance', () => {
    const config = normalizeBackendConfig('cloud-terminal', {
      provider: 'aws',
      credentialRef: CRED_REF,
      location: 'us-east-1',
      instance: 'i-123',
    });
    expect(config).toEqual({
      kind: 'cloud-terminal',
      provider: 'aws',
      credentialRef: CRED_REF,
      location: 'us-east-1',
      instance: 'i-123',
    });
  });

  it('normalizes a local-process allowlist, dropping blanks', () => {
    const config = normalizeBackendConfig('local-process', {
      cwd: '/srv/app',
      allowedCommands: ['git', '  ', 'ls', 42],
    });
    expect(config).toEqual({
      kind: 'local-process',
      cwd: '/srv/app',
      allowedCommands: ['git', 'ls'],
    });
  });
});

describe('PeerRegistry', () => {
  it('registers, retrieves, lists, and removes peers', async () => {
    const registry = await freshRegistry();
    const record = await registry.register({
      peerId: 'peer-ssh',
      displayName: 'SSH Peer',
      backendKind: 'ssh',
      backendConfig: { sshHost: 'host.example', sshUser: 'deploy', identityRef: SECRET_REF },
    });
    expect(record.backendConfig).toEqual({
      kind: 'ssh',
      sshHost: 'host.example',
      sshUser: 'deploy',
      identityRef: SECRET_REF,
    });

    expect(registry.get('peer-ssh')?.displayName).toBe('SSH Peer');
    expect(registry.get('missing')).toBeNull();
    expect(registry.list().map((p) => p.peerId)).toEqual(['peer-ssh']);

    expect(await registry.remove('peer-ssh')).toBe(true);
    expect(await registry.remove('peer-ssh')).toBe(false);
    expect(registry.get('peer-ssh')).toBeNull();
    registry.close();
  });

  it('upserts on conflicting peerId and persists across reopen', async () => {
    const dir = makeProjectTempDir('remote-peers-persist');
    const first = new PeerRegistry(dir);
    await first.init();
    await first.register({
      peerId: 'peer-local',
      displayName: 'Local',
      backendKind: 'local-process',
      backendConfig: { allowedCommands: ['echo'] },
    });
    await first.register({
      peerId: 'peer-local',
      displayName: 'Local Renamed',
      backendKind: 'local-process',
      backendConfig: { allowedCommands: ['echo', 'ls'] },
    });
    first.close();

    const second = new PeerRegistry(dir);
    await second.init();
    const reloaded = second.get('peer-local');
    expect(reloaded?.displayName).toBe('Local Renamed');
    expect(reloaded?.backendConfig).toEqual({
      kind: 'local-process',
      allowedCommands: ['echo', 'ls'],
    });
    second.close();
  });

  it('rejects an embedded secret in a registered peer config', async () => {
    const registry = await freshRegistry();
    await expect(
      registry.register({
        peerId: 'peer-bad',
        displayName: 'Bad',
        backendKind: 'ssh',
        backendConfig: { sshHost: 'h', sshUser: 'u', identityRef: 'inline-word-fake-key' },
      }),
    ).rejects.toThrow(PeerRegistryValidationError);
    registry.close();
  });

  it('throws when used before init', () => {
    const registry = new PeerRegistry(makeProjectTempDir('remote-peers-noinit'));
    expect(() => registry.get('x')).toThrow(/not initialized/);
  });
});
