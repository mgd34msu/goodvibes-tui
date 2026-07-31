/**
 * phone-tool-over-verbs.test.ts — the `phone` tool driving a real device
 * runtime through the real verb handlers, with only the phone itself stubbed.
 *
 * ── Why it is built this way ──────────────────────────────────────────────
 *
 * The one thing that cannot be real in a test is the phone. Everything between
 * the tool and it can be, and is: the SDK's device posture runtime, its
 * capability service, its grants ledger, its capture store, and the actual
 * `devices.*` route handlers bound to a catalog. Only the peer transport is
 * stubbed — the same seam the daemon's own capability test stubs, for the same
 * reason.
 *
 * That matters because the interesting assertions are about a boundary a mock
 * gateway cannot check. A fake that answers whatever it is asked would pass
 * while the tool sent the wrong verb id, read the wrong response key, or
 * rendered a refusal as a failure.
 *
 * ── What is pinned ────────────────────────────────────────────────────────
 *
 * That the tool decides nothing. The confirmation, the durable grant and the
 * refusals all belong to the runtime, and this drives each of them through the
 * tool to prove the tool reports rather than re-decides. And the line this
 * client draws differently from the in-process tool: a person declining is a
 * successful tool result saying they declined, not a tool error — because a
 * model reads a failed call as retryable, and retrying means prompting someone
 * again for the thing they just refused.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { GatewayMethodCatalog, registerDevicesGatewayMethods } from '@pellux/goodvibes-sdk/platform/control-plane';
import {
  DEVICE_CAPABILITY_CONTRACT_VERSION,
  DEVICE_CAPABILITY_IDS,
  DEVICE_NODE_ANNOUNCEMENT_KEY,
  createDevicePostureRuntime,
} from '@pellux/goodvibes-sdk/platform/devices';
import type { DeviceApprovalBridge, DevicePeerTransport, DevicePeerView } from '@pellux/goodvibes-sdk/platform/devices';
import { createDevicesClient } from '../../runtime/client/devices-client.ts';
import { createClientPhoneTool } from '../../runtime/client/phone-tool.ts';
import type { DaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/** PNG-ish bytes; the store only cares that what comes back is what went in. */
const CAPTURE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7, 7, 7, 7]);

const runtimes: Array<{ stopHousekeeping: () => void }> = [];
afterAll(() => { for (const runtime of runtimes.splice(0)) runtime.stopHousekeeping(); });

function pairedPhone(): DevicePeerView {
  return {
    id: 'phone-1',
    label: 'Pixel on the desk',
    kind: 'device',
    platform: 'android',
    version: '1.0.0',
    status: 'connected',
    capabilities: [...DEVICE_CAPABILITY_IDS],
    metadata: {
      [DEVICE_NODE_ANNOUNCEMENT_KEY]: {
        nodeKind: 'web-pwa',
        contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
        capabilities: [...DEVICE_CAPABILITY_IDS],
        secureContext: true,
      },
    },
  };
}

interface Harness {
  readonly tool: ReturnType<typeof createClientPhoneTool>;
  readonly asks: string[];
  approve(decision: 'once' | 'always' | 'deny'): void;
  sendBytes(send: boolean): void;
  pairPhone(paired: boolean): void;
}

function harness(): Harness {
  const root = makeProjectTempDir('gv-phone-verbs-');
  const asks: string[] = [];
  let decision: 'once' | 'always' | 'deny' = 'once';
  let sendBytes = false;
  let paired = true;

  const transport: DevicePeerTransport = {
    listPeers: (kind) => (paired && (kind === undefined || kind === 'device') ? [pairedPhone()] : []),
    invokePeer: async (input) => ({
      completed: true,
      work: {
        id: 'work-1',
        status: 'completed',
        result: {
          contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
          capabilityId: input.command,
          ok: true,
          data: { echoed: input.command },
          ...(sendBytes ? { mediaBase64: Buffer.from(CAPTURE_BYTES).toString('base64'), mediaType: 'image/png' } : {}),
        },
      },
    }),
  };

  const approvals: DeviceApprovalBridge = {
    requestApproval: async ({ request }) => {
      asks.push(String(request.args['capability'] ?? ''));
      if (decision === 'deny') return { approved: false, reason: 'not right now' };
      return decision === 'always' ? { approved: true, rememberTier: 'tool' as const } : { approved: true };
    },
  };

  const catalog = new GatewayMethodCatalog();
  const devicePosture = createDevicePostureRuntime({
    transport,
    approvals,
    config: new ConfigManager({ workingDir: join(root, 'work'), homeDir: root, surfaceRoot: 'tui' }),
    stateDirectory: join(root, 'devices'),
    actor: 'tui:phone-tool',
  });
  runtimes.push(devicePosture);
  registerDevicesGatewayMethods(catalog, devicePosture);

  // The product's own client shape, over the real handlers. `probe` reports a
  // reachable daemon because one is: the catalog IS what a daemon would serve.
  const verbs: DaemonVerbCaller = {
    probe: () => ({ available: true, sdk: {} as never }),
    invoke: async <T,>(methodId: string, input?: unknown): Promise<T> =>
      await catalog.invoke(methodId as never, { context: { admin: true }, body: input ?? {} } as never) as T,
  };

  return {
    tool: createClientPhoneTool(createDevicesClient(verbs)),
    asks,
    approve(next) { decision = next; },
    sendBytes(next) { sendBytes = next; },
    pairPhone(next) { paired = next; },
  };
}

