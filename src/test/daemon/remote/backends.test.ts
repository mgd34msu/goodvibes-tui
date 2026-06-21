import { describe, expect, test } from 'bun:test';
import {
  tokenizeCommand,
  runProcess,
  createLocalProcessBackend,
  BackendDispatchError,
  type BackendContext,
} from '../../../daemon/remote/index.ts';
import type { DaemonCredentialStore, OperatorLogger } from '../../../daemon/operator/index.ts';
import type { PeerRecord } from '../../../daemon/remote/index.ts';

const silentLogger: OperatorLogger = {
  info() {},
  warn() {},
  error() {},
};

const noopCredentials: DaemonCredentialStore = {
  async resolveRef() {
    return null;
  },
  async resolveConfigSecret() {
    return null;
  },
  async put() {},
  async has() {
    return false;
  },
};

function backendContext(): BackendContext {
  return { credentials: noopCredentials, logger: silentLogger, homeDirectory: '/tmp/gv-home' };
}

describe('tokenizeCommand', () => {
  test('splits on whitespace', () => {
    expect(tokenizeCommand('echo hello world')).toEqual(['echo', 'hello', 'world']);
  });
  test('honors double quotes', () => {
    expect(tokenizeCommand('echo "hello world"')).toEqual(['echo', 'hello world']);
  });
  test('honors single quotes literally', () => {
    expect(tokenizeCommand("printf '%s\\n'")).toEqual(['printf', '%s\\n']);
  });
  test('throws on unterminated quote', () => {
    expect(() => tokenizeCommand('echo "unterminated')).toThrow(BackendDispatchError);
  });
});

describe('runProcess', () => {
  test('captures stdout and exit 0', async () => {
    const result = await runProcess({ args: ['echo', 'hi'], timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
    expect(result.timedOut).toBe(false);
  });

  test('captures non-zero exit', async () => {
    const result = await runProcess({ args: ['sh', '-c', 'exit 3'], timeoutMs: 5000 });
    expect(result.exitCode).toBe(3);
  });

  test('pipes stdin', async () => {
    const result = await runProcess({ args: ['cat'], stdin: 'piped-input', timeoutMs: 5000 });
    expect(result.stdout).toContain('piped-input');
  });

  test('enforces timeout', async () => {
    const result = await runProcess({ args: ['sh', '-c', 'sleep 5'], timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
  });
});

describe('local-process backend', () => {
  const peer: PeerRecord = {
    peerId: 'local',
    displayName: 'Local',
    backendKind: 'local-process',
    backendConfig: { kind: 'local-process' },
  };

  test('dispatches a command and returns exitCode/stdout', async () => {
    const backend = createLocalProcessBackend(backendContext());
    const result = await backend.dispatch(peer, 'echo backend-ok');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('backend-ok');
  });

  test('appends payload args', async () => {
    const backend = createLocalProcessBackend(backendContext());
    const result = await backend.dispatch(peer, 'echo', { args: ['one', 'two'] });
    expect(result.stdout.trim()).toBe('one two');
  });

  test('enforces allowlist', async () => {
    const backend = createLocalProcessBackend(backendContext());
    const restricted: PeerRecord = {
      ...peer,
      backendConfig: { kind: 'local-process', allowedCommands: ['echo'] },
    };
    await expect(backend.dispatch(restricted, 'cat /etc/passwd')).rejects.toThrow(
      /not in the peer allowlist/,
    );
  });

  test('rejects kind mismatch', async () => {
    const backend = createLocalProcessBackend(backendContext());
    const wrong: PeerRecord = {
      ...peer,
      backendConfig: { kind: 'docker', containerName: 'x' },
    };
    await expect(backend.dispatch(wrong, 'echo x')).rejects.toThrow(BackendDispatchError);
  });

  test('timeout yields exit 124', async () => {
    const backend = createLocalProcessBackend(backendContext());
    const result = await backend.dispatch(peer, 'sleep 5', { timeoutMs: 150 });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out');
  });
});
