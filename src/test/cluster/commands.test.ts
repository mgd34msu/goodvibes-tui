// ---------------------------------------------------------------------------
// cluster-commands.test.ts — the `cluster` subcommands and the remote-target
// convention they established.
//
// Two things are load-bearing here and both are tested directly:
//
//   1. the CLI holds NO cluster logic. Every subcommand is a parse, one call to
//      a daemon verb, and a rendering. If that ever stops being true, the TUI's
//      /cluster and this command can disagree, and one of them is then lying.
//
//   2. every failure exits non-zero with a message naming the fix. A headless
//      box is the whole use case; "it didn't work" with no next step is not an
//      acceptable answer over SSH.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseClusterCommand,
  runClusterCommand,
  CLUSTER_SUBCOMMANDS,
} from '../../cluster/commands.ts';
import {
  extractOperatorToken,
  resolveRemoteDaemonTarget,
  type DaemonFetch,
} from '../../cluster/remote-daemon-target.ts';
import { clipboardEscapeSequence, describeAge, renderStatus } from '../../cluster/render.ts';

/**
 * A control-plane binding, without a real ConfigManager.
 *
 * Cast rather than typed structurally because `get` is generic over ConfigKey
 * and returns ConfigValue<K>; a stub cannot satisfy that relation honestly, and
 * pretending otherwise with `any` would hide a genuine mismatch elsewhere.
 */
const CONFIG: Pick<ConfigManager, 'get'> = {
  get: ((key: string): unknown => {
    if (key === 'controlPlane.host') return '127.0.0.1';
    if (key === 'controlPlane.port') return 4319;
    if (key === 'controlPlane.hostMode') return 'local';
    if (key === 'controlPlane.tlsMode') return 'off';
    return undefined;
  }) as ConfigManager['get'],
};

const TOKEN_FILE = JSON.stringify({ token: 'gv_test_token', peerId: 'abc', createdAt: 1 });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('argument parsing', () => {
  test('accepts every subcommand and rejects anything else by name', () => {
    for (const subcommand of CLUSTER_SUBCOMMANDS) {
      const parsed = parseClusterCommand([subcommand, ...(subcommand === 'forget' ? ['node-b'] : []),
        ...(subcommand === 'rename' ? ['a name'] : [])]);
      expect(parsed.errors).toEqual([]);
      expect(parsed.subcommand).toBe(subcommand);
    }
    const bad = parseClusterCommand(['stauts']);
    expect(bad.errors[0]).toContain("'stauts' is not a cluster command");
    expect(bad.errors[0]).toContain('status');
  });

  test('reads flags in both --flag value and --flag=value form', () => {
    const spaced = parseClusterCommand(['join', '--group', 'gABC', '--key', 'gvj1-AAAA']);
    expect(spaced.group).toBe('gABC');
    expect(spaced.key).toBe('gvj1-AAAA');
    const inline = parseClusterCommand(['join', '--group=gABC', '--key=gvj1-AAAA']);
    expect(inline.group).toBe('gABC');
    expect(inline.key).toBe('gvj1-AAAA');
  });

  test('an unknown flag is an error rather than being quietly ignored', () => {
    const parsed = parseClusterCommand(['join', '--gruop', 'gABC']);
    expect(parsed.errors[0]).toContain("'--gruop' is not a flag");
  });

  test('a flag with no value is an error rather than swallowing the next flag', () => {
    const parsed = parseClusterCommand(['join', '--group', '--key', 'k']);
    expect(parsed.errors).toContain('--group needs a value');
  });

  test('--port must be a real port', () => {
    expect(parseClusterCommand(['status', '--port', 'eight']).errors[0]).toContain('--port must be a number');
    expect(parseClusterCommand(['status', '--port', '99999']).errors[0]).toContain('--port must be a number');
    expect(parseClusterCommand(['status', '--port', '4319']).port).toBe(4319);
  });

  test('forget and rename say what they are missing', () => {
    expect(parseClusterCommand(['forget']).errors[0]).toContain('cluster nodes');
    expect(parseClusterCommand(['rename']).errors[0]).toContain('cluster rename');
  });
});

