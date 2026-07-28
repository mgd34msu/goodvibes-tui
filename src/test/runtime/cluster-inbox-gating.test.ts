/**
 * The inbox poller under LAN leadership.
 *
 * This repository composes an inbound consumer the SDK daemon facade knows
 * nothing about: the Slack/Discord/email poller in daemon/handlers/inbox. If it
 * is not gated HERE it is not gated anywhere, and two goodvibes nodes on one
 * network each fetch the same message and answer it twice. These tests hold
 * that wiring in place:
 *
 *   - a gated registration does not fetch until leadership says so;
 *   - the READ path (`channels.inbox.list`) is never gated, so a standby still
 *     answers questions about what has already arrived;
 *   - an ungated registration behaves exactly as it always has, because every
 *     existing caller and test depends on that;
 *   - composing the coordinator touches nothing — no socket, no state file —
 *     so building a runtime in a test never joins a network.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { HandlerContext } from '../../daemon/handlers/context.ts';
import type { DaemonCredentialStore } from '../../daemon/handlers/credentials.ts';
import {
  INBOX_LIST_METHOD_ID,
  registerInboxMethods,
  type InboxListOutput,
  type InboxPollingControl,
} from '../../daemon/handlers/inbox/index.ts';
import {
  clearAdapterRegistry,
  registerAdapterFactory,
  type InboundChannelItem,
  type ProviderPollResult,
} from '../../daemon/handlers/inbox/provider-adapter.ts';
import { inboxSurface, surfaceIdFor } from '@pellux/goodvibes-sdk/platform/cluster';
import { createClusterComposition, inboxPollerGate } from '../../runtime/cluster-composition.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const logger = { info() {}, warn() {}, error() {} };

function fakeCredentials(): DaemonCredentialStore {
  return {
    async resolveRef() { return null; },
    async resolveConfigSecret() { return null; },
    async put() {},
    async has() { return false; },
  };
}

let pollCount = 0;
/** Per-provider fetch counts, so one account's polling can be told from another's. */
let pollsByProvider: Record<string, number> = {};

function registerCountingProvider(id: string): void {
  pollsByProvider[id] = 0;
  registerAdapterFactory(id, () => ({
    id,
    pollIntervalMs: 30_000,
    async poll(): Promise<ProviderPollResult> {
      pollCount += 1;
      pollsByProvider[id] = (pollsByProvider[id] ?? 0) + 1;
      const item: InboundChannelItem = {
        provider: id,
        kind: 'dm',
        fromDigest: 'cafebabedeadbeef',
        subjectPreview: 'Direct message',
        bodyPreview: 'hello world',
        receivedAt: 1_000 + pollCount,
        unread: true,
        id: `${id}-item-${pollCount}`,
      };
      return { state: 'ready', items: [item] };
    },
  }));
}

/** A provider that counts how many times it was actually asked to fetch. */
function installCountingProvider(...ids: string[]): void {
  clearAdapterRegistry();
  pollCount = 0;
  pollsByProvider = {};
  for (const id of ids.length > 0 ? ids : ['fake']) registerCountingProvider(id);
}

let dir: string;
let catalog: GatewayMethodCatalog;
let ctx: HandlerContext;

beforeEach(async () => {
  dir = await makeProjectTempDir('cluster-inbox');
  catalog = new GatewayMethodCatalog();
  installCountingProvider();
  ctx = {
    catalog,
    credentials: fakeCredentials(),
    // See daemon/inbox/register.test.ts: the cast avoids TS2321 against the
    // SDK's very large ConfigValue mapped type, not a real shape mismatch.
    configManager: {
      get: ((_key: string) => undefined) as unknown as HandlerContext['configManager']['get'],
      getCategory: ((_category: string) => ({})) as unknown as HandlerContext['configManager']['getCategory'],
    },
    workingDirectory: dir,
    homeDirectory: dir,
    logger,
  };
});

afterEach(async () => {
  clearAdapterRegistry();
  await rm(dir, { recursive: true, force: true });
});

async function invoke(): Promise<InboxListOutput> {
  return (await catalog.invoke(INBOX_LIST_METHOD_ID, {
    body: {},
    query: {},
    context: { authToken: 'fake-auth', scopes: ['read:channels'] },
  })) as InboxListOutput;
}

