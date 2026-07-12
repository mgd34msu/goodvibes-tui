import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Channels from '@pellux/goodvibes-sdk/platform/channels';
import * as Hooks from '@pellux/goodvibes-sdk/platform/hooks';
import * as Knowledge from '@pellux/goodvibes-sdk/platform/knowledge';
import * as Mcp from '@pellux/goodvibes-sdk/platform/mcp';
import * as Providers from '@pellux/goodvibes-sdk/platform/providers';
import type { KnowledgeApi } from '@pellux/goodvibes-sdk/platform/knowledge';
import type { ProviderApi } from '@pellux/goodvibes-sdk/platform/providers';
import {
  createDirectTransportServices,
  createOperatorClientServices,
  createPeerClientDependencies,
} from '@/runtime/index.ts';
import { createOperatorClient, type OperatorClient } from '@/runtime/index.ts';
import { createPeerClient, type PeerClient } from '@/runtime/index.ts';
import {
  createDirectTransport,
  createDirectTransportFromServices,
  type DirectTransport,
} from '@/runtime/index.ts';
import { getTestRuntimeServices, resetTestRuntimeServices } from '../helpers/runtime-services.ts';

function resetPeerFoundationState(): void {
  const services = getTestRuntimeServices();
  services.distributedRuntime.pairRequests.clear();
  services.distributedRuntime.peers.clear();
  services.distributedRuntime.work.clear();
  services.distributedRuntime.audit.length = 0;
  services.distributedRuntime.waiters.clear();
  services.distributedRuntime.loaded = true;
  services.remoteRunnerRegistry.clear();
}

function sortedKeys(value: object): string[] {
  return Object.keys(value).slice().sort((left, right) => left.localeCompare(right));
}

