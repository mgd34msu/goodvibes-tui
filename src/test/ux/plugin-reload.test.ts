/**
 * UX Anti-Regression: Plugin Reload While Panels Subscribed (v3 §18.5)
 *
 * Verifies that reloading a plugin does not break panel subscriptions —
 * panel state remains intact, plugin metadata updates correctly, and the
 * plugin registry stays consistent through the reload lifecycle.
 *
 * All tests use pure state manipulation — no real I/O, no event bus.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { createInitialRuntimeState } from '../../runtime/store/state.ts';
import type { RuntimeState } from '../../runtime/store/state.ts';
import {
  selectPlugins,
  selectPanels,
  selectActivePanels,
} from '../../runtime/store/selectors/index.ts';
import type { PluginDomainState, RuntimePlugin } from '@/runtime/index.ts';
import type { PanelDomainState } from '../../runtime/store/domains/panels.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fixed timestamp used in test helpers to avoid non-deterministic Date.now() calls. */
const TEST_TIMESTAMP = 1700000000000;

function makePlugin(
  name: string,
  status: RuntimePlugin['status'] = 'active',
): RuntimePlugin {
  return {
    name,
    displayName: `Plugin ${name}`,
    version: '1.0.0',
    description: `Test plugin ${name}`,
    status,
    enabled: true,
    active: status === 'active',
    toolCount: 3,
    loadedAt: TEST_TIMESTAMP - 5000,
    config: {},
    hookInvocations: 12,
  };
}

/** Build plugin domain state with given plugins active. */
function makePluginState(
  plugins: RuntimePlugin[],
  reloadInProgress = false,
): PluginDomainState {
  const pluginMap = new Map<string, RuntimePlugin>();
  const activeNames: string[] = [];
  const erroredNames: string[] = [];

  for (const plugin of plugins) {
    pluginMap.set(plugin.name, plugin);
    if (plugin.status === 'active') activeNames.push(plugin.name);
    if (plugin.status === 'error') erroredNames.push(plugin.name);
  }

  return {
    revision: 1,
    lastUpdatedAt: TEST_TIMESTAMP,
    source: 'plugin-reload-test',
    plugins: pluginMap,
    activePluginNames: activeNames,
    erroredPluginNames: erroredNames,
    totalDiscovered: plugins.length,
    totalActive: activeNames.length,
    totalToolsContributed: activeNames.length * 3,
    initialLoadComplete: true,
    reloadInProgress,
  };
}

/** Open panels state with plugin_manager panel open. */
function makeOpenPanelsState(base: PanelDomainState): PanelDomainState {
  const panelMap = new Map(base.panels);
  const pluginManagerPanel = panelMap.get('plugin_manager');
  if (pluginManagerPanel) {
    panelMap.set('plugin_manager', {
      ...pluginManagerPanel,
      open: true,
      focused: true,
      lastActivatedAt: TEST_TIMESTAMP - 500,
    });
  }
  return {
    ...base,
    panels: panelMap,
    focusedPanelId: 'plugin_manager',
    revision: base.revision + 1,
    lastUpdatedAt: TEST_TIMESTAMP,
    source: 'plugin-reload-test',
  };
}

