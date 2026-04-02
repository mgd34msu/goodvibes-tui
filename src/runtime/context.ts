/**
 * RuntimeContext — the composition root object returned by bootstrapRuntime().
 *
 * main.ts receives this and uses it to drive the render loop, input handling,
 * and terminal lifecycle. The bootstrap owns initialization; main.ts owns
 * the runtime loop.
 */
import type { EventBus } from '../core/event-bus.ts';
import type { ConversationManager } from '../core/conversation.ts';
import type { Orchestrator } from '../core/orchestrator.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { PermissionManager } from '../permissions/manager.ts';
import type { HookDispatcher } from '../hooks/dispatcher.ts';
import type { FileStateCache } from '../state/file-cache.ts';
import type { ProjectIndex } from '../state/project-index.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { RuntimeStore } from './store/index.ts';
import type { RuntimeEventBus } from './events/index.ts';
import type { FeatureFlagManager } from './feature-flags/index.ts';

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
  /** Override working directory (default: process.cwd()) */
  workingDir?: string;
  /**
   * Callback invoked when the app should exit.
   * If provided, commandContext.exit will be wired to this immediately.
   * If omitted, callers must patch commandContext.exit after bootstrap returns.
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

  /** Legacy EventBus used for all current event wiring. */
  bus: EventBus;

  /**
   * Typed domain event bus for new runtime subsystems.
   * Optional until all consumers have been migrated.
   */
  runtimeBus?: RuntimeEventBus;

  /**
   * Zustand vanilla store for domain state slices.
   * Optional until all consumers have been migrated.
   */
  store?: RuntimeStore;

  /**
   * Feature flag and kill-switch manager.
   * Gates all new subsystems introduced in Tier 1 and beyond.
   * Optional until all consumers have been migrated.
   */
  featureFlags?: FeatureFlagManager;

  // ── Managers ────────────────────────────────────────────────────────

  /** Manages conversation history and message rendering. */
  conversation: ConversationManager;

  /** Controls tool execution approval flow. */
  permissions: PermissionManager;

  /** Registry of all registered tool implementations. */
  toolRegistry: ToolRegistry;

  // ── Provider ────────────────────────────────────────────────────────

  /** Global provider registry (singleton, imported directly in consumers). */
  providerRegistry: ProviderRegistry;

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
  shutdown: (sessionData: { messages: object[]; timestamp?: number }) => Promise<void>;
}