async function run(tool: Harness['tool'], args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await tool.execute(args);
  return JSON.parse(String(result.output ?? '{}')) as Record<string, unknown>;
}

describe('the phone tool reaches a real device runtime over the verbs', () => {
  test('paired phones come from devices.nodes.list, not from anything local', async () => {
    const h = harness();
    const payload = await run(h.tool, { action: 'nodes' });
    expect(payload['paired']).toBe(1);
    expect((payload['nodes'] as Array<{ nodeId: string }>)[0]?.nodeId).toBe('phone-1');
  });

  test('a capability the person allows comes back with the authority that allowed it', async () => {
    const h = harness();
    const payload = await run(h.tool, { action: 'clipboard_read', reason: 'reading the copied link' });
    expect(payload['success']).toBe(true);
    expect(payload['allowed']).toBe(true);
    // The runtime asked — the tool did not decide anything.
    expect(h.asks).toHaveLength(1);
    // Why it was allowed is stated on every result.
    expect(String(payload['authority'])).not.toBe('');
  });

  test('a person declining is a SUCCESSFUL result that says they declined', async () => {
    const h = harness();
    h.approve('deny');
    const result = await h.tool.execute({ action: 'photo', reason: 'checking the whiteboard' });
    // The line this client draws: a refusal is an answer. Reported as a tool
    // error, a model would read it as retryable and prompt the person again.
    expect(result.success).toBe(true);
    const payload = JSON.parse(String(result.output ?? '{}')) as Record<string, unknown>;
    expect(payload['allowed']).toBe(false);
    expect(String(payload['refusal'])).not.toBe('');
    expect(String(payload['detail'])).toContain('not right now');
  });

  test('a durable grant means the second ask is not put to the person again', async () => {
    const h = harness();
    h.approve('always');
    await run(h.tool, { action: 'clipboard_read', reason: 'first' });
    await run(h.tool, { action: 'clipboard_read', reason: 'second' });
    // One prompt, two uses — the grant lives in the runtime's ledger, which is
    // the whole reason the ledger is not in this process.
    expect(h.asks).toHaveLength(1);
  });

  test('a capture is retained by the runtime and read back byte-for-byte', async () => {
    const h = harness();
    h.sendBytes(true);
    const captured = await run(h.tool, { action: 'photo', reason: 'checking the whiteboard' });
    const artifact = captured['artifact'] as Record<string, unknown>;
    expect(artifact).toBeTruthy();
    // The path reported is on the DAEMON's disk and is never opened from here.
    expect(typeof artifact['daemonPath']).toBe('string');

    const listed = await run(h.tool, { action: 'artifacts' });
    expect(Number(listed['retained'])).toBeGreaterThan(0);

    const read = await run(h.tool, { action: 'read', artifactId: String(artifact['artifactId']) });
    expect(read['success']).toBe(true);
    // Base64 over the wire, and the same bytes that went in.
    expect(Buffer.from(String(read['dataBase64']), 'base64').equals(Buffer.from(CAPTURE_BYTES))).toBe(true);
  });

  test('a capture id nobody retained is an error, because there are no bytes', async () => {
    const h = harness();
    const result = await h.tool.execute({ action: 'read', artifactId: 'artifact-that-never-existed' });
    // Distinct from a refusal on purpose: nothing was declined here, the thing
    // asked for simply is not there.
    expect(result.success).toBe(false);
  });

  test('with no phone paired the tool says so instead of asking one for something', async () => {
    const h = harness();
    h.pairPhone(false);
    const payload = await run(h.tool, { action: 'photo', reason: 'checking the whiteboard' });
    expect(payload['success']).toBe(false);
    expect(String(payload['error'])).toContain('No phone is paired');
    // Nothing was put to a person: there was nobody to put it to.
    expect(h.asks).toHaveLength(0);
  });

  test('a request with no reason is refused before any round trip', async () => {
    const h = harness();
    const payload = await run(h.tool, { action: 'photo' });
    expect(payload['success']).toBe(false);
    // The reason is shown verbatim on the confirmation prompt, so a missing one
    // would put an unexplained request in front of a person.
    expect(String(payload['error'])).toContain('reason is required');
    expect(h.asks).toHaveLength(0);
  });
});
