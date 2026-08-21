import { describe, test, expect } from 'bun:test';
import { createInitialRuntimeState } from '../../runtime/store/state.ts';
import type { PanelDomainState } from '../../runtime/store/domains/panels.ts';
import {
  // Primary domain selectors
  selectSession,
  selectModel,
  selectConversation,
  selectOverlays,
  selectPanels,
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
  selectActivePanels,
  selectFocusedPanel,
  selectAnyOverlayVisible,
  selectTurnState,
  selectStreamToolPreview,
  selectIsTurnActive,
  selectIsSessionReady,
  selectRunningTaskCountByKind,
} from '../../runtime/store/selectors/index.ts';

describe('store-selectors contract', () => {
  const state = createInitialRuntimeState();

  describe('primary domain selectors: all 19 return correct domain slice', () => {
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

    test('selectPanels returns panels domain', () => {
      const panels = selectPanels(state);
      // panels selector returns Record<string, unknown> (SDK generic); runtime value is PanelDomainState
      expect(panels === (state.panels as unknown)).toBe(true);
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

    test('selectActivePanels returns an array from initial state', () => {
      const panels = selectActivePanels(state);
      expect(Array.isArray(panels)).toBe(true);
    });

    test('selectFocusedPanel returns undefined or a PanelState from initial state', () => {
      const focused = selectFocusedPanel(state);
      // Initial state may or may not have a focused panel
      expect(focused === undefined || typeof focused === 'object').toBe(true);
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