describe('the remote-target convention', () => {
  test('with no flags it targets the local daemon with the on-disk operator token', () => {
    const resolved = resolveRemoteDaemonTarget({
      flags: {},
      configManager: CONFIG,
      daemonHomeDir: '/nowhere',
      readToken: () => TOKEN_FILE,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.target.baseUrl).toBe('http://127.0.0.1:4319');
    expect(resolved.target.token).toBe('gv_test_token');
    expect(resolved.target.isLocal).toBe(true);
  });

  test('--host and --port retarget it, and --token overrides the file', () => {
    const resolved = resolveRemoteDaemonTarget({
      flags: { host: '10.0.0.7', port: 5000, token: 'supplied' },
      configManager: CONFIG,
      daemonHomeDir: '/nowhere',
      readToken: () => TOKEN_FILE,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.target.baseUrl).toBe('http://10.0.0.7:5000');
    expect(resolved.target.token).toBe('supplied');
    expect(resolved.target.isLocal).toBe(false);
  });

  test('an IPv6 host is bracketed so the port is not read as part of the address', () => {
    const resolved = resolveRemoteDaemonTarget({
      flags: { host: 'fd00::5', port: 4319 },
      configManager: CONFIG,
      daemonHomeDir: '/nowhere',
      readToken: () => TOKEN_FILE,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.target.baseUrl).toBe('http://[fd00::5]:4319');
  });

  test('a missing token refuses, and the fix differs for local and remote', () => {
    const local = resolveRemoteDaemonTarget({
      flags: {}, configManager: CONFIG, daemonHomeDir: '/nowhere', readToken: () => undefined,
    });
    expect(local.ok).toBe(false);
    if (!local.ok) expect(local.fix).toContain('start the daemon once');

    const remote = resolveRemoteDaemonTarget({
      flags: { host: '10.0.0.7' }, configManager: CONFIG, daemonHomeDir: '/nowhere', readToken: () => undefined,
    });
    expect(remote.ok).toBe(false);
    if (!remote.ok) expect(remote.fix).toContain('the machine you are trying to reach');
  });

  test('the operator token is read OUT of the token file, not sent as the whole file', () => {
    // The first live run of this command sent the entire JSON document as the
    // bearer credential and got a 401 that looked exactly like a stale token.
    expect(extractOperatorToken(TOKEN_FILE)).toBe('gv_test_token');
    expect(extractOperatorToken('  bare-token  ')).toBe('bare-token');
    expect(extractOperatorToken('{not json')).toBeUndefined();
    expect(extractOperatorToken(undefined)).toBeUndefined();
  });
});

describe('running a subcommand', () => {
  const base = {
    configManager: CONFIG,
    daemonHomeDir: '/nowhere',
    readToken: () => TOKEN_FILE,
    now: () => 1_000_000,
    isTerminal: false,
  };

  test('status renders the daemon answer and exits zero', async () => {
    const result = await runClusterCommand({
      ...base,
      argv: ['status'],
      fetchImpl: async () => jsonResponse({
        ok: true,
        data: {
          membership: 'no-group', groupId: null, groupName: null, nodeId: 'n1', nodeName: 'machine n1',
          version: '1.0.0', memberCount: 0, surfaces: null, keyGeneration: null, keyGenerationsHeld: 0,
          keyGenerationCap: 16, acceptedGenerations: [], removedNodeCount: 0, rotationHours: 24,
          wire: null, replication: null, advice: 'run `cluster create` here, or `cluster join`',
        },
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('this machine is not in a group');
    expect(result.lines.join('\n')).toContain('cluster create');
  });

  test('--json prints the daemon data verbatim rather than a second rendering', async () => {
    const data = { groupId: 'gABC', groupName: 'workshop', joinKey: 'gvj1-AAAA' };
    const result = await runClusterCommand({
      ...base,
      argv: ['key', '--json'],
      fetchImpl: async () => jsonResponse({ ok: true, data }),
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.lines.join('\n'))).toEqual({ ok: true, data });
  });

  test('a daemon refusal is passed through with its own fix, exiting non-zero', async () => {
    const result = await runClusterCommand({
      ...base,
      argv: ['key'],
      fetchImpl: async () => jsonResponse(
        { ok: false, error: 'this machine is not in a group', fix: 'create one with `cluster create`' },
        409,
      ),
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('this machine is not in a group');
    expect(result.lines.join('\n')).toContain('cluster create');
  });

  test('an unreachable daemon names what to check, and does not look like a refusal', async () => {
    const result = await runClusterCommand({
      ...base,
      argv: ['status'],
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('could not reach');
    expect(result.lines.join('\n')).toContain('service-status');
  });

  test('a rejected token says so instead of reporting a generic failure', async () => {
    const result = await runClusterCommand({
      ...base,
      argv: ['status'],
      fetchImpl: async () => new Response('no', { status: 401 }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('refused the operator token');
  });

  test('an older daemon that lacks the route says to update it', async () => {
    const result = await runClusterCommand({
      ...base,
      argv: ['nodes'],
      fetchImpl: async () => new Response('nope', { status: 404 }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('older build');
  });

  test('create and forget send their arguments in the request body', async () => {
    const seen: { path: string; body: unknown }[] = [];
    const capture: DaemonFetch = async (url, init) => {
      seen.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body ?? '{}')) });
      return jsonResponse({ ok: true, data: { groupId: 'g', groupName: 'n', joinKey: 'k', generatedKey: true,
        nodeId: 'x', displayName: 'x', memberCount: 1, keyGeneration: 1 } });
    };
    await runClusterCommand({ ...base, argv: ['create', '--name', 'the workshop'], fetchImpl: capture });
    await runClusterCommand({ ...base, argv: ['forget', 'node-b'], fetchImpl: capture });
    expect(seen[0]).toEqual({ path: '/api/cluster/create', body: { name: 'the workshop' } });
    expect(seen[1]).toEqual({ path: '/api/cluster/forget', body: { nodeId: 'node-b' } });
  });

  test('join without a group or key, with no terminal to ask on, says how to pass them', async () => {
    const result = await runClusterCommand({
      ...base,
      argv: ['join'],
      fetchImpl: async () => jsonResponse({ ok: true, data: [] }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('--group <id> --key <join key>');
  });

  test('join can be driven entirely by prompts when there is somewhere to ask', async () => {
    const answers = ['gABC', 'gvj1-THEKEY'];
    const result = await runClusterCommand({
      ...base,
      argv: ['join'],
      prompt: async () => answers.shift() ?? '',
      fetchImpl: async (url) => (String(url).endsWith('/groups')
        ? jsonResponse({ ok: true, data: [{ groupId: 'gABC', displayName: 'workshop', nodeCount: 1, version: '1.0.0', lastSeenAt: 999_000 }] })
        : jsonResponse({ ok: true, data: { groupId: 'gABC', groupName: 'workshop', memberCount: 2 } })),
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('joined "workshop"');
  });
});

describe('showing the join key', () => {
  test('prints the key AND attempts a clipboard copy, never silently doing nothing', async () => {
    const result = await runClusterCommand({
      configManager: CONFIG,
      daemonHomeDir: '/nowhere',
      readToken: () => TOKEN_FILE,
      isTerminal: true,
      argv: ['key'],
      fetchImpl: async () => jsonResponse({
        ok: true,
        data: { groupId: 'gABC', groupName: 'workshop', joinKey: 'gvj1-THEKEY' },
      }),
    });
    expect(result.exitCode).toBe(0);
    // The key itself is always printed, whatever the terminal does with OSC 52.
    expect(result.lines.join('\n')).toContain('gvj1-THEKEY');
    expect(result.lines.join('\n')).toContain('clipboard');
    expect(result.rawOutput).toBe(clipboardEscapeSequence('gvj1-THEKEY'));
  });

  test('outside a terminal it says no copy was attempted rather than claiming one', async () => {
    const result = await runClusterCommand({
      configManager: CONFIG,
      daemonHomeDir: '/nowhere',
      readToken: () => TOKEN_FILE,
      isTerminal: false,
      argv: ['key'],
      fetchImpl: async () => jsonResponse({
        ok: true,
        data: { groupId: 'gABC', groupName: 'workshop', joinKey: 'gvj1-THEKEY' },
      }),
    });
    expect(result.rawOutput).toBeUndefined();
    expect(result.lines.join('\n')).toContain('not a terminal');
  });
});

describe('rotate', () => {
  const base = {
    configManager: CONFIG,
    daemonHomeDir: '/nowhere',
    readToken: () => TOKEN_FILE,
    isTerminal: false,
  };

  test('asks for the routine rotation by default, and says nothing was interrupted', async () => {
    let sent: unknown;
    const result = await runClusterCommand({
      ...base,
      argv: ['rotate'],
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse({
          ok: true,
          data: { groupId: 'gABC', keyGeneration: 4, memberCount: 3, immediate: false, acceptedGenerations: [4, 3] },
        });
      },
    });
    expect(sent).toEqual({ immediate: false });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('generation 4');
    expect(result.lines.join('\n')).toContain('nothing is interrupted');
  });

  test('--now asks for the immediate one, and says what that costs', async () => {
    let sent: unknown;
    const result = await runClusterCommand({
      ...base,
      argv: ['rotate', '--now'],
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse({
          ok: true,
          data: { groupId: 'gABC', keyGeneration: 5, memberCount: 3, immediate: true, acceptedGenerations: [5] },
        });
      },
    });
    expect(sent).toEqual({ immediate: true });
    expect(result.lines.join('\n')).toContain('stopped being accepted immediately');
    expect(result.lines.join('\n')).toContain('asleep');
  });
});

describe('rendering', () => {
  test('status never contains key material of any kind', () => {
    const lines = renderStatus({
      membership: 'member', groupId: 'gABC', groupName: 'workshop', nodeId: 'n1', nodeName: 'machine n1',
      version: '1.0.0', memberCount: 2, surfaces: [{ surfaceId: 's'.padEnd(33, 'a'), reason: 'elected' }],
      keyGeneration: 3, keyGenerationsHeld: 4, keyGenerationCap: 16, acceptedGenerations: [3, 2],
      removedNodeCount: 1, rotationHours: 24,
      wire: { sent: 1, received: 2, droppedOtherGroup: 3, droppedBadSignature: 0, droppedMalformed: 0,
        droppedOldGeneration: 0, droppedNoGroup: 0 },
      replication: {
        revision: 12, entries: 4, secrets: 1, tombstones: 0,
        lastAppliedFrom: 'node-a', lastAppliedAt: 999_000, pendingProposals: 0,
      },
      advice: null,
    }, 1_000_000).join('\n');
    expect(lines).toContain('generation 3');
    expect(lines).toContain('accepting 3 and 2');
    expect(lines).not.toMatch(/join key/i);
    expect(lines).not.toMatch(/gvj1-/);
    // Replication is reported as counts and provenance, never as a value.
    expect(lines).toContain('4 settings and 1 credential at revision 12');
    expect(lines).toContain('last change from node-a');
  });

  test('ages read as ages', () => {
    expect(describeAge(1_000_000, 1_000_000)).toBe('0s ago');
    expect(describeAge(1_000_000, 1_090_000)).toBe('2m ago');
    expect(describeAge(0, 3 * 24 * 60 * 60 * 1_000)).toBe('3d ago');
  });
});

describe('wiring', () => {
  test('the /cluster command and the CLI go through the same caller', () => {
    const source = readFileSync(join(import.meta.dir, '../../input/commands/cluster-runtime.ts'), 'utf-8');
    expect(source).toContain("import { runClusterCommand, CLUSTER_SUBCOMMANDS } from '../../cluster/commands.ts';");
    expect(source).toContain('await runClusterCommand({');
    // No second implementation: the TUI command must not build requests itself.
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('/api/cluster/');
  });

  test('/cluster is registered with the rest of the commands', () => {
    const source = readFileSync(join(import.meta.dir, '../../input/commands.ts'), 'utf-8');
    expect(source).toContain('registerClusterRuntimeCommands');
    const hints = readFileSync(join(import.meta.dir, '../../input/command-args-hint.ts'), 'utf-8');
    expect(hints).toContain('cluster: CLUSTER_SUBCOMMAND_ARG_HINTS');
  });

  test('the daemon CLI intercepts `cluster` before composing a runtime', () => {
    const source = readFileSync(join(import.meta.dir, '../../daemon/cli.ts'), 'utf-8');
    const clusterAt = source.indexOf("rawArgs[0] === 'cluster'");
    const runtimeAt = source.indexOf('createRuntimeServices(');
    expect(clusterAt).toBeGreaterThan(0);
    expect(runtimeAt).toBeGreaterThan(0);
    expect(clusterAt).toBeLessThan(runtimeAt);
  });
});
