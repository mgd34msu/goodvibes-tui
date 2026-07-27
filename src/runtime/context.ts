/**
 * RuntimeContext — the composition root object returned by bootstrapRuntime().
 *
 * main.ts receives this and uses it to drive the render loop, input handling,
 * and terminal lifecycle. The bootstrap owns initialization; main.ts owns
 * the runtime loop.
 */
import type { ConversationManager } from '../core/conversation';
import type { Orchestrator } from '../core/orchestrator';
import type { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import type { PermissionManager } from '@pellux/goodvibes-sdk/platform/permissions';
import type { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks';
import type { FileStateCache } from '@pellux/goodvibes-sdk/platform/state';
import type { ProjectIndex } from '@pellux/goodvibes-sdk/platform/state';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { RuntimeStore } from './store/index.ts';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { SessionSnapshot } from '@/runtime/index.ts';
import type { RuntimeServices } from './services.ts';
import type { ComponentHealthMonitor } from './perf/panel-health-monitor.ts';
import type { WorktreeRegistry } from '@/runtime/index.ts';
import type { SandboxSessionRegistry } from '@/runtime/index.ts';

/**
 * Options accepted by bootstrapRuntime().
 */
export interface BootstrapOptions {
  /** App-owned working directory for this runtime instance. */
  workingDir: string;
  /** App-owned home directory for this runtime instance. */
  homeDirectory: string;
  /**
   * The daemon's identity directory for this runtime instance.
   *
   * Named rather than derived so the client's daemon-TIER secret reads and
   * writes follow a GOODVIBES_DAEMON_HOME set on its own. Absent, the secret
   * store falls back to `<homeDirectory>/.goodvibes/daemon`, which is the same
   * answer whenever that variable is unset.
   */
  daemonHomeDirectory?: string;
  /** Explicit app-owned config manager for this runtime instance. */
  configManager: import('@pellux/goodvibes-sdk/platform/config').ConfigManager;
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

  /** Shared component-health monitor owned by the runtime services graph. */
  componentHealthMonitor: ComponentHealthMonitor;

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
