/**
 * commands.ts — `goodvibes-daemon cluster …`, and `/cluster` in the TUI.
 *
 * The authoritative surface for LAN groups. A homelab node is headless: the
 * operator SSHes in, and everything they can do to a group they must be able to
 * do here.
 *
 * This module contains NO logic of its own. It parses arguments, calls a daemon
 * verb over the convention in remote-daemon-target.ts, and renders the answer.
 * The daemon decides everything else, which is what makes this command, the
 * TUI's `/cluster` and any web UI three renderings of one implementation.
 *
 * Every failure exits non-zero with a plain-language message naming the fix.
 */
import { createInterface } from 'node:readline/promises';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type {
  RotateKeyResult,
  CreateGroupResult,
  DiscoveredGroup,
  ForgetNodeResult,
  GroupStatusReport,
  JoinGroupResult,
  JoinKeyResult,
  NodesResult,
} from '@pellux/goodvibes-sdk/platform/cluster';
import {
  callDaemonVerb,
  resolveRemoteDaemonTarget,
  type DaemonFetch,
  type DaemonVerbOutcome,
} from './remote-daemon-target.ts';
import {
  renderCreated,
  renderDiscovered,
  renderFailure,
  renderForgotten,
  renderJoinKey,
  renderJoinKeyQr,
  renderJoined,
  renderNodes,
  renderRotated,
  renderStatus,
} from './render.ts';

export const CLUSTER_SUBCOMMANDS = [
  'status', 'create', 'join', 'key', 'nodes', 'forget', 'rotate', 'leave', 'rename', 'groups',
] as const;
export type ClusterSubcommand = (typeof CLUSTER_SUBCOMMANDS)[number];

export function isClusterSubcommand(value: string | undefined): value is ClusterSubcommand {
  return typeof value === 'string' && (CLUSTER_SUBCOMMANDS as readonly string[]).includes(value);
}

/** What the parser produced, or why it could not. */
export interface ParsedClusterCommand {
  readonly subcommand: ClusterSubcommand | null;
  readonly positional: string | null;
  readonly name: string | null;
  readonly passphrase: string | null;
  readonly group: string | null;
  readonly key: string | null;
  readonly host: string | null;
  readonly port: number | null;
  readonly token: string | null;
  readonly json: boolean;
  readonly yes: boolean;
  /** `key` only: also render the join key as a QR code. */
  readonly qr: boolean;
  /** `rotate` only: stop accepting the outgoing key at once. */
  readonly now: boolean;
  readonly errors: readonly string[];
}

const VALUE_FLAGS = new Set(['--name', '--passphrase', '--group', '--key', '--host', '--port', '--token']);

/**
 * Parse `cluster <subcommand> [flags]`.
 *
 * Unknown flags are an ERROR rather than being ignored. A typo in `--group`
 * that silently became "no group given" would send the operator to the
 * interactive picker with no explanation of why their arguments vanished.
 */
export function parseClusterCommand(argv: readonly string[]): ParsedClusterCommand {
  const errors: string[] = [];
  let subcommand: ClusterSubcommand | null = null;
  let positional: string | null = null;
  const values = new Map<string, string>();
  let json = false;
  let yes = false;
  let qr = false;
  let now = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--json') { json = true; continue; }
    if (token === '-y' || token === '--yes') { yes = true; continue; }
    if (token === '--qr') { qr = true; continue; }
    if (token === '--now') { now = true; continue; }
    if (VALUE_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        errors.push(`${token} needs a value`);
        continue;
      }
      values.set(token, value);
      index += 1;
      continue;
    }
    const inline = /^(--[a-z]+)=(.*)$/.exec(token);
    if (inline && VALUE_FLAGS.has(inline[1] ?? '')) {
      values.set(inline[1] as string, inline[2] ?? '');
      continue;
    }
    if (token.startsWith('-')) {
      errors.push(`'${token}' is not a flag this command understands`);
      continue;
    }
    if (subcommand === null) {
      if (!isClusterSubcommand(token)) {
        errors.push(`'${token}' is not a cluster command — try one of: ${CLUSTER_SUBCOMMANDS.join(', ')}`);
        continue;
      }
      subcommand = token;
      continue;
    }
    if (positional === null) {
      positional = token;
      continue;
    }
    errors.push(`'${token}' is one argument too many`);
  }

  const portText = values.get('--port');
  let port: number | null = null;
  if (portText !== undefined) {
    const parsed = Number(portText);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
      errors.push(`--port must be a number between 1 and 65535, not '${portText}'`);
    } else {
      port = parsed;
    }
  }
  if (subcommand === 'forget' && positional === null) {
    errors.push('forget needs the machine to remove — run `cluster nodes` to see them');
  }
  if (subcommand === 'rename' && positional === null && values.get('--name') === undefined) {
    errors.push('rename needs the new name — `cluster rename "the workshop"`');
  }

  return {
    subcommand,
    positional,
    name: values.get('--name') ?? null,
    passphrase: values.get('--passphrase') ?? null,
    group: values.get('--group') ?? null,
    key: values.get('--key') ?? null,
    host: values.get('--host') ?? null,
    port,
    token: values.get('--token') ?? null,
    json,
    yes,
    qr,
    now,
    errors,
  };
}

