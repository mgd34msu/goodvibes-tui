/**
 * remote.peers.invoke gating + remote-shell arg passthrough.
 *
 * Two postures are verified here, both load-bearing for the unescaped
 * `payload.args` contract documented on buildRemoteShellCommand (types.ts):
 *
 *  1. GATING IS IN FORCE. `remote.peers.invoke` is not a catalog method; it is
 *     published by the SDK as `POST /api/remote/peers/:peerId/invoke` and routed
 *     through `createDaemonRemoteRouteHandlers(...).invokeRemotePeer`. That SDK
 *     handler calls `context.requireAdmin(req)` and returns its Response BEFORE
 *     ever reaching `context.distributedRuntime.invokePeer(...)`. We import the
 *     real SDK route factory and prove a denied admin check short-circuits: our
 *     injected `invokePeer` is never called. This is the admin gate that makes
 *     the un-escaped arg passthrough below safe to rely on.
 *
 *  2. ARGS ARE PASSED VERBATIM. For the remote-shell backends (ssh / docker /
 *     cloud-terminal) the positional `payload.args` are joined onto the command
 *     with single spaces and handed, unescaped, to a remote shell. We spy on
 *     `Bun.spawn` (the real boundary `runProcess` shells out through) and assert
 *     the constructed argv carries the args verbatim — confirming the
 *     documented asymmetry vs. the tokenized local-process backend.
 */
import { describe, expect, it, spyOn, afterEach } from 'bun:test';
import { createDaemonRemoteRouteHandlers } from '@pellux/goodvibes-daemon-sdk/remote-routes';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';
import { createDockerBackend } from '../../../daemon/handlers/remote/backends/docker.ts';
import { createSshBackend } from '../../../daemon/handlers/remote/backends/ssh.ts';
import { createCloudTerminalBackend } from '../../../daemon/handlers/remote/backends/cloud-terminal.ts';
import { BackendDispatchError, type BackendContext } from '../../../daemon/handlers/remote/backends/types.ts';
import type { DaemonCredentialStore } from '../../../daemon/handlers/credentials.ts';
import type { HandlerLogger } from '../../../daemon/handlers/context.ts';
import type { PeerRecord } from '../../../daemon/handlers/remote/peer-registry.ts';

const noopLogger: HandlerLogger = { info: () => {}, warn: () => {}, error: () => {} };

function credsResolving(value: string | null): DaemonCredentialStore {
  return {
    resolveRef: async () => value,
    resolveConfigSecret: async () => null,
    put: async () => {},
    has: async () => false,
  };
}

function ctxWith(creds: DaemonCredentialStore): BackendContext {
  return { credentials: creds, logger: noopLogger, homeDirectory: makeProjectTempDir('route-gating-home') };
}

// ---------------------------------------------------------------------------
// Bun.spawn capture: intercept the real shell-out boundary used by runProcess.
// Returns a fake subprocess that completes immediately with empty output so the
// backend resolves without launching anything; we inspect the captured argv.
// ---------------------------------------------------------------------------

