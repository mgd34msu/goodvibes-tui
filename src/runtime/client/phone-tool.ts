/**
 * phone-tool.ts — the `phone` tool, registered in THIS process, answered by the
 * daemon.
 *
 * ── Why the tool is here and the runtime is not ────────────────────────────
 *
 * A tool is called by the conversation loop. The loop runs in this process, so
 * the tool is registered in this process's tool registry. The device-posture
 * RUNTIME it calls — grants ledger, capture store, housekeeping sweeps,
 * capability service — is the daemon's, and has to be: a phone pairs with the
 * daemon, a grant must outlive the terminal window that approved it, and the
 * sweep that reaps a grant whose phone is gone has to run with nobody watching.
 * Two runtimes writing one grants ledger is the split-brain the daemon
 * separation exists to end.
 *
 * ── Nothing is re-decided here ────────────────────────────────────────────
 *
 * Every gate stays with the runtime. The confirmation prompt, the durable-grant
 * lookup, the `device.*` config gates, the input check, the retention window
 * and the disclosure all belong to the daemon, exactly as they do for the
 * in-process tool. This module shapes arguments and renders what came back.
 *
 * The one check it makes locally is `validateDeviceCapabilityInput`, and it is
 * a courtesy rather than a gate: a malformed input gets a precise message
 * without a round trip, and the runtime checks it again regardless.
 *
 * ── A refusal is an ANSWER, not an error ──────────────────────────────────
 *
 * This is the one place the wire tool deliberately reads differently from the
 * in-process one, and it is the important line in this file.
 *
 * When someone declines to hand over their camera, that is the system working.
 * `ok: false` with the runtime's `refusal` code and `detail` comes back as a
 * SUCCESSFUL tool result whose payload says `allowed: false` and why. Returning
 * it as a tool ERROR would misdescribe what happened, and the cost is concrete:
 * a model reads a failed tool call as something to retry, so it asks again, and
 * the person is prompted again for the thing they just declined. The refusal is
 * reported plainly and the turn moves on.
 *
 * A genuine failure — no daemon reachable, a malformed request, a capture whose
 * bytes are gone — is still an error, because it is one.
 *
 * ── Captures ──────────────────────────────────────────────────────────────
 *
 * A photo or screenshot is retained by the daemon, not written here. The result
 * names the artifact and when it expires; `action:"read"` fetches the bytes
 * over `devices.artifacts.read`, base64-encoded. The `daemonPath` on an
 * artifact is a path on the DAEMON's disk — reported because an operator on
 * that machine may want it, and never opened from here.
 */
import {
  DEVICE_CAPABILITY_CATALOG,
  describeDeviceNodeKind,
  getDeviceCapability,
  isDeviceCapabilityId,
  validateDeviceCapabilityInput,
  type DeviceCapabilityId,
} from '@pellux/goodvibes-sdk/platform/devices';
import type { Tool } from '@pellux/goodvibes-sdk/platform/types';
import type { DeviceCapabilityOutcomeWire, DeviceNodeSummary, DevicesClient } from './devices-client.ts';

/** The registry members this registration needs; a real ToolRegistry satisfies it. */
export interface PhoneToolRegistry {
  has(name: string): boolean;
  register(tool: Tool): void;
}

type PhonePayload = Record<string, unknown> & { readonly success: boolean };

