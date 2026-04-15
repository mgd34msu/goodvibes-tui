/**
 * RuntimeContext — the composition root object returned by bootstrapRuntime().
 *
 * main.ts receives this and uses it to drive the render loop, input handling,
 * and terminal lifecycle. The bootstrap owns initialization; main.ts owns
 * the runtime loop.
 */
import type { ConversationManager } from '../core/conversation.ts';
import type { Orchestrator } from '../core/orchestrator.ts';
import type { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools/registry';
import type { PermissionManager } from '../permissions/manager.ts';
import type { HookDispatcher } from '../hooks/dispatcher.ts';
import type { FileStateCache } from '@pellux/goodvibes-sdk/platform/state/file-cache';
import type { ProjectIndex } from '@pellux/goodvibes-sdk/platform/state/project-index';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { RuntimeStore } from './store/index.ts';
import type { RuntimeEventBus } from './events/index.ts';
import type { FeatureFlagManager } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/index';
import type { SessionSnapshot } from './session-persistence.ts';
import type { RuntimeServices } from './services.ts';
import type { PanelHealthMonitor } from '@pellux/goodvibes-sdk/platform/runtime/perf/panel-health-monitor';
import type { WorktreeRegistry } from './worktree/registry.ts';
import type { SandboxSessionRegistry } from './sandbox/session-registry.ts';

/**
 * Mutable runtime state that may be changed by slash commands or model-picker events.
 * Kept as a plain object so event handlers can close over it by reference.
 *
 * Named `MutableRuntimeState` to avoid a name collision with `RuntimeState` in
 * `src/runtime/store/state.ts`.
 */
export interface MutableRuntimeState {
  model: string;
  provider: string;
  debugMode: boolean;
  systemPrompt: string;
  /** Empty string if not configured. */
  reasoningEffort: string;
  sessionId: string;
}

/**
 * Options accepted by bootstrapRuntime().
 */
export interface BootstrapOptions {
  /** App-owned working directory for this runtime instance. */
  workingDir: string;
  /** App-owned home directory for this runtime instance. */
  homeDirectory: string;
  /** Explicit app-owned config manager for this runtime instance. */
  configManager: import('../config/manager.ts').ConfigManager;
  /**
   * Callback invoked when the app should exit.
   * If provided, commandContext.exit is wired during bootstrap.
   * Otherwise main.ts binds the shell-owned exit bridge immediately after bootstrap returns.
   */
  exit?: () => void;
}

/**
 * The fully-initialized runtime context produced by bootstrapRuntime().
 *
 * main.ts destructures this to obtain what it needs for the render loop
 * and input handling.
 */
export interface RuntimeContext {
  // ── Core subsystems ─────────────────────────────────────────────────

  /**
   * Typed domain event bus for new runtime subsystems.
   */
  runtimeBus: RuntimeEventBus;

  /**
   * Zustand vanilla store for domain state slices.
   */
  store: RuntimeStore;

  /**
   * App-scoped runtime services graph shared across adapters and shells.
   */
  services: RuntimeServices;

  /**
   * Feature flag and kill-switch manager.
   * Gates runtime subsystems and release controls.
   */
  featureFlags: FeatureFlagManager;

  // ── Managers ────────────────────────────────────────────────────────

  /** Manages conversation history and message rendering. */
  conversation: ConversationManager;

  /** Controls tool execution approval flow. */
  permissions: PermissionManager;

  /** Registry of all registered tool implementations. */
  toolRegistry: ToolRegistry;

  // ── Provider ────────────────────────────────────────────────────────

  /** Shared provider registry owned by the runtime services graph. */
  providerRegistry: ProviderRegistry;

  /** Shared panel-health monitor owned by the runtime services graph. */
  panelHealthMonitor: PanelHealthMonitor;

  /** Shared worktree registry owned by the runtime services graph. */
  worktreeRegistry: WorktreeRegistry;

  /** Shared sandbox session registry owned by the runtime services graph. */
  sandboxSessionRegistry: SandboxSessionRegistry;

  // ── Infrastructure ──────────────────────────────────────────────────

  /** Fires lifecycle hooks registered by the user or plugins. */
  hookDispatcher: HookDispatcher;

  // ── State ───────────────────────────────────────────────────────────

  /** File read/write cache shared across read/write/edit tools in a session. */
  fileCache: FileStateCache;

  /** Project-level file index shared across tools. */
  projectIndex: ProjectIndex;

  // ── Session ─────────────────────────────────────────────────────────

  /** Unique identifier for this user session (hex, prefixed "user-"). */
  sessionId: string;

  /** True if a previous session was resumed at startup. */
  isResumed: boolean;

  // ── Mutable runtime state ───────────────────────────────────────────

  /** Mutable model/provider/prompt state closed over by event handlers. */
  runtime: MutableRuntimeState;

  // ── Orchestrator ─────────────────────────────────────────────────────

  /**
   * Main LLM orchestrator. Drives the conversation loop, tool execution,
   * streaming, and context compaction.
   */
  orchestrator: Orchestrator;

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Logical shutdown: save session, fire hooks, stop background managers.
   * Does NOT touch the terminal — main.ts owns terminal teardown.
   *
   * @param sessionData - Latest conversation data to persist.
   */
  shutdown: (sessionData: SessionSnapshot) => Promise<void>;
}