interface SpawnCapture {
  argv: string[];
  env: Record<string, string | undefined>;
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

function installSpawnSpy(captures: SpawnCapture[]) {
  return spyOn(globalThis.Bun, 'spawn').mockImplementation(((cmd: string[], options: { env?: Record<string, string | undefined> }) => {
    captures.push({ argv: cmd, env: options?.env ?? {} });
    return {
      stdout: emptyStream(),
      stderr: emptyStream(),
      stdin: { write: () => {}, end: () => {} },
      exited: Promise.resolve(0),
      kill: () => {},
    };
  }) as unknown as typeof Bun.spawn);
}

afterEach(() => {
  // Restore any Bun.spawn spy so the real-process tests in other files are
  // unaffected by the interception installed here.
  (globalThis.Bun.spawn as unknown as { mockRestore?: () => void }).mockRestore?.();
});

// ---------------------------------------------------------------------------
// 1. Admin gating is enforced by the SDK route before invokePeer runs.
// ---------------------------------------------------------------------------

describe('remote.peers.invoke admin gating (SDK route)', () => {
  it('short-circuits on a denied requireAdmin and never reaches invokePeer', async () => {
    let invokeCalls = 0;
    const denial = new Response('forbidden', { status: 403 });
    const handlers = createDaemonRemoteRouteHandlers({
      // requireAdmin returns a Response => denied; the handler must return it
      // and never call distributedRuntime.invokePeer.
      requireAdmin: () => denial,
      parseJsonBody: async () => ({ command: 'rm -rf /' }),
      requireRemotePeer: async () => new Response(null, { status: 401 }),
      requireAuthenticatedSession: () => null,
      authToken: null,
      distributedRuntime: {
        invokePeer: async () => {
          invokeCalls += 1;
          return { ok: true };
        },
      },
    } as unknown as Parameters<typeof createDaemonRemoteRouteHandlers>[0]);

    const req = new Request('http://daemon/api/remote/peers/peer-1/invoke', {
      method: 'POST',
      body: JSON.stringify({ command: 'rm -rf /' }),
    });
    const response = await handlers.invokeRemotePeer('peer-1', req);
    expect(response.status).toBe(403);
    expect(invokeCalls).toBe(0);
  });

  it('passes the admin gate through to invokePeer when requireAdmin permits', async () => {
    let seenCommand: string | undefined;
    const handlers = createDaemonRemoteRouteHandlers({
      // requireAdmin returns null => permitted; the handler proceeds to dispatch.
      requireAdmin: () => null,
      parseJsonBody: async () => ({ command: 'uptime' }),
      requireRemotePeer: async () => new Response(null, { status: 401 }),
      requireAuthenticatedSession: () => null,
      authToken: null,
      distributedRuntime: {
        invokePeer: async (input: { command?: string }) => {
          seenCommand = input.command;
          return { workId: 'w-1' };
        },
      },
    } as unknown as Parameters<typeof createDaemonRemoteRouteHandlers>[0]);

    const req = new Request('http://daemon/api/remote/peers/peer-1/invoke', {
      method: 'POST',
      body: JSON.stringify({ command: 'uptime' }),
    });
    const response = await handlers.invokeRemotePeer('peer-1', req);
    // 202 Accepted is the SDK's success status for an admitted invoke.
    expect(response.status).toBe(202);
    expect(seenCommand).toBe('uptime');
  });
});

// ---------------------------------------------------------------------------
// 2. Remote-shell backends pass payload.args verbatim (unescaped) into argv.
// ---------------------------------------------------------------------------

describe('remote-shell backends pass payload.args verbatim', () => {
  const sshPeer: PeerRecord = {
    peerId: 'ssh-peer',
    displayName: 'SSH',
    backendKind: 'ssh',
    backendConfig: {
      kind: 'ssh',
      sshHost: 'host.example',
      sshUser: 'deploy',
      identityRef: 'goodvibes://secrets/goodvibes/REMOTE_SSH_KEY',
    },
  };
  const dockerPeer: PeerRecord = {
    peerId: 'docker-peer',
    displayName: 'Docker',
    backendKind: 'docker',
    backendConfig: { kind: 'docker', containerName: 'web' },
  };
  const cloudPeer: PeerRecord = {
    peerId: 'cloud-peer',
    displayName: 'Cloud',
    backendKind: 'cloud-terminal',
    backendConfig: {
      kind: 'cloud-terminal',
      provider: 'gcp',
      credentialRef: 'goodvibes://secrets/goodvibes/CLOUD_CRED',
      instance: 'shell-vm',
    },
  };

  it('ssh: appends args onto the remote command string unescaped', async () => {
    const captures: SpawnCapture[] = [];
    installSpawnSpy(captures);
    const backend = createSshBackend(ctxWith(credsResolving('word-style-fake-private-key')));
    await backend.dispatch(sshPeer, 'echo', { args: ['a b', '$HOME'] });
    const argv = captures[0]!.argv;
    // The final argv element is the single remote-command string the daemon
    // hands to the remote shell. Args are joined with single spaces, NOT quoted.
    expect(argv[0]).toBe('ssh');
    expect(argv[argv.length - 1]).toBe('echo a b $HOME');
  });

  it('docker: builds `sh -c` with the args joined verbatim', async () => {
    const captures: SpawnCapture[] = [];
    installSpawnSpy(captures);
    const backend = createDockerBackend(ctxWith(credsResolving(null)));
    await backend.dispatch(dockerPeer, 'echo', { args: ['a b', '$HOME'] });
    const argv = captures[0]!.argv;
    expect(argv.slice(0, 3)).toEqual(['docker', 'exec', 'web']);
    expect(argv[argv.length - 2]).toBe('-c');
    expect(argv[argv.length - 1]).toBe('echo a b $HOME');
  });

  it('cloud-terminal (gcp): passes the joined command verbatim to --command', async () => {
    const captures: SpawnCapture[] = [];
    installSpawnSpy(captures);
    const backend = createCloudTerminalBackend(ctxWith(credsResolving('wordfake-cloud-credential')));
    await backend.dispatch(cloudPeer, 'echo', { args: ['a b', '$HOME'] });
    const argv = captures[0]!.argv;
    const commandIdx = argv.indexOf('--command');
    expect(commandIdx).toBeGreaterThanOrEqual(0);
    expect(argv[commandIdx + 1]).toBe('echo a b $HOME');
  });
});

// ---------------------------------------------------------------------------
// 3. Docker dockerHost resolution + REMOTE_BACKEND_CREDENTIAL_MISSING.
// ---------------------------------------------------------------------------

describe('docker dockerHost resolution', () => {
  const peerWithSecretHost: PeerRecord = {
    peerId: 'docker-tls',
    displayName: 'Docker TLS',
    backendKind: 'docker',
    backendConfig: {
      kind: 'docker',
      containerName: 'web',
      dockerHost: 'goodvibes://secrets/goodvibes/DOCKER_TLS_HOST',
    },
  };
  const peerWithPlainHost: PeerRecord = {
    peerId: 'docker-plain',
    displayName: 'Docker Plain',
    backendKind: 'docker',
    backendConfig: {
      kind: 'docker',
      containerName: 'web',
      dockerHost: 'unix:///var/run/docker.sock',
    },
  };

  it('resolves a secret-ref dockerHost from the store into the DOCKER_HOST env', async () => {
    const captures: SpawnCapture[] = [];
    installSpawnSpy(captures);
    const backend = createDockerBackend(ctxWith(credsResolving('tcp://10.0.0.1:2376')));
    await backend.dispatch(peerWithSecretHost, 'uptime');
    // The resolved value is supplied via env (never argv): no secret-ref string
    // and no resolved host leaks into the docker argv.
    expect(captures[0]!.env.DOCKER_HOST).toBe('tcp://10.0.0.1:2376');
    expect(captures[0]!.argv.join(' ')).not.toContain('goodvibes://');
    expect(captures[0]!.argv.join(' ')).not.toContain('10.0.0.1');
  });

  it('passes a credential-free plain dockerHost through verbatim', async () => {
    const captures: SpawnCapture[] = [];
    installSpawnSpy(captures);
    const backend = createDockerBackend(ctxWith(credsResolving(null)));
    await backend.dispatch(peerWithPlainHost, 'uptime');
    expect(captures[0]!.env.DOCKER_HOST).toBe('unix:///var/run/docker.sock');
  });

  it('raises REMOTE_BACKEND_CREDENTIAL_MISSING when a secret-ref dockerHost will not resolve', async () => {
    installSpawnSpy([]);
    // Store returns null => the ref cannot be resolved.
    const backend = createDockerBackend(ctxWith(credsResolving(null)));
    await expect(backend.dispatch(peerWithSecretHost, 'uptime')).rejects.toMatchObject({
      code: 'REMOTE_BACKEND_CREDENTIAL_MISSING',
    });
  });

  it('does not shell out when the dockerHost secret is missing', async () => {
    const captures: SpawnCapture[] = [];
    installSpawnSpy(captures);
    const backend = createDockerBackend(ctxWith(credsResolving(null)));
    await expect(backend.dispatch(peerWithSecretHost, 'uptime')).rejects.toBeInstanceOf(BackendDispatchError);
    expect(captures).toHaveLength(0);
  });
});