describe('inbox polling under leadership', () => {
  test('a gated registration fetches nothing until the gate is started', async () => {
    let control: InboxPollingControl | null = null;
    const unregister = registerInboxMethods(ctx, undefined, {
      registerBuiltins: false,
      gatePolling: (_providerId, received) => { control = received; },
    });

    expect(control).not.toBeNull();
    // The persisted feed is still SERVED — a node that is not fetching must
    // still answer what has already arrived.
    await expect(invoke()).resolves.toMatchObject({ items: [], total: 0 });
    expect(pollCount).toBe(0);

    await control!.start();
    expect(pollCount).toBeGreaterThan(0);
    const afterStart = await invoke();
    expect(afterStart.items.length).toBeGreaterThan(0);

    await control!.stop();
    const countAtStop = pollCount;
    // Nothing further may be scheduled once stop() has resolved: the ordered
    // handoff sends the resignation immediately after, and a poll that fired
    // later would be this node consuming after it said it had stopped.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pollCount).toBe(countAtStop);

    unregister();
  });

  test('an ungated registration polls immediately, exactly as before', async () => {
    const unregister = registerInboxMethods(ctx, undefined, { registerBuiltins: false });
    // The handler awaits the same bootstrap the poll seed runs on.
    await invoke();
    expect(pollCount).toBeGreaterThan(0);
    unregister();
  });

  test('the gate presented to the coordinator drives that same control', async () => {
    let control: InboxPollingControl | null = null;
    const unregister = registerInboxMethods(ctx, undefined, {
      registerBuiltins: false,
      gatePolling: (_providerId, received) => { control = received; },
    });
    const gate = inboxPollerGate('fake', control!);
    expect(gate.id).toBe('inbox-poller:fake');
    expect(gate.surface).toEqual({ kind: 'inbox', discriminator: 'fake' });

    expect(pollCount).toBe(0);
    await gate.start({ replayFromMs: null, reason: 'test' });
    expect(pollCount).toBeGreaterThan(0);
    await gate.stop('test');
    unregister();
  });

  test('each inbox account is gated on its own, and stopping one leaves the other reading', async () => {
    installCountingProvider('work-slack', 'mailbox');
    const controls = new Map<string, InboxPollingControl>();
    const unregister = registerInboxMethods(ctx, undefined, {
      registerBuiltins: false,
      gatePolling: (providerId, received) => { controls.set(providerId, received); },
    });

    // One gate per account, not one for the poller — this is what lets two
    // machines split the accounts between them.
    expect([...controls.keys()].sort()).toEqual(['mailbox', 'work-slack']);

    await controls.get('work-slack')!.start();
    await controls.get('mailbox')!.start();
    expect(pollsByProvider['work-slack']).toBeGreaterThan(0);
    expect(pollsByProvider['mailbox']).toBeGreaterThan(0);

    // Hand the mailbox to another machine. The work account must keep reading:
    // a blanket stop here would take an account offline that nothing asked to
    // move, which is the coupling the per-surface split removes.
    await controls.get('mailbox')!.stop();
    const mailboxAtStop = pollsByProvider['mailbox'];
    await controls.get('work-slack')!.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pollsByProvider['mailbox']).toBe(mailboxAtStop);

    unregister();
  });

  test('an account name is hashed into its surface, never sent as itself', () => {
    const gate = inboxPollerGate('accounts@example.com', {
      start: async () => {},
      stop: async () => {},
    });
    const digest = surfaceIdFor(gate.surface);
    // The digest is what travels; the address stays on this machine. Two nodes
    // reading the same account still meet in one election because they compute
    // the identical digest from the identical id.
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
    expect(digest).not.toContain('example');
    expect(surfaceIdFor(inboxSurface('accounts@example.com'))).toBe(digest);
    expect(surfaceIdFor(inboxSurface('someone-else@example.com'))).not.toBe(digest);
  });
});

describe('cluster composition', () => {
  test('building the coordinator opens no socket and writes no state', async () => {
    const stateRoot = await makeProjectTempDir('cluster-state');
    const shellPaths = {
      resolveProjectPath: (...segments: string[]) => join(stateRoot, ...segments),
    } as unknown as Parameters<typeof createClusterComposition>[0]['shellPaths'];

    const coordinator = createClusterComposition({
      configManager: ctx.configManager,
      shellPaths,
    });

    // Composing a runtime must never join a network or mint an identity —
    // every test that builds RuntimeServices would otherwise open a UDP socket
    // and write a node-id file into the developer's home.
    expect(coordinator.isMaster).toBe(false);
    await expect(readdir(stateRoot)).resolves.toEqual([]);

    await rm(stateRoot, { recursive: true, force: true });
  });

  test('registering a gate before start does not run it', async () => {
    const stateRoot = await makeProjectTempDir('cluster-state');
    const shellPaths = {
      resolveProjectPath: (...segments: string[]) => join(stateRoot, ...segments),
    } as unknown as Parameters<typeof createClusterComposition>[0]['shellPaths'];
    const coordinator = createClusterComposition({ configManager: ctx.configManager, shellPaths });

    let started = 0;
    coordinator.register({
      id: 'probe',
      surface: inboxSurface('probe-account'),
      start: async () => { started += 1; },
      stop: async () => {},
    });
    expect(started).toBe(0);

    await rm(stateRoot, { recursive: true, force: true });
  });
});
