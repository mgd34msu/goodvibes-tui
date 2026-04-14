export type {
  ContractHttpDefinition,
  JsonSchema,
  OperatorContractManifest,
  OperatorEventContract,
  OperatorEventCoverageContract,
  OperatorMethodContract,
  OperatorSchemaCoverageContract,
  PeerContractManifest,
  PeerEndpointContract,
  RuntimeEventDomain,
} from '@pellux/goodvibes-sdk-beta/contracts';

export type GatewayMethodTransport = 'http' | 'ws' | 'internal';
export type GatewayMethodSource = 'builtin' | 'plugin';
export type GatewayMethodAccess = 'public' | 'authenticated' | 'admin' | 'remote-peer';
export type GatewayEventTransport = 'sse' | 'ws' | 'internal';
export type DistributedPeerKind = 'node' | 'device';
export type DistributedWorkType =
  | 'invoke'
  | 'status.request'
  | 'location.request'
  | 'session.message'
  | 'automation.run';
export type DistributedWorkStatus = 'queued' | 'claimed' | 'completed' | 'failed' | 'cancelled' | 'expired';
