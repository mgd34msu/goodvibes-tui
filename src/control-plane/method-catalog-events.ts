import type { GatewayEventDescriptor } from './method-catalog-shared.ts';
import { STRING_SCHEMA,NUMBER_SCHEMA,arraySchema,objectSchema,eventDescriptor,runtimeDomainEvent } from './method-catalog-shared.ts';
import { CONTROL_PLANE_SURFACE_MESSAGE_SCHEMA } from './operator-contract-schemas.ts';
import { RUNTIME_EVENT_DOMAINS, type RuntimeEventDomain } from '../runtime/events/domain-map.ts';

const RUNTIME_DOMAIN_DESCRIPTIONS = {
  session: 'Shared-session lifecycle, participant, and message events.',
  turn: 'Turn submission and completion events.',
  providers: 'Provider health, selection, and routing events.',
  tools: 'Tool start, result, and failure events.',
  tasks: 'Runtime task lifecycle and status events.',
  agents: 'Agent lifecycle, planning, and completion events.',
  workflows: 'Workflow orchestration events.',
  orchestration: 'Higher-level orchestration and planner coordination events.',
  communication: 'Agent communication and policy events.',
  planner: 'Planner updates and plan mutation events.',
  permissions: 'Approval and permission prompt events.',
  plugins: 'Plugin registration and lifecycle events.',
  mcp: 'MCP server, tool, and connection events.',
  transport: 'Transport connect, disconnect, and lifecycle events.',
  compaction: 'Context compaction and summary events.',
  ui: 'UI-focused state and operational events.',
  ops: 'Operational diagnostics and control events.',
  forensics: 'Forensics and incident trail events.',
  security: 'Security posture and policy events.',
  automation: 'Automation job, schedule, and run events.',
  routes: 'Route binding and surface-link events.',
  'control-plane': 'Control-plane client, auth, and subscription events.',
  deliveries: 'Delivery queue and outcome events.',
  watchers: 'Watcher state and heartbeat events.',
  surfaces: 'Surface registration and health events.',
  knowledge: 'Knowledge ingest, extraction, projection, packet, and job events.',
} satisfies Record<RuntimeEventDomain, string>;

export const builtinGatewayEventDescriptors: readonly GatewayEventDescriptor[] = [
  ...RUNTIME_EVENT_DOMAINS.map((domain) => runtimeDomainEvent(domain, RUNTIME_DOMAIN_DESCRIPTIONS[domain])),
  eventDescriptor({
    id: 'control.ready',
    title: 'Ready Handshake',
    description: 'Initial SSE/WebSocket handshake event emitted after a control-plane subscription is opened.',
    category: 'transport',
    transport: ['sse', 'ws'],
    scopes: ['read:events'],
    wireEvents: ['ready'],
    outputSchema: objectSchema({
      clientId: STRING_SCHEMA,
      domains: arraySchema(STRING_SCHEMA),
      transport: STRING_SCHEMA,
    }, ['clientId', 'domains', 'transport']),
  }),
  eventDescriptor({
    id: 'control.heartbeat',
    title: 'Heartbeat',
    description: 'Keepalive event emitted by the SSE control-plane transport.',
    category: 'transport',
    transport: ['sse', 'ws'],
    scopes: ['read:events'],
    wireEvents: ['heartbeat'],
    outputSchema: objectSchema({
      clientId: STRING_SCHEMA,
      ts: NUMBER_SCHEMA,
    }, ['clientId', 'ts'], { additionalProperties: false }),
  }),
  eventDescriptor({
    id: 'control.surface_message',
    title: 'Surface Message',
    description: 'Out-of-band control-plane surface messages for operators and connected clients.',
    category: 'transport',
    transport: ['sse', 'ws'],
    scopes: ['read:events'],
    wireEvents: ['surface-message'],
    outputSchema: CONTROL_PLANE_SURFACE_MESSAGE_SCHEMA,
  }),
];