/** Simulate reload: plugin goes unloading → loading → active. */
function applyPluginReload(
  state: RuntimeState,
  pluginName: string,
): { unloading: RuntimeState; loading: RuntimeState; reloaded: RuntimeState } {
  const plugins = state.plugins;
  const plugin = plugins.plugins.get(pluginName);
  if (!plugin) throw new Error(`Plugin ${pluginName} not found`);

  // Phase 1: unloading
  const unloadingMap = new Map(plugins.plugins);
  unloadingMap.set(pluginName, { ...plugin, status: 'unloading', active: false });
  const unloadingState: RuntimeState = {
    ...state,
    plugins: {
      ...plugins,
      plugins: unloadingMap,
      activePluginNames: plugins.activePluginNames.filter((n) => n !== pluginName),
      totalActive: plugins.totalActive - 1,
      reloadInProgress: true,
      revision: plugins.revision + 1,
      lastUpdatedAt: TEST_TIMESTAMP,
      source: 'plugin-unloading',
    },
  };

  // Phase 2: loading
  const loadingMap = new Map(unloadingState.plugins.plugins);
  loadingMap.set(pluginName, { ...plugin, status: 'loading', active: false });
  const loadingState: RuntimeState = {
    ...unloadingState,
    plugins: {
      ...unloadingState.plugins,
      plugins: loadingMap,
      reloadInProgress: true,
      revision: unloadingState.plugins.revision + 1,
      lastUpdatedAt: TEST_TIMESTAMP,
      source: 'plugin-loading',
    },
  };

  // Phase 3: reloaded
  const reloadedMap = new Map(loadingState.plugins.plugins);
  const reloadedPlugin: RuntimePlugin = {
    ...plugin,
    status: 'active',
    active: true,
    loadedAt: TEST_TIMESTAMP,
    hookInvocations: 0, // reset on reload
  };
  reloadedMap.set(pluginName, reloadedPlugin);
  const reloadedState: RuntimeState = {
    ...loadingState,
    plugins: {
      ...loadingState.plugins,
      plugins: reloadedMap,
      activePluginNames: [...plugins.activePluginNames],
      totalActive: plugins.totalActive,
      reloadInProgress: false,
      revision: loadingState.plugins.revision + 1,
      lastUpdatedAt: TEST_TIMESTAMP,
      source: 'plugin-active',
    },
  };

  return { unloading: unloadingState, loading: loadingState, reloaded: reloadedState };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ux:plugin-reload — plugin reload while panels subscribed', () => {
  let state: RuntimeState;

  beforeEach(() => {
    state = createInitialRuntimeState();
  });

  describe('plugin lifecycle state transitions', () => {
    test('plugin transitions unloading → loading → active during reload', () => {
      const plugins = [makePlugin('precision-engine'), makePlugin('goodvibes-analytics')];
      const pluginState = makePluginState(plugins);
      const withPlugins: RuntimeState = { ...state, plugins: pluginState };

      const { unloading, loading, reloaded } = applyPluginReload(withPlugins, 'precision-engine');

      expect(selectPlugins(unloading).plugins.get('precision-engine')?.status).toBe('unloading');
      expect(selectPlugins(loading).plugins.get('precision-engine')?.status).toBe('loading');
      expect(selectPlugins(reloaded).plugins.get('precision-engine')?.status).toBe('active');
    });

    test('reloadInProgress flag is set during reload and cleared after', () => {
      const plugins = [makePlugin('my-plugin')];
      const withPlugins: RuntimeState = { ...state, plugins: makePluginState(plugins) };
      const { unloading, loading, reloaded } = applyPluginReload(withPlugins, 'my-plugin');

      expect(selectPlugins(unloading).reloadInProgress).toBe(true);
      expect(selectPlugins(loading).reloadInProgress).toBe(true);
      expect(selectPlugins(reloaded).reloadInProgress).toBe(false);
    });

    test('other plugins remain active during reload of one plugin', () => {
      const plugins = [
        makePlugin('plugin-a'),
        makePlugin('plugin-b'),
        makePlugin('plugin-c'),
      ];
      const withPlugins: RuntimeState = { ...state, plugins: makePluginState(plugins) };
      const { unloading, loading, reloaded } = applyPluginReload(withPlugins, 'plugin-a');

      for (const phase of [unloading, loading, reloaded]) {
        expect(selectPlugins(phase).plugins.get('plugin-b')?.status).toBe('active');
        expect(selectPlugins(phase).plugins.get('plugin-c')?.status).toBe('active');
      }
    });

    test('plugin registry size stays constant through reload cycle', () => {
      const plugins = [makePlugin('my-plugin'), makePlugin('other-plugin')];
      const withPlugins: RuntimeState = { ...state, plugins: makePluginState(plugins) };
      const { unloading, loading, reloaded } = applyPluginReload(withPlugins, 'my-plugin');

      expect(selectPlugins(withPlugins).plugins.size).toBe(2);
      expect(selectPlugins(unloading).plugins.size).toBe(2);
      expect(selectPlugins(loading).plugins.size).toBe(2);
      expect(selectPlugins(reloaded).plugins.size).toBe(2);
    });
  });

  describe('panel subscriptions survive plugin reload', () => {
    test('open panels remain open through plugin reload cycle', () => {
      const plugins = [makePlugin('my-plugin')];
      const openPanels = makeOpenPanelsState(selectPanels(state));
      const withBoth: RuntimeState = { ...state, panels: openPanels as unknown as Record<string, unknown>, plugins: makePluginState(plugins) };

      const { unloading, loading, reloaded } = applyPluginReload(withBoth, 'my-plugin');

      for (const phase of [unloading, loading, reloaded]) {
        // Panels are unaffected by plugin reload
        const pluginPanel = selectPanels(phase).panels.get('plugin_manager');
        expect(pluginPanel?.open).toBe(true);
      }
    });

    test('focused panel does not change during plugin reload', () => {
      const plugins = [makePlugin('my-plugin')];
      const openPanels = makeOpenPanelsState(selectPanels(state));
      const withBoth: RuntimeState = { ...state, panels: openPanels as unknown as Record<string, unknown>, plugins: makePluginState(plugins) };

      const { unloading, loading, reloaded } = applyPluginReload(withBoth, 'my-plugin');

      for (const phase of [unloading, loading, reloaded]) {
        expect(selectPanels(phase).focusedPanelId).toBe('plugin_manager');
      }
    });

    test('active panels count is unchanged by plugin reload', () => {
      const plugins = [makePlugin('my-plugin')];
      const openPanels = makeOpenPanelsState(selectPanels(state));
      const withBoth: RuntimeState = { ...state, panels: openPanels as unknown as Record<string, unknown>, plugins: makePluginState(plugins) };
      const initialActiveCount = selectActivePanels(withBoth).length;

      const { reloaded } = applyPluginReload(withBoth, 'my-plugin');
      expect(selectActivePanels(reloaded).length).toBe(initialActiveCount);
    });
  });

  describe('plugin metadata after reload', () => {
    test('loadedAt timestamp is refreshed after reload', () => {
      const plugin = makePlugin('my-plugin');
      const originalLoadedAt = plugin.loadedAt!;
      const withPlugin: RuntimeState = { ...state, plugins: makePluginState([plugin]) };

      const { reloaded } = applyPluginReload(withPlugin, 'my-plugin');
      const reloadedPlugin = selectPlugins(reloaded).plugins.get('my-plugin');

      expect(reloadedPlugin?.loadedAt).toBe(TEST_TIMESTAMP);
      expect(reloadedPlugin?.loadedAt).toBeGreaterThan(originalLoadedAt);
    });

    test('hook invocation counter resets after reload', () => {
      const plugin = { ...makePlugin('my-plugin'), hookInvocations: 42 };
      const withPlugin: RuntimeState = { ...state, plugins: makePluginState([plugin]) };

      const { reloaded } = applyPluginReload(withPlugin, 'my-plugin');
      const reloadedPlugin = selectPlugins(reloaded).plugins.get('my-plugin');
      expect(reloadedPlugin?.hookInvocations).toBe(0);
    });
  });
});
