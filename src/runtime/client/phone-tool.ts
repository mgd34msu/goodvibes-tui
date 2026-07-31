/**
 * phone-tool.ts — the `phone` tool, registered in THIS process, answered by the
 * daemon.
 *
 * ── Why the tool is here and the runtime is not ────────────────────────────
 *
 * A tool is called by the conversation loop. The loop runs in this process, so
 * the tool is registered in this process's tool registry. The device-posture
 * RUNTIME it used to call — grants ledger, capture store, housekeeping sweeps,
 * capability service — is the daemon's now, and has to be: a phone pairs with
 * the daemon, a grant must outlive the terminal window that approved it, and the
 * sweep that reaps a grant whose phone is gone has to run with nobody watching.
 * Two runtimes writing one grants ledger is precisely the split-brain the daemon
 * separation exists to end.
 *
 * ── What this tool can and cannot do today, stated plainly ─────────────────
 *
 * The operator contract carries four device verbs: `devices.nodes.list`,
 * `devices.grants.list`, `devices.grants.revoke`, `devices.housekeeping.run`.
 * Those four actions work here and are answered by the daemon.
 *
 * It carries NO verb for exercising a capability — there is no
 * `devices.capability.request` on the wire, so `photo`, `screenshot`,
 * `location`, `clipboard_read`, `clipboard_write`, `notify`, `open_url`,
 * `vibrate` and `run` have no route to the daemon that owns the capability
 * service. This tool REFUSES those actions and says exactly why, naming the
 * missing verb. It does not fall back to a second in-process posture runtime:
 * that would work once, write grants the daemon never sees, and be the split
 * brain again.
 *
 * Closing that gap is one new verb on the daemon side plus the call here. It is
 * recorded in the report for this stage rather than papered over with a refusal
 * that blames the user's configuration.
 */
import type { Tool } from '@pellux/goodvibes-sdk/platform/types';
import type { DevicesClient } from './devices-client.ts';

/** The registry surface this needs — `has` and `register`, nothing more. */
export interface PhoneToolRegistry {
  has(name: string): boolean;
  register(tool: Tool): void;
}

const CAPABILITY_ACTIONS = new Set([
  'run', 'photo', 'screenshot', 'location', 'clipboard_read', 'clipboard_write',
  'notify', 'open_url', 'vibrate', 'capabilities', 'artifacts',
]);

const CAPABILITY_REFUSAL = [
  'This build reaches paired devices through the daemon, and the daemon serves no verb for exercising a device capability yet',
  '(the operator contract has devices.nodes.list, devices.grants.list, devices.grants.revoke and devices.housekeeping.run, and nothing that requests a capture).',
  'Listing nodes and grants, revoking a grant, and running housekeeping all work.',
].join(' ');

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the client-mode `phone` tool over the device verbs.
 *
 * Every action reports what actually happened: an unreachable daemon is named
 * as such, an unsupported action is named as such, and neither is dressed up as
 * an empty result.
 */
export function createClientPhoneTool(devices: DevicesClient): Tool {
  return {
    name: 'phone',
    description: [
      'Inspect and manage the devices paired with your GoodVibes daemon.',
      'Actions: nodes (list paired devices), grants (list live capability grants),',
      'revoke (revoke a grant by id), housekeeping (reap expired grants and captures).',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['nodes', 'grants', 'revoke', 'housekeeping'],
          description: 'What to do.',
        },
        grantId: { type: 'string', description: 'The grant to revoke (action: revoke).' },
      },
      required: ['action'],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const action = typeof args['action'] === 'string' ? args['action'] : '';
      if (CAPABILITY_ACTIONS.has(action)) return CAPABILITY_REFUSAL;
      try {
        switch (action) {
          case 'nodes': {
            const nodes = await devices.listNodes();
            const unavailable = devices.describeAvailability();
            if (nodes.length === 0) {
              return unavailable
                ? `No paired devices could be read: ${unavailable}`
                : 'No devices are paired with this daemon.';
            }
            return nodes
              .map((node) => `${node.nodeId}  ${node.label ?? '(unnamed)'}  ${node.nodeKind ?? 'device'}  ${node.platform ?? ''}`.trimEnd())
              .join('\n');
          }
          case 'grants': {
            const grants = await devices.listGrants();
            const unavailable = devices.describeAvailability();
            if (grants.length === 0) {
              return unavailable
                ? `No grants could be read: ${unavailable}`
                : 'No capability grants are live.';
            }
            return grants
              .map((grant) => `${grant.grantId}  ${grant.capability ?? '(unknown capability)'}  node=${grant.nodeId ?? '?'}`)
              .join('\n');
          }
          case 'revoke': {
            const grantId = typeof args['grantId'] === 'string' ? args['grantId'].trim() : '';
            if (!grantId) return 'Provide grantId to revoke. List them with action: "grants".';
            await devices.revokeGrant(grantId);
            return `Revoked grant ${grantId}.`;
          }
          case 'housekeeping': {
            await devices.runHousekeeping();
            return 'The daemon ran its device housekeeping sweep.';
          }
          default:
            return 'Unknown action. Use one of: nodes, grants, revoke, housekeeping.';
        }
      } catch (error) {
        return `The device action failed: ${describeError(error)}`;
      }
    },
  } as unknown as Tool;
}

/** Register the client-mode `phone` tool, unless a tool by that name already exists. */
export function registerClientPhoneTool(registry: PhoneToolRegistry, devices: DevicesClient): void {
  if (!registry.has('phone')) registry.register(createClientPhoneTool(devices));
}
