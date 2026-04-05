/**
 * Plugins domain state — tracks all plugins through their lifecycle,
 * configuration, and health status.
 */

/** States for the plugin lifecycle machine. */
export type PluginLifecycleState =
  | 'discovered'
  | 'loading'
  | 'loaded'
  | 'active'
  | 'degraded'
  | 'error'
  | 'unloading'
  | 'disabled';

/** Runtime record for a single plugin. */
export interface RuntimePlugin {
  /** Plugin name (filesystem identifier). */
  name: string;
  /** Plugin display name. */
  displayName: string;
  /** Plugin version string. */
  version: string;
  /** Plugin description. */
  description: string;
  /** Optional author. */
  author?: string;
  /** Current lifecycle state. */
  status: PluginLifecycleState;
  /** Whether the plugin is enabled in persistent config. */
  enabled: boolean;
  /** Whether the plugin is currently active and providing tools/hooks. */
  active: boolean;
  /** Number of tools contributed by this plugin. */
  toolCount: number;
  /** Error message if status === 'error' | 'degraded'. */
  error?: string;
  /** Epoch ms when the plugin was last loaded. */
  loadedAt?: number;
  /** Epoch ms when the plugin encountered its last error. */
  errorAt?: number;
  /** Plugin-specific configuration record. */
  config: Record<string, unknown>;
  /** Number of hook invocations this session. */
  hookInvocations: number;
}

/**
 * PluginDomainState — all plugin lifecycle state.
 */
export interface PluginDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Plugin registry ───────────────────────────────────────────────────────
  /** All plugins keyed by plugin name. */
  plugins: Map<string, RuntimePlugin>;
  /** Names of currently active plugins. */
  activePluginNames: string[];
  /** Names of plugins that encountered errors. */
  erroredPluginNames: string[];

  // ── Statistics ─────────────────────────────────────────────────────────────
  /** Total number of plugins discovered. */
  totalDiscovered: number;
  /** Total number of plugins currently active. */
  totalActive: number;
  /** Total tools contributed by all active plugins. */
  totalToolsContributed: number;

  // ── Load state ───────────────────────────────────────────────────────────
  /** Whether the initial plugin load has completed. */
  initialLoadComplete: boolean;
  /** Whether a reload is in progress. */
  reloadInProgress: boolean;
}

/**
 * Returns the default initial state for the plugins domain.
 */
export function createInitialPluginsState(): PluginDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    plugins: new Map(),
    activePluginNames: [],
    erroredPluginNames: [],
    totalDiscovered: 0,
    totalActive: 0,
    totalToolsContributed: 0,
    initialLoadComplete: false,
    reloadInProgress: false,
  };
}