function fail(error: string, hint?: string): PhonePayload {
  return { success: false, error, ...(hint ? { hint } : {}) };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

type PhoneAction =
  | 'nodes' | 'capabilities' | 'run' | 'photo' | 'screenshot' | 'location'
  | 'clipboard_read' | 'clipboard_write' | 'notify' | 'open_url' | 'vibrate'
  | 'grants' | 'revoke' | 'artifacts' | 'read' | 'housekeeping';

/** The same aliases the in-process tool accepts, so a prompt that worked keeps working. */
function normalizeAction(value: unknown): PhoneAction | null {
  const action = readString(value).toLowerCase().replace(/[- ]/g, '_');
  if (!action) return null;
  if (action === 'nodes' || action === 'devices' || action === 'list' || action === 'status') return 'nodes';
  if (action === 'capabilities' || action === 'catalog') return 'capabilities';
  if (action === 'run' || action === 'request' || action === 'invoke') return 'run';
  if (action === 'photo' || action === 'camera' || action === 'picture' || action === 'take_photo') return 'photo';
  if (action === 'screenshot' || action === 'screen' || action === 'screen_capture') return 'screenshot';
  if (action === 'location' || action === 'where' || action === 'gps') return 'location';
  if (action === 'clipboard_read' || action === 'read_clipboard' || action === 'paste') return 'clipboard_read';
  if (action === 'clipboard_write' || action === 'write_clipboard' || action === 'copy') return 'clipboard_write';
  if (action === 'notify' || action === 'notification' || action === 'alert') return 'notify';
  if (action === 'open_url' || action === 'open' || action === 'open_link') return 'open_url';
  if (action === 'vibrate' || action === 'buzz') return 'vibrate';
  if (action === 'grants' || action === 'grant_list' || action === 'permissions') return 'grants';
  if (action === 'revoke' || action === 'revoke_grant' || action === 'forget') return 'revoke';
  if (action === 'artifacts' || action === 'captures') return 'artifacts';
  if (action === 'read' || action === 'fetch' || action === 'download' || action === 'artifact_read') return 'read';
  if (action === 'housekeeping' || action === 'sweep' || action === 'gc') return 'housekeeping';
  return null;
}

/**
 * Render the runtime's outcome.
 *
 * A refusal is `success: true` carrying `allowed: false` — see the module
 * header for why a declined capability is an answer rather than an error.
 */
function renderOutcome(outcome: DeviceCapabilityOutcomeWire): PhonePayload {
  const capabilityId = String(outcome.capabilityId ?? '');
  const capability = String(outcome.capabilityTitle ?? getDeviceCapability(capabilityId)?.title ?? capabilityId);
  if (outcome.ok !== true) {
    return {
      success: true,
      allowed: false,
      nodeId: outcome.nodeId ?? null,
      capabilityId,
      capability,
      refusal: outcome.refusal ?? '',
      detail: outcome.detail ?? '',
      note: 'This is the runtime\'s own answer, not a failed request. Do not repeat it unless the person asks again.',
    };
  }
  const artifact = outcome.artifact ?? null;
  return {
    success: true,
    allowed: true,
    nodeId: outcome.nodeId ?? null,
    capabilityId,
    capability,
    // Stated on every result so a reader can see WHY it was allowed: an
    // existing durable grant, or a fresh confirmation.
    authority: outcome.authority ?? '',
    ...(outcome.grantId ? { grantId: outcome.grantId } : {}),
    ...(outcome.data === undefined ? {} : { data: outcome.data }),
    ...(artifact
      ? {
        artifact: {
          ...artifact,
          capturedAt: isoOrNull(artifact['capturedAt']),
          expiresAt: isoOrNull(artifact['expiresAt']),
          retentionNote: 'Held by the daemon and deleted automatically at expiry; the removal is recorded in its device housekeeping log.',
          readWith: `action:"read", artifactId:"${artifact.artifactId}" returns the bytes base64-encoded.`,
        },
      }
      : {}),
  };
}

/** Resolve which node serves a request: the one named, or the only candidate. */
function resolveNodeId(
  nodes: readonly DeviceNodeSummary[],
  explicit: string,
  capabilityId: DeviceCapabilityId,
): string | PhonePayload {
  if (explicit) {
    if (!nodes.some((node) => node.nodeId === explicit)) {
      return fail(`No paired phone with id ${JSON.stringify(explicit)}.`, 'Use action:"nodes" to list paired phones.');
    }
    return explicit;
  }
  const candidates = nodes.filter((node) => (node.supported ?? []).includes(capabilityId));
  if (candidates.length === 1 && candidates[0]) return candidates[0].nodeId;
  if (candidates.length === 0) {
    return fail(
      nodes.length === 0
        ? 'No phone is paired with the daemon as a device node yet.'
        : `No paired phone offers ${getDeviceCapability(capabilityId)?.title ?? capabilityId}.`,
      'Pair a phone from the web app, then use action:"nodes".',
    );
  }
  return fail(
    'More than one paired phone offers this; name one with nodeId.',
    `Candidates: ${candidates.map((node) => `${node.nodeId} (${node.label ?? 'unnamed'})`).join(', ')}`,
  );
}

async function runCapability(
  devices: DevicesClient,
  args: Record<string, unknown>,
  capabilityId: DeviceCapabilityId,
  capabilityInput: Record<string, unknown>,
): Promise<PhonePayload> {
  const reason = readString(args['reason']);
  if (!reason) {
    return fail(
      'A reason is required: it is shown verbatim on the confirmation prompt so the person knows what they are allowing.',
      'Pass reason:"…" describing what the capability is for.',
    );
  }
  const nodes = await devices.listNodes();
  const nodeId = resolveNodeId(nodes, readString(args['nodeId']), capabilityId);
  if (typeof nodeId !== 'string') return nodeId;

  const problems = validateDeviceCapabilityInput(capabilityId, { ...capabilityInput, reason });
  if (problems.length > 0) {
    return fail(
      `Missing or mistyped input for ${capabilityId}: ${problems.map((problem) => `${problem.field} (${problem.problem}, expected ${problem.expected})`).join('; ')}.`,
    );
  }

  try {
    return renderOutcome(await devices.requestCapability({
      nodeId, capabilityId, input: capabilityInput, reason,
    }));
  } catch (error) {
    // Only a transport or argument failure reaches here — a refusal by the
    // person or the policy already came back as a value.
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export function createClientPhoneTool(devices: DevicesClient): Tool {
  return {
    definition: {
      name: 'phone',
      // Kept at or below 72 chars: the packaging gate enforces this on every
      // model-visible schema description.
      description: 'Use a paired phone: camera, screen, location, clipboard, alerts.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'nodes', 'capabilities', 'run', 'photo', 'screenshot', 'location',
              'clipboard_read', 'clipboard_write', 'notify', 'open_url', 'vibrate',
              'grants', 'revoke', 'artifacts', 'read', 'housekeeping',
            ],
            description: 'What to do. Defaults to "nodes" (paired phones and abilities).',
          },
          nodeId: { type: 'string', description: 'Which paired phone. Optional when only one offers it.' },
          capabilityId: { type: 'string', description: 'Capability id for action:"run".' },
          reason: { type: 'string', description: 'Why it is needed. Shown verbatim on the confirmation prompt.' },
          input: { type: 'object', description: 'Capability inputs for action:"run".' },
          camera: { type: 'string', enum: ['rear', 'front'], description: 'Which camera action:"photo" uses. Defaults to rear.' },
          precision: { type: 'string', enum: ['coarse', 'precise'], description: 'Location precision for action:"location". Defaults to coarse.' },
          text: { type: 'string', description: 'Text to place on the clipboard for action:"clipboard_write".' },
          title: { type: 'string', description: 'Notification title for action:"notify".' },
          body: { type: 'string', description: 'Notification body for action:"notify".' },
          url: { type: 'string', description: 'Link to open for action:"open_url".' },
          durationMs: { type: 'number', description: 'Buzz length for action:"vibrate".' },
          maxWidth: { type: 'number', description: 'Longest-edge pixel cap applied on the phone before upload.' },
          maxAgeSeconds: { type: 'number', description: 'Accept a cached location fix no older than this.' },
          grantId: { type: 'string', description: 'Grant to revoke for action:"revoke".' },
          artifactId: { type: 'string', description: 'Capture to fetch for action:"read".' },
          limit: { type: 'number', description: 'Maximum rows for list actions.' },
        },
        additionalProperties: false,
      },
      sideEffects: ['state', 'network'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: Record<string, unknown>) => {
      const payload = await handleAction(devices, readRecord(rawArgs));
      const output = JSON.stringify(payload, null, 2);
      return payload.success
        ? { success: true, output }
        : { success: false, error: String(payload['error'] ?? 'The phone request failed.'), output };
    },
  };
}