/** What the caller prints and exits with. */
export interface ClusterCommandResult {
  readonly lines: readonly string[];
  readonly exitCode: number;
  /** Written raw to stdout — the OSC 52 clipboard attempt, when there is one. */
  readonly rawOutput?: string | undefined;
}

export interface RunClusterCommandInput {
  readonly argv: readonly string[];
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly daemonHomeDir: string;
  readonly now?: (() => number) | undefined;
  readonly isTerminal?: boolean | undefined;
  /** Injected in tests so nothing opens a socket or reads a real token. */
  readonly fetchImpl?: DaemonFetch | undefined;
  readonly readToken?: ((daemonHomeDir: string) => string | undefined) | undefined;
  /** Injected in tests; the real one reads stdin. */
  readonly prompt?: ((question: string) => Promise<string>) | undefined;
}

function failure(error: string, fix: string, json: boolean): ClusterCommandResult {
  return {
    lines: json
      ? [JSON.stringify({ ok: false, error, fix }, null, 2)]
      : renderFailure(error, fix),
    exitCode: 1,
  };
}

function success(data: unknown, lines: readonly string[], json: boolean, rawOutput?: string): ClusterCommandResult {
  return {
    lines: json ? [JSON.stringify({ ok: true, data }, null, 2)] : lines,
    exitCode: 0,
    ...(rawOutput ? { rawOutput } : {}),
  };
}

