import { describe, test, expect } from 'bun:test';
import { createInitialRuntimeState } from '../../runtime/store/state.ts';
import {
  // Primary domain selectors
  selectSession,
  selectModel,
  selectConversation,
  selectOverlays,
  selectPermissions,
  selectTasks,
  selectAgents,
  selectProviderHealth,
  selectMcp,
  selectPlugins,
  selectDaemon,
  selectAcp,
  selectIntegrations,
  selectTelemetry,
  selectGit,
  selectDiscovery,
  selectIntelligence,
  selectUiPerf,
  // Derived selectors
  selectActiveModel,
  selectRunningTasks,
  selectRunningAgents,
  selectDomainHealth,
  selectSystemHealth,
  selectPermissionMode,
  selectAnyOverlayVisible,
  selectTurnState,
  selectStreamToolPreview,
  selectIsTurnActive,
  selectIsSessionReady,
  selectRunningTaskCountByKind,
} from '../../runtime/store/selectors/index.ts';

describe('store-selectors contract', () => {
  const state = createInitialRuntimeState();

  describe('primary domain selectors: all 18 return correct domain slice', () => {
    test('selectSession returns session domain', () => {
      const session = selectSession(state);
      expect(session).toBe(state.session);
      expect(typeof session.revision).toBe('number');
    });

    test('selectModel returns model domain', () => {
      const model = selectModel(state);
      expect(model).toBe(state.model);
      expect(typeof model.activeProviderId).toBe('string');
    });

    test('selectConversation returns conversation domain', () => {
      const conv = selectConversation(state);
      expect(conv).toBe(state.conversation);
    });

    test('selectOverlays returns overlays domain', () => {
      const overlays = selectOverlays(state);
      expect(overlays).toBe(state.overlays);
    });

    test('the runtime state has no slot for the removed side-view layout', () => {
      expect(Object.keys(state)).not.toContain('panels');
    });

    test('selectPermissions returns permissions domain', () => {
      const perms = selectPermissions(state);
      expect(perms).toBe(state.permissions);
    });

    test('selectTasks returns tasks domain', () => {
      const tasks = selectTasks(state);
      expect(tasks).toBe(state.tasks);
      expect(tasks.tasks).toBeInstanceOf(Map);
    });

    test('selectAgents returns agents domain', () => {
      const agents = selectAgents(state);
      expect(agents).toBe(state.agents);
    });

    test('selectProviderHealth returns provider health domain', () => {
      const ph = selectProviderHealth(state);
      expect(ph).toBe(state.providerHealth);
    });

    test('selectMcp returns MCP domain', () => {
      const mcp = selectMcp(state);
      expect(mcp).toBe(state.mcp);
    });

    test('selectPlugins returns plugins domain', () => {
      const plugins = selectPlugins(state);
      expect(plugins).toBe(state.plugins);
    });

    test('selectDaemon returns daemon domain', () => {
      const daemon = selectDaemon(state);
      expect(daemon).toBe(state.daemon);
    });

    test('selectAcp returns ACP domain', () => {
      const acp = selectAcp(state);
      expect(acp).toBe(state.acp);
    });

    test('selectIntegrations returns integrations domain', () => {
      const integrations = selectIntegrations(state);
      expect(integrations).toBe(state.integrations);
    });

    test('selectTelemetry returns telemetry domain', () => {
      const telemetry = selectTelemetry(state);
      expect(telemetry).toBe(state.telemetry);
    });

    test('selectGit returns git domain', () => {
      const git = selectGit(state);
      expect(git).toBe(state.git);
    });

    test('selectDiscovery returns discovery domain', () => {
      const discovery = selectDiscovery(state);
      expect(discovery).toBe(state.discovery);
    });

    test('selectIntelligence returns intelligence domain', () => {
      const intelligence = selectIntelligence(state);
      expect(intelligence).toBe(state.intelligence);
    });

    test('selectUiPerf returns UI perf domain', () => {
      const uiPerf = selectUiPerf(state);
      expect(uiPerf).toBe(state.surfacePerf);
    });
  });

  describe('derived selectors: correct types from initial state', () => {
    test('selectActiveModel returns ActiveModelSummary with string fields', () => {
      const summary = selectActiveModel(state);

      expect(typeof summary.providerId).toBe('string');
      expect(typeof summary.modelId).toBe('string');
      expect(typeof summary.displayName).toBe('string');
    });

    test('selectRunningTasks returns empty array from initial state', () => {
      const tasks = selectRunningTasks(state);

      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks).toHaveLength(0);
    });

    test('selectRunningAgents returns empty array from initial state', () => {
      const agents = selectRunningAgents(state);

      expect(Array.isArray(agents)).toBe(true);
      expect(agents).toHaveLength(0);
    });

    test('selectPermissionMode returns a string', () => {
      const mode = selectPermissionMode(state);
      expect(typeof mode).toBe('string');
    });

    test('selectAnyOverlayVisible returns false from initial state', () => {
      const visible = selectAnyOverlayVisible(state);
      expect(visible).toBe(false);
    });

    test('selectTurnState returns a string', () => {
      const turnState = selectTurnState(state);
      expect(typeof turnState).toBe('string');
    });

    test('selectStreamToolPreview returns undefined from initial state', () => {
      const preview = selectStreamToolPreview(state);
      expect(preview).toBeUndefined();
    });

    test('selectIsTurnActive returns false from initial state (turn is idle)', () => {
      const active = selectIsTurnActive(state);
      // Initial turn state is 'idle', should not be active
      expect(typeof active).toBe('boolean');
    });

    test('selectIsSessionReady returns boolean', () => {
      const ready = selectIsSessionReady(state);
      expect(typeof ready).toBe('boolean');
    });

    test('selectSystemHealth returns composite system health with domains record', () => {
      const health = selectSystemHealth(state);

      expect(typeof health.status).toBe('string');
      expect(typeof health.hasCritical).toBe('boolean');
      expect(typeof health.hasDegraded).toBe('boolean');
      expect(typeof health.domains).toBe('object');
    });

    test('selectDomainHealth returns CompositeHealthStatus for each tracked domain', () => {
      const trackedDomains = ['providerHealth', 'mcp', 'daemon', 'acp', 'integrations'] as const;

      for (const domain of trackedDomains) {
        const status = selectDomainHealth(state, domain);
        expect(typeof status).toBe('string');
        expect(['healthy', 'degraded', 'critical', 'unknown']).toContain(status);
      }
    });

    test('selectRunningTaskCountByKind returns empty record from initial state', () => {
      const counts = selectRunningTaskCountByKind(state);

      expect(typeof counts).toBe('object');
      expect(Object.keys(counts)).toHaveLength(0);
    });
  });
});
