import { describe, expect, test } from 'bun:test';
import { createDaemonChannelRouteHandlers } from '@pellux/goodvibes-sdk/platform/daemon/http/channel-routes';
import { createDaemonIntegrationRouteHandlers } from '@pellux/goodvibes-sdk/platform/daemon/http/integration-routes';
import { createDaemonSystemRouteHandlers } from '@pellux/goodvibes-sdk/platform/daemon/http/system-routes';
import { createDaemonKnowledgeRouteHandlers } from '@pellux/goodvibes-sdk/platform/daemon/http/knowledge-routes';
import { createDaemonMediaRouteHandlers } from '@pellux/goodvibes-sdk/platform/daemon/http/media-routes';

describe('daemon route seams', () => {
  test('channel routes use injected surface and plugin services', async () => {
    const handlers = createDaemonChannelRouteHandlers({
      channelPlugins: {
        listAccounts: async () => [],
        getAccount: async () => null,
        getSetupSchema: async () => null,
        doctor: async () => null,
        listRepairActions: async () => [],
        getLifecycleState: async () => null,
        migrateLifecycle: async () => null,
        runAccountAction: async () => null,
        listCapabilities: async () => [],
        listTools: async () => [],
        listAgentTools: () => [],
        runTool: async () => null,
        listOperatorActions: async () => [],
        runOperatorAction: async () => null,
        resolveTarget: async () => null,
        authorizeActorAction: async () => null,
        resolveAllowlist: async () => null,
        editAllowlist: async () => null,
        listStatus: async () => [],
        queryDirectory: async () => [],
      },
      channelPolicy: {
        listPolicies: () => [],
        upsertPolicy: async () => ({}),
        listAudit: () => [],
      },
      parseJsonBody: async () => ({}),
      parseOptionalJsonBody: async () => null,
      requireAdmin: () => null,
      surfaceRegistry: {
        list: () => [{ id: 'slack' }],
      },
    });

    const response = await handlers.getSurfaces();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ surfaces: [{ id: 'slack' }] });
  });

  test('integration routes use injected provider runtime snapshots', async () => {
    const handlers = createDaemonIntegrationRouteHandlers({
      channelPlugins: {
        listAccounts: async () => [],
      },
      integrationHelpers: null,
      memoryEmbeddingRegistry: {
        setDefaultProvider: () => undefined,
      },
      memoryRegistry: {
        doctor: async () => ({}),
        vectorStats: () => ({}),
        rebuildVectorsAsync: async () => ({}),
      },
      parseJsonBody: async () => ({}),
      providerRuntime: {
        listSnapshots: async () => [{ providerId: 'inceptionlabs' }],
        getSnapshot: async () => null,
        getUsageSnapshot: async () => null,
      },
      requireAdmin: () => null,
      userAuth: {
        addUser: () => ({}),
        deleteUser: () => false,
        rotatePassword: () => undefined,
        revokeSession: () => false,
        clearBootstrapCredentialFile: () => false,
      },
    }, new Request('http://127.0.0.1/api/providers'));

    const response = await handlers.getProviders();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ providers: [{ providerId: 'inceptionlabs' }] });
  });

  test('system routes use injected config and tls inspectors', async () => {
    const handlers = createDaemonSystemRouteHandlers({
      approvalBroker: {
        claimApproval: async () => null,
        cancelApproval: async () => null,
        resolveApproval: async () => null,
      },
      configManager: {
        get: () => 60_000,
        getAll: () => ({ 'ui.theme': 'light' }),
        setDynamic: () => undefined,
      },
      integrationHelpers: null,
      inspectInboundTls: (surface) => ({ surface, mode: 'off' }),
      inspectOutboundTls: () => ({ mode: 'system' }),
      isValidConfigKey: () => true,
      parseJsonBody: async () => ({}),
      parseOptionalJsonBody: async () => null,
      platformServiceManager: {
        status: () => ({ installed: true }),
        install: () => ({ ok: true }),
        start: () => ({ ok: true }),
        stop: () => ({ ok: true }),
        restart: () => ({ ok: true }),
        uninstall: () => ({ ok: true }),
      },
      recordApiResponse: (_req, _path, response) => response,
      requireAdmin: () => null,
      requireAuthenticatedSession: () => ({ username: 'tester', roles: ['admin'] }),
      routeBindings: {
        listBindings: () => [],
        upsertBinding: async () => ({}),
        patchBinding: async () => ({}),
        removeBinding: async () => true,
      },
      watcherRegistry: {
        list: () => [],
        removeWatcher: () => true,
        registerWatcher: (input) => input,
        getWatcher: () => null,
        startWatcher: () => null,
        stopWatcher: () => null,
        runWatcherNow: async () => null,
      },
      // SDK 0.21.20: swapManager added to DaemonSystemRouteContext
      swapManager: null,
    }, new Request('http://127.0.0.1/api/system/status'));

    const response = await handlers.getServiceStatus();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      installed: true,
      network: {
        controlPlane: { surface: 'controlPlane', mode: 'off' },
        httpListener: { surface: 'httpListener', mode: 'off' },
        outbound: { mode: 'system' },
      },
    });
  });

  test('knowledge routes use injected graphql and knowledge services', async () => {
    const handlers = createDaemonKnowledgeRouteHandlers({
      artifactStore: {
        create: async () => ({ id: 'artifact-1' }),
      },
      configManager: {
        get: () => false,
      },
      inspectGraphqlAccess: () => ({ requiredScopes: [] }),
      normalizeAtSchedule: (at) => ({ kind: 'at', at }),
      normalizeEverySchedule: (interval, anchorAt) => ({ kind: 'every', interval, anchorAt }),
      normalizeCronSchedule: (expression, timezone, staggerMs) => ({ kind: 'cron', expression, timezone, staggerMs }),
      parseJsonBody: async () => ({}),
      parseOptionalJsonBody: async () => null,
      parseJsonText: () => ({}),
      requireAdmin: () => null,
      resolveAuthenticatedPrincipal: () => null,
      knowledgeService: {
        getStatus: async () => ({ ok: true }),
        listSources: () => [],
        listNodes: () => [],
        listIssues: () => [],
        getItem: () => null,
        listConnectors: () => [],
        getConnector: () => null,
        doctorConnector: async () => null,
        listProjectionTargets: async () => [],
        listExtractions: () => [],
        listUsageRecords: () => [],
        listConsolidationCandidates: () => [],
        getConsolidationCandidate: () => null,
        listConsolidationReports: () => [],
        getConsolidationReport: () => null,
        getExtraction: () => null,
        getSourceExtraction: () => null,
        listJobs: () => [],
        getJob: () => null,
        listJobRuns: () => [],
        listSchedules: () => [],
        getSchedule: () => null,
        ingestUrl: async () => ({}),
        ingestArtifact: async () => ({}),
        importBookmarksFromFile: async () => ({}),
        importUrlsFromFile: async () => ({}),
        syncBrowserHistory: async () => ({}),
        ingestConnectorInput: async () => ({}),
        search: () => [],
        buildPacket: async () => ({}),
        decideConsolidationCandidate: async () => ({}),
        runJob: async () => ({}),
        lint: async () => [],
        reindex: async () => ({}),
        saveSchedule: async () => ({}),
        deleteSchedule: async () => false,
        setScheduleEnabled: async () => null,
        renderProjection: async () => ({}),
        materializeProjection: async () => ({}),
      },
      knowledgeGraphqlService: {
        schemaText: 'type Query { status: String! }',
        execute: async () => ({ data: { status: 'ok' } }),
      },
    });

    const response = await handlers.getKnowledgeGraphqlSchema();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      language: 'graphql',
      domain: 'knowledge',
      schema: 'type Query { status: String! }',
    });
  });

  test('media routes use injected voice and artifact services', async () => {
    const handlers = createDaemonMediaRouteHandlers({
      artifactStore: {
        list: () => [{ id: 'artifact-1' }],
        create: async () => ({}),
        get: () => null,
        readContent: async () => ({
          record: { mimeType: 'text/plain' },
          buffer: new Uint8Array([1, 2, 3]),
        }),
      },
      configManager: {
        get: () => true,
      },
      mediaProviders: {
        status: async () => [],
        findProvider: () => null,
      },
      multimodalService: {
        getStatus: async () => ({ ok: true }),
        listProviders: async () => [],
        analyze: async () => ({}),
        buildPacket: () => ({}),
        writeBackAnalysis: async () => ({}),
      },
      parseJsonBody: async () => ({}),
      requireAdmin: () => null,
      voiceService: {
        getStatus: async () => ({ providers: [{ id: 'voice-1' }] }),
        listVoices: async () => [],
        synthesize: async () => ({}),
        synthesizeStream: async () => ({
          providerId: 'voice-1',
          mimeType: 'audio/mpeg',
          format: 'mp3',
          chunks: (async function* () {})(),
          metadata: {},
        }),
        transcribe: async () => ({}),
        openRealtimeSession: async () => ({}),
      },
      webSearchService: {
        getStatus: async () => ({ providers: [] }),
        search: async () => ({}),
      },
    });

    const response = await handlers.getArtifacts();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ artifacts: [{ id: 'artifact-1' }] });
  });
});