/** Ask a question on stdin. Only ever called when stdin is a terminal. */
async function askOnStdin(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function runClusterCommand(input: RunClusterCommandInput): Promise<ClusterCommandResult> {
  const parsed = parseClusterCommand(input.argv);
  if (parsed.errors.length > 0) {
    return failure(parsed.errors[0] as string, `usage: goodvibes-daemon cluster <${CLUSTER_SUBCOMMANDS.join('|')}>`, parsed.json);
  }
  if (!parsed.subcommand) {
    return failure(
      'no cluster command was given',
      `usage: goodvibes-daemon cluster <${CLUSTER_SUBCOMMANDS.join('|')}>`,
      parsed.json,
    );
  }

  const resolved = resolveRemoteDaemonTarget({
    flags: {
      ...(parsed.host !== null ? { host: parsed.host } : {}),
      ...(parsed.port !== null ? { port: parsed.port } : {}),
      ...(parsed.token !== null ? { token: parsed.token } : {}),
    },
    configManager: input.configManager,
    daemonHomeDir: input.daemonHomeDir,
    ...(input.readToken ? { readToken: input.readToken } : {}),
  });
  if (!resolved.ok) return failure(resolved.error, resolved.fix, parsed.json);

  const now = input.now?.() ?? Date.now();
  const isTerminal = input.isTerminal ?? Boolean(process.stdout.isTTY);
  const call = <T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<DaemonVerbOutcome<T>> =>
    callDaemonVerb<T>(resolved.target, path, { method, ...(body === undefined ? {} : { body }) }, input.fetchImpl ?? fetch);

  switch (parsed.subcommand) {
    case 'status': {
      const result = await call<GroupStatusReport>('/api/cluster/status');
      return result.ok
        ? success(result.data, renderStatus(result.data, now), parsed.json)
        : failure(result.error, result.fix, parsed.json);
    }
    case 'nodes': {
      const result = await call<NodesResult>('/api/cluster/nodes');
      return result.ok
        ? success(result.data, renderNodes(result.data, now), parsed.json)
        : failure(result.error, result.fix, parsed.json);
    }
    case 'groups': {
      const result = await call<readonly DiscoveredGroup[]>('/api/cluster/groups');
      return result.ok
        ? success(result.data, renderDiscovered(result.data, now), parsed.json)
        : failure(result.error, result.fix, parsed.json);
    }
    case 'key': {
      const result = await call<JoinKeyResult>('/api/cluster/key');
      if (!result.ok) return failure(result.error, result.fix, parsed.json);
      const rendered = renderJoinKey(result.data, isTerminal && !parsed.json);
      const lines = parsed.qr
        ? [...rendered.lines, '', ...renderJoinKeyQr(result.data.joinKey)]
        : rendered.lines;
      return success(result.data, lines, parsed.json, rendered.clipboardSequence ?? undefined);
    }
    case 'create': {
      const result = await call<CreateGroupResult>('/api/cluster/create', 'POST', {
        ...(parsed.name !== null ? { name: parsed.name } : {}),
        ...(parsed.passphrase !== null ? { passphrase: parsed.passphrase } : {}),
      });
      return result.ok
        ? success(result.data, renderCreated(result.data), parsed.json)
        : failure(result.error, result.fix, parsed.json);
    }
    case 'rotate': {
      const result = await call<RotateKeyResult>('/api/cluster/rotate', 'POST', { immediate: parsed.now });
      return result.ok
        ? success(result.data, renderRotated(result.data), parsed.json)
        : failure(result.error, result.fix, parsed.json);
    }
    case 'leave': {
      const result = await call<{ groupId: string; groupName: string }>('/api/cluster/leave', 'POST');
      return result.ok
        ? success(result.data, [`left "${result.data.groupName}" [${result.data.groupId}]`,
          'this machine no longer coordinates with it. The other machines still list it —',
          'run `cluster forget` on one of them to tidy up.'], parsed.json)
        : failure(result.error, result.fix, parsed.json);
    }
    case 'rename': {
      const name = parsed.name ?? parsed.positional ?? '';
      const result = await call<{ groupId: string; groupName: string }>('/api/cluster/rename', 'POST', { name });
      return result.ok
        ? success(result.data, [`the group is now called "${result.data.groupName}"`,
          'this name is visible to anything on this network, and every machine in the',
          'group will pick it up shortly.'], parsed.json)
        : failure(result.error, result.fix, parsed.json);
    }
    case 'forget': {
      const result = await call<ForgetNodeResult>('/api/cluster/forget', 'POST', { nodeId: parsed.positional });
      return result.ok
        ? success(result.data, renderForgotten(result.data), parsed.json)
        : failure(result.error, result.fix, parsed.json);
    }
    case 'join':
      return runJoin(parsed, call, now, input, isTerminal);
  }
}

/**
 * `cluster join`.
 *
 * Two shapes, and both matter. With `--group` and `--key` it is a scriptable
 * one-liner, which is what provisioning a machine from a config-management tool
 * needs. Without them it lists the groups advertising themselves on this
 * network and asks — which is what a person adding their second machine needs,
 * because they do not know the group id and should not have to.
 */
async function runJoin(
  parsed: ParsedClusterCommand,
  call: <T>(path: string, method?: 'GET' | 'POST', body?: unknown) => Promise<DaemonVerbOutcome<T>>,
  now: number,
  input: RunClusterCommandInput,
  isTerminal: boolean,
): Promise<ClusterCommandResult> {
  let groupId = parsed.group;
  let joinKey = parsed.key;

  if (groupId === null || joinKey === null) {
    const interactive = input.prompt !== undefined || (isTerminal && Boolean(process.stdin.isTTY));
    if (!interactive) {
      return failure(
        'a group and a join key are both needed, and this is not an interactive terminal',
        'pass them directly: cluster join --group <id> --key <join key>',
        parsed.json,
      );
    }
    const ask = input.prompt ?? askOnStdin;

    if (groupId === null) {
      const found = await call<readonly DiscoveredGroup[]>('/api/cluster/groups');
      if (!found.ok) return failure(found.error, found.fix, parsed.json);
      if (found.data.length === 0) {
        return failure(
          'no goodvibes groups are advertising themselves on this network',
          'check the other machine is switched on with clustering enabled, or join by id: '
            + 'cluster join --group <id> --key <join key>',
          parsed.json,
        );
      }
      const listing = renderDiscovered(found.data, now);
      for (const line of listing) process.stdout.write(`${line}\n`);
      const answer = await ask('\nwhich group? (name or id, blank to cancel): ');
      if (answer.length === 0) return { lines: ['cancelled'], exitCode: 130 };
      const chosen = found.data.find((group) => group.groupId === answer)
        ?? found.data.find((group) => group.displayName === answer)
        ?? found.data.find((group) => group.groupId.startsWith(answer));
      if (!chosen) {
        return failure(`no group on this network matches '${answer}'`, 'run `cluster groups` to see them again', parsed.json);
      }
      groupId = chosen.groupId;
    }

    if (joinKey === null) {
      joinKey = await ask('join key (run `cluster key` on a machine already in the group): ');
      if (joinKey.length === 0) return { lines: ['cancelled'], exitCode: 130 };
    }
  }

  const result = await call<JoinGroupResult>('/api/cluster/join', 'POST', { groupId, joinKey });
  return result.ok
    ? success(result.data, renderJoined(result.data), parsed.json)
    : failure(result.error, result.fix, parsed.json);
}