describe('foundation surface stability gate', () => {
  beforeEach(() => {
    resetTestRuntimeServices();
  });

  afterEach(() => {
    resetTestRuntimeServices();
  });

  test('stable in-process foundation surfaces preserve their public consumer domains', () => {
    const runtimeServices = getTestRuntimeServices();
    resetPeerFoundationState();
    const foundationServices = {
      operator: createOperatorClientServices(runtimeServices),
      peer: createPeerClientDependencies(runtimeServices),
    };

    const foundation = {
      operator: createOperatorClient(foundationServices.operator),
      peer: createPeerClient(foundationServices.peer),
      transport: createDirectTransportFromServices(foundationServices),
      providers: Providers.createProviderApi({
        providerRegistry: runtimeServices.providerRegistry,
        favoritesStore: runtimeServices.favoritesStore,
        benchmarkStore: runtimeServices.benchmarkStore,
      }),
      knowledge: Knowledge.createKnowledgeApi(runtimeServices.knowledgeService),
    } satisfies {
      readonly operator: OperatorClient;
      readonly peer: PeerClient;
      readonly transport: DirectTransport;
      readonly providers: ProviderApi;
      readonly knowledge: KnowledgeApi;
    };

    expect(sortedKeys(foundationServices.operator)).toEqual([
      'approvalBroker',
      'events',
      'providerRegistry',
      'readModels',
      'secretsManager',
      'serviceRegistry',
      'sessionBroker',
      'shellPaths',
      'subscriptionManager',
    ]);
    expect(sortedKeys(foundationServices.operator.readModels)).toEqual([
      'controlPlane',
      'providers',
      'session',
      'tasks',
    ]);
    expect(sortedKeys(foundationServices.peer)).toEqual([
      'distributedRuntime',
      'remoteRunnerRegistry',
      'remoteSupervisor',
      'runtimeStore',
    ]);

    expect(sortedKeys(foundation.operator)).toEqual([
      'approvals',
      'controlPlane',
      'events',
      'providers',
      'sessions',
      'shellPaths',
      'tasks',
    ]);
    expect(sortedKeys(foundation.operator.sessions)).toEqual([
      'bindAgent',
      'cancelInput',
      'close',
      'current',
      'delete',
      'deliverInput',
      'detach',
      'ensureSession',
      'followUpMessage',
      'get',
      'inputs',
      'list',
      'messages',
      'register',
      'reopen',
      'steerMessage',
      'submitMessage',
    ]);
    expect(sortedKeys(foundation.operator.providers)).toEqual([
      'accountSnapshot',
      'authInspection',
      'listIds',
      'runtimeSnapshot',
      'runtimeSnapshots',
      'snapshot',
      'usageSnapshot',
    ]);

    expect(sortedKeys(foundation.peer)).toEqual([
      'getNodeHostContract',
      'getSnapshot',
      'pairing',
      'peers',
      'runners',
      'work',
    ]);
    expect(sortedKeys(foundation.peer.pairing)).toEqual([
      'approve',
      'listRequests',
      'reject',
      'request',
      'verify',
    ]);
    expect(sortedKeys(foundation.peer.peers)).toEqual([
      'authenticateToken',
      'disconnect',
      'get',
      'getSnapshot',
      'heartbeat',
      'list',
      'revokeToken',
      'rotateToken',
    ]);

    expect(sortedKeys(foundation.transport)).toEqual([
      'getOperatorClient',
      'getPeerClient',
      'kind',
      'operator',
      'peer',
      'snapshot',
    ]);
    expect(sortedKeys(foundation.transport.getOperatorClient())).toEqual(sortedKeys(foundation.operator));
    expect(sortedKeys(foundation.transport.getPeerClient())).toEqual(sortedKeys(foundation.peer));

    expect(sortedKeys(foundation.providers)).toEqual([
      'createHelperModel',
      'getCurrentModel',
      'getFavorites',
      'listBenchmarks',
      'listModels',
      'listProviderIds',
      'pinModel',
      'queryRuntimeMetadata',
      'recordModelUsage',
      'refreshBenchmarks',
      'refreshCatalog',
      'refreshLiveModelDiscovery',
      'refreshModelLimits',
      'registerDiscoveredProviders',
      'selectModel',
      'unpinModel',
    ]);

    expect(sortedKeys(foundation.knowledge)).toEqual([
      'connectors',
      'consolidation',
      'graph',
      'ingest',
      'jobs',
      'packets',
      'projections',
      'sources',
      'status',
      'usage',
    ]);
    expect(typeof Knowledge.createKnowledgeApi).toBe('function');
    expect(typeof Knowledge.KnowledgeGraphqlService).toBe('function');
    expect(typeof Knowledge.inspectKnowledgeGraphqlAccess).toBe('function');
    expect(typeof Knowledge.resolveKnowledgeDbPathFromControlPlaneDir).toBe('function');
    expect(Knowledge.resolveKnowledgeDbPathFromControlPlaneDir(join('/tmp/control-plane'))).toBe(join('/tmp/control-plane', 'knowledge-wiki.sqlite'));
    expect(Knowledge.inspectKnowledgeGraphqlAccess('{ status { sourceCount } }')).toEqual({
      operation: 'query',
      requiredScopes: ['read:knowledge'],
      adminRequired: false,
    });
    expect(new Knowledge.KnowledgeGraphqlService(runtimeServices.knowledgeService).schemaText).toContain('type Query');
    expect(new Knowledge.KnowledgeGraphqlService(runtimeServices.knowledgeService).schemaText).toContain('type Mutation');
    expect(typeof Hooks.createHookApi).toBe('function');
    expect(typeof Mcp.createMcpApi).toBe('function');
    expect(typeof Providers.createProviderApi).toBe('function');
    expect(typeof Channels.ChannelDeliveryRouter).toBe('function');
    expect(typeof Channels.ChannelPluginRegistry).toBe('function');
    expect(typeof Channels.ChannelPolicyManager).toBe('function');
    expect(typeof Channels.ChannelReplyPipeline).toBe('function');
    expect(typeof Channels.ChannelProviderRuntimeManager).toBe('function');
    expect(sortedKeys(foundation.knowledge.graph)).toEqual([
      'extractions',
      'issues',
      'items',
      'map',
      'nodes',
    ]);
    expect(sortedKeys(foundation.knowledge.jobs)).toEqual([
      'get',
      'list',
      'run',
      'runs',
      'schedules',
    ]);
  });

  test('foundation surfaces support one coherent in-process consumer workflow', async () => {
    const runtimeServices = getTestRuntimeServices();
    resetPeerFoundationState();
    const foundationServices = {
      operator: createOperatorClientServices(runtimeServices),
      peer: createPeerClientDependencies(runtimeServices),
    };

    const operator: OperatorClient = createOperatorClient(foundationServices.operator);
    const peer: PeerClient = createPeerClient(foundationServices.peer);
    const transport: DirectTransport = createDirectTransportFromServices(foundationServices);
    const providers: ProviderApi = Providers.createProviderApi({
      providerRegistry: runtimeServices.providerRegistry,
      favoritesStore: runtimeServices.favoritesStore,
      benchmarkStore: runtimeServices.benchmarkStore,
    });
    const knowledge: KnowledgeApi = Knowledge.createKnowledgeApi(runtimeServices.knowledgeService);

    const session = await operator.sessions.ensureSession({
      sessionId: 'foundation-surface-session',
      title: 'Foundation Surface Session',
      participant: {
        surfaceKind: 'tui',
        surfaceId: 'foundation-shell',
        lastSeenAt: 123,
      },
    });
    expect(operator.sessions.get(session.id)?.title).toBe('Foundation Surface Session');
    expect(operator.controlPlane.snapshot().sessions.some((entry) => entry.id === session.id)).toBe(true);

    const providerIds = providers.listProviderIds();
    const currentModel = await providers.getCurrentModel();
    const selectableModels = await providers.listModels({ selectableOnly: true });
    const favorites = await providers.getFavorites();
    const runtimeMetadata = await providers.queryRuntimeMetadata({ scope: 'all' });
    expect(providerIds.length).toBeGreaterThan(0);
    expect(providerIds).toContain(currentModel.providerId);
    expect(selectableModels.every((model) => model.selectable)).toBe(true);
    expect(Array.isArray(favorites.pinned)).toBe(true);
    expect(Array.isArray(favorites.recent)).toBe(true);
    expect(runtimeMetadata.scope).toBe('all');
    if (runtimeMetadata.scope !== 'all') {
      throw new Error(`Expected all runtime metadata scope, received ${runtimeMetadata.scope}`);
    }
    expect(Array.isArray(runtimeMetadata.snapshots)).toBe(true);
    const legacyTransport = createDirectTransport(runtimeServices);
    expect(sortedKeys(legacyTransport.operator)).toEqual(sortedKeys(transport.operator));
    expect(sortedKeys(legacyTransport.peer)).toEqual(sortedKeys(transport.peer));

    const artifactPath = join(runtimeServices.shellPaths.workingDirectory, 'foundation-surface-note.md');
    writeFileSync(artifactPath, '# Foundation Surface Note\n\nThis note proves the in-process knowledge API remains consumable.\n', 'utf-8');
    const ingest = await knowledge.ingest.artifact({
      path: artifactPath,
      connectorId: 'artifact',
      sessionId: session.id,
      tags: ['foundation-surface'],
    });
    expect(knowledge.sources.list(10).some((source) => source.id === ingest.source.id)).toBe(true);

    const packet = await knowledge.packets.build('foundation surface note', [], 5, { budgetLimit: 2_000 });
    expect(packet.items.length).toBeGreaterThan(0);
    const status = await knowledge.status.get();
    expect(status.ready).toBe(true);

    const pair = await peer.pairing.request({
      peerKind: 'node',
      label: 'foundation-surface-peer',
      requestedId: 'foundation-surface-peer',
      requestedBy: 'operator',
      capabilities: ['invoke'],
      commands: ['status'],
    });
    await peer.pairing.approve(pair.request.id, { actor: 'operator', note: 'approved by release gate' });
    const verified = await peer.pairing.verify(pair.request.id, pair.challenge, {
      remoteAddress: '10.10.0.20',
    });
    expect(verified?.peer.status).toBe('connected');

    const transportSnapshot = await transport.snapshot();
    expect(transport.kind).toBe('direct');
    expect(transportSnapshot.kind).toBe('direct');
    expect(transportSnapshot.operator.sessions.some((entry) => entry.id === session.id)).toBe(true);
    expect(transportSnapshot.operator.providers.providerIds).toEqual(transport.operator.providers.listIds());
    expect(transportSnapshot.peer.peers.some((entry) => entry.id === verified?.peer.id)).toBe(true);
    expect(transportSnapshot.peer.nodeHostContract.basePath).toBe('/api/remote');
  });
});