/** Every action, returning the tool's own payload before it is serialised. */
async function handleAction(devices: DevicesClient, args: Record<string, unknown>): Promise<PhonePayload> {
  const action = normalizeAction(args['action']) ?? 'nodes';
  const limit = typeof args['limit'] === 'number' && args['limit'] > 0 ? Math.floor(args['limit']) : 50;
  const unreachable = devices.describeAvailability();

  if (action === 'nodes') {
    const nodes = await devices.listNodes();
    if (nodes.length === 0 && unreachable) return fail(`No paired phones could be read: ${unreachable}`);
    return {
      success: true,
      paired: nodes.length,
      nodes: nodes.map((node) => ({
        ...node,
        ...(node.nodeKind ? { nodeKindLabel: describeDeviceNodeKind(node.nodeKind) } : {}),
      })),
      ...(nodes.length === 0
        ? { note: 'No phone is paired yet. Pair one from the web app\'s phone page; it appears here once approved.' }
        : {}),
    };
  }

  if (action === 'capabilities') {
    // The catalog is a shared constant, so it renders without a round trip;
    // only `servedBy` needs the daemon, and it degrades to empty WITH the
    // reason rather than implying no phone offers anything.
    const nodes = await devices.listNodes();
    return {
      success: true,
      ...(unreachable ? { note: `Which phones serve these could not be read: ${unreachable}` } : {}),
      capabilities: DEVICE_CAPABILITY_CATALOG.map((descriptor) => ({
        id: descriptor.id,
        family: descriptor.family,
        title: descriptor.title,
        purpose: descriptor.purpose,
        effect: descriptor.effect,
        sensitivity: descriptor.sensitivity,
        retainsCapture: descriptor.producesArtifact,
        confirmation: 'asks every time unless a durable grant exists',
        allowAlwaysOffered: descriptor.allowAlwaysOffered,
        servedBy: nodes.filter((node) => (node.supported ?? []).includes(descriptor.id)).map((node) => node.nodeId),
      })),
    };
  }

  if (action === 'grants') {
    const grants = await devices.listGrants();
    if (grants.length === 0 && unreachable) return fail(`No grants could be read: ${unreachable}`);
    return {
      success: true,
      grants: grants.slice(0, limit).map((grant) => ({
        ...grant,
        ...(grant.capability ? { capability: getDeviceCapability(grant.capability)?.title ?? grant.capability } : {}),
        ...(grant.expiresAt ? { expiresAt: new Date(grant.expiresAt).toISOString() } : {}),
      })),
    };
  }

  if (action === 'revoke') {
    const grantId = readString(args['grantId']);
    if (!grantId) return fail('Name what to revoke with grantId.', 'Use action:"grants" to list them.');
    try {
      await devices.revokeGrant(grantId);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    return {
      success: true,
      revoked: grantId,
      note: 'A revoked grant is deleted, not flagged — the next request for that capability asks again.',
    };
  }

  if (action === 'artifacts') {
    const nodeId = readString(args['nodeId']);
    const listed = await devices.listArtifacts({ ...(nodeId ? { nodeId } : {}), limit });
    if (listed.artifacts.length === 0 && unreachable) return fail(`No captures could be read: ${unreachable}`);
    return {
      success: true,
      retained: listed.retained,
      retentionHours: listed.retentionHours,
      artifacts: listed.artifacts.map((artifact) => ({
        ...artifact,
        capturedAt: isoOrNull(artifact['capturedAt']),
        expiresAt: isoOrNull(artifact['expiresAt']),
      })),
      note: 'daemonPath is a path on the DAEMON\'s filesystem. Use action:"read" to fetch the bytes.',
    };
  }

  if (action === 'read') {
    const artifactId = readString(args['artifactId']);
    if (!artifactId) return fail('Pass artifactId:"…" — use action:"artifacts" to list them.');
    try {
      const read = await devices.readArtifact(artifactId);
      return {
        success: true,
        artifact: read.artifact,
        dataBase64: read.dataBase64,
        note: 'Bytes are base64-encoded. The capture stays on the daemon until its retention window closes.',
      };
    } catch (error) {
      // A swept, expired or digest-mismatched capture is a genuine failure to
      // serve what was asked for, not a person declining something.
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  if (action === 'housekeeping') {
    try {
      return { success: true, ...(await devices.runHousekeeping()) };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  if (action === 'run') {
    const capabilityId = readString(args['capabilityId']);
    if (!isDeviceCapabilityId(capabilityId)) {
      return fail(
        `${capabilityId || '(none)'} is not a capability this contract defines.`,
        `Known capabilities: ${DEVICE_CAPABILITY_CATALOG.map((entry) => entry.id).join(', ')}`,
      );
    }
    return runCapability(devices, args, capabilityId, readRecord(args['input']));
  }

  if (action === 'photo') {
    const front = readString(args['camera']).toLowerCase() === 'front';
    return runCapability(devices, args, front ? 'device.camera.front.capture' : 'device.camera.rear.capture', {
      ...(typeof args['maxWidth'] === 'number' ? { maxWidth: args['maxWidth'] } : {}),
    });
  }

  if (action === 'screenshot') return runCapability(devices, args, 'device.screen.capture', {});

  if (action === 'location') {
    const precise = readString(args['precision']).toLowerCase() === 'precise';
    return runCapability(devices, args, precise ? 'device.location.precise' : 'device.location.coarse', {
      ...(typeof args['maxAgeSeconds'] === 'number' ? { maxAgeSeconds: args['maxAgeSeconds'] } : {}),
    });
  }

  if (action === 'clipboard_read') return runCapability(devices, args, 'device.clipboard.read', {});

  if (action === 'clipboard_write') {
    const text = readString(args['text']);
    if (!text) return fail('Pass text:"…" — the text to place on the phone\'s clipboard.');
    return runCapability(devices, args, 'device.clipboard.write', { text });
  }

  if (action === 'notify') {
    const title = readString(args['title']);
    if (!title) return fail('Pass title:"…" — the notification title.');
    const body = readString(args['body']);
    return runCapability(devices, args, 'device.command.notify', { title, ...(body ? { body } : {}) });
  }

  if (action === 'open_url') {
    const url = readString(args['url']);
    if (!/^https?:\/\//i.test(url)) return fail('Pass url:"https://…" — only http and https links are opened on the phone.');
    return runCapability(devices, args, 'device.command.open_url', { url });
  }

  if (action === 'vibrate') {
    return runCapability(devices, args, 'device.command.vibrate', {
      ...(typeof args['durationMs'] === 'number' ? { durationMs: args['durationMs'] } : {}),
    });
  }

  return fail('Unknown phone action.', 'Use action:"nodes" to list paired phones, or action:"capabilities" for the catalog.');
}

/** Register the client-mode `phone` tool, leaving an existing registration alone. */
export function registerClientPhoneTool(registry: PhoneToolRegistry, devices: DevicesClient): void {
  if (!registry.has('phone')) registry.register(createClientPhoneTool(devices));
}
