export type JsonSchema = Record<string, unknown>;
export type GatewayMethodTransport = 'http' | 'ws' | 'internal';
export type GatewayMethodSource = 'builtin' | 'plugin';
export type GatewayMethodAccess = 'public' | 'authenticated' | 'admin' | 'remote-peer';
export type GatewayEventTransport = 'sse' | 'ws' | 'internal';
export type RuntimeEventDomain =
  | 'session'
  | 'turn'
  | 'providers'
  | 'tools'
  | 'tasks'
  | 'agents'
  | 'workflows'
  | 'orchestration'
  | 'communication'
  | 'planner'
  | 'permissions'
  | 'plugins'
  | 'mcp'
  | 'transport'
  | 'compaction'
  | 'ui'
  | 'ops'
  | 'forensics'
  | 'security'
  | 'automation'
  | 'routes'
  | 'control-plane'
  | 'deliveries'
  | 'watchers'
  | 'surfaces'
  | 'knowledge';
export type DistributedPeerKind = 'node' | 'device';
export type DistributedWorkType = 'invoke' | 'status.request' | 'location.request' | 'session.message' | 'automation.run';
export type DistributedWorkStatus = 'queued' | 'claimed' | 'completed' | 'failed' | 'cancelled' | 'expired';

export interface ContractHttpDefinition {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
}

export interface OperatorMethodContract {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly source: GatewayMethodSource;
  readonly access: GatewayMethodAccess;
  readonly transport: readonly GatewayMethodTransport[];
  readonly scopes: readonly string[];
  readonly http?: ContractHttpDefinition;
  readonly events?: readonly string[];
  readonly inputSchema?: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly pluginId?: string;
  readonly dangerous?: boolean;
  readonly invokable?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface OperatorEventContract {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly source: GatewayMethodSource;
  readonly transport: readonly GatewayEventTransport[];
  readonly scopes: readonly string[];
  readonly domains?: readonly RuntimeEventDomain[];
  readonly wireEvents?: readonly string[];
  readonly payloadSchema?: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly pluginId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface OperatorSchemaCoverageContract {
  readonly methods: number;
  readonly typedInputs: number;
  readonly genericInputs: number;
  readonly typedOutputs: number;
  readonly genericOutputs: number;
}

export interface OperatorEventCoverageContract {
  readonly events: number;
  readonly withDomains: number;
  readonly withWireEvents: number;
}

export interface OperatorContractManifest {
  readonly version: number;
  readonly product: {
    readonly id: string;
    readonly surface: string;
    readonly version: string;
  };
  readonly auth: {
    readonly modes: readonly string[];
    readonly login: {
      readonly method: string;
      readonly path: string;
      readonly requestSchema: JsonSchema;
      readonly responseSchema: JsonSchema;
    };
    readonly current: {
      readonly method: string;
      readonly path: string;
      readonly aliasPaths: readonly string[];
      readonly responseSchema: JsonSchema;
    };
    readonly sessionCookie: {
      readonly name: string;
      readonly httpOnly: boolean;
      readonly sameSite: string;
      readonly path: string;
    };
    readonly bearer: {
      readonly header: string;
      readonly queryParameters: readonly string[];
    };
  };
  readonly transports: {
    readonly http: {
      readonly statusPath: string;
      readonly methodsPath: string;
      readonly eventsCatalogPath: string;
    };
    readonly sse: {
      readonly path: string;
      readonly query: {
        readonly domains: string;
      };
    };
    readonly websocket: {
      readonly path: string;
      readonly clientFrames: readonly {
        readonly type: string;
        readonly fields?: readonly string[];
      }[];
      readonly serverFrames: readonly {
        readonly type: string;
        readonly fields?: readonly string[];
      }[];
    };
  };
  readonly operator: {
    readonly methods: readonly OperatorMethodContract[];
    readonly events: readonly OperatorEventContract[];
    readonly schemaCoverage: OperatorSchemaCoverageContract;
    readonly eventCoverage: OperatorEventCoverageContract;
  };
  readonly peer: {
    readonly contractPath: string;
    readonly aliasPaths: readonly string[];
    readonly relationship: string;
  };
}

export interface PeerEndpointContract {
  readonly id: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly auth: 'none' | 'bearer-peer-token' | 'bearer-operator-token';
  readonly requiredScope?: string;
  readonly description: string;
  readonly inputSchema?: JsonSchema;
  readonly outputSchema?: JsonSchema;
}

export interface PeerContractManifest {
  readonly schemaVersion: 1;
  readonly transport: 'http-json';
  readonly basePath: '/api/remote';
  readonly peerKinds: readonly DistributedPeerKind[];
  readonly workTypes: readonly DistributedWorkType[];
  readonly scopes: readonly string[];
  readonly recommendedHeartbeatMs: number;
  readonly recommendedWorkPullMs: number;
  readonly endpoints: readonly PeerEndpointContract[];
  readonly workCompletionStatuses: readonly DistributedWorkStatus[];
  readonly metadata: Record<string, unknown>;
}
