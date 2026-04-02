/**
 * Plugin lifecycle system types — v3 §4.6 and §9.
 *
 * Types here extend the store domain types with the richer capability
 * manifest and transition models used by the PluginLifecycleManager.
 */

import type { PluginLifecycleState } from '../store/domains/plugins.ts';
import type { PluginManifest } from '../../plugins/loader.ts';

// Re-export so consumers only need to import from this module.
export type { PluginLifecycleState } from '../store/domains/plugins.ts';

// ── Capability manifest ───────────────────────────────────────────────────────

/**
 * The set of capabilities a plugin can declare in its manifest (§9.1).
 *
 * All capabilities are **deny-by-default**: a plugin must explicitly request
 * each capability and the runtime must grant it before the capability is
 * exercisable.
 */
export type PluginCapability =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'network.outbound'
  | 'shell.exec'
  | 'register.tool'
  | 'register.provider'
  | 'register.panel'
  | 'register.hook';

/** All defined capability strings as a readonly array. */
export const ALL_CAPABILITIES: ReadonlyArray<PluginCapability> = [
  'filesystem.read',
  'filesystem.write',
  'network.outbound',
  'shell.exec',
  'register.tool',
  'register.provider',
  'register.panel',
  'register.hook',
] as const;

/**
 * Capability manifest embedded in (or derived from) a plugin's manifest.json.
 *
 * `requested` lists every capability the plugin declares it needs.
 * `granted` is resolved by the runtime after validation — it may be a strict
 * subset of `requested` if some capabilities are denied by policy.
 */
export interface PluginCapabilityManifest {
  /** Capabilities declared by the plugin author. */
  readonly requested: ReadonlyArray<PluginCapability>;
  /** Capabilities actually granted by the runtime. Populated after resolution. */
  granted: ReadonlyArray<PluginCapability>;
  /** Capabilities that were requested but explicitly denied by runtime policy. */
  denied: ReadonlyArray<PluginCapability>;
  /** Human-readable denial reasons keyed by capability. */
  denialReasons: Partial<Record<PluginCapability, string>>;
}

// ── Extended plugin manifest ──────────────────────────────────────────────────

/**
 * PluginManifestV2 extends the loader's PluginManifest with capability
 * declarations (§9.1). Stored inside manifest.json under the `capabilities`
 * key. Omitting the key is equivalent to requesting no capabilities.
 */
export interface PluginManifestV2 extends PluginManifest {
  /** Optional capability list declared by the plugin. */
  capabilities?: PluginCapability[];
  /**
   * Minimum runtime version this plugin requires.
   * Semver string (e.g. "0.9.0"). Unset = no constraint.
   */
  minRuntimeVersion?: string;
}

// ── State machine ─────────────────────────────────────────────────────────────

/**
 * A single recorded state transition for a plugin.
 */
export interface PluginTransition {
  /** The plugin name this transition applies to. */
  readonly pluginName: string;
  /** State before the transition. */
  readonly from: PluginLifecycleState;
  /** State after the transition. */
  readonly to: PluginLifecycleState;
  /** Unix timestamp (ms) when the transition occurred. */
  readonly ts: number;
  /** Optional human-readable reason (e.g. error message, disable reason). */
  readonly reason?: string;
}

/**
 * Result of a state machine transition attempt.
 */
export type TransitionResult =
  | { ok: true; from: PluginLifecycleState; to: PluginLifecycleState }
  | { ok: false; reason: string };

// ── Health check ─────────────────────────────────────────────────────────────

/**
 * Result of a plugin health check (used during hot-reload, §9.2).
 */
export interface PluginHealthCheckResult {
  /** Whether the plugin is considered healthy after the check. */
  readonly healthy: boolean;
  /** Human-readable status message. */
  readonly message: string;
  /** Duration of the health check in milliseconds. */
  readonly durationMs: number;
}

// ── Runtime plugin record ─────────────────────────────────────────────────────

/**
 * PluginLifecycleRecord — full runtime record for a plugin tracked by the
 * PluginLifecycleManager. Extends the basic RuntimePlugin from the store
 * domain with the capability manifest and transition history.
 */
export interface PluginLifecycleRecord {
  /** Plugin name (filesystem identifier). */
  readonly name: string;
  /** Plugin version string. */
  readonly version: string;
  /** Current lifecycle state. */
  state: PluginLifecycleState;
  /** Resolved capability manifest. */
  capabilities: PluginCapabilityManifest;
  /** Last N state transitions (capped at MAX_TRANSITION_HISTORY). */
  transitions: PluginTransition[];
  /** Epoch ms when the plugin was last successfully activated. */
  activatedAt?: number;
  /** Epoch ms when the plugin last transitioned to error. */
  errorAt?: number;
  /** Last error message, if any. */
  lastError?: string;
  /** Whether a hot-reload is currently in progress for this plugin. */
  reloading: boolean;
}

/** Maximum transition history entries kept per plugin. */
export const MAX_TRANSITION_HISTORY = 50;

// ── Manager options ───────────────────────────────────────────────────────────

/**
 * Options accepted by `createPluginLifecycleManager()`.
 */
export interface PluginLifecycleManagerOptions {
  /**
   * Session ID injected into emitted events.
   * Defaults to an empty string when not provided.
   */
  sessionId?: string;
  /**
   * Optional policy callback invoked during capability resolution.
   * Return `true` to grant the capability, `false` to deny.
   * Defaults to a permissive policy that grants all valid capabilities.
   */
  capabilityPolicy?: (pluginName: string, capability: PluginCapability) => boolean;
}
