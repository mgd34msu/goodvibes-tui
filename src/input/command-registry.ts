import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { ConversationManager } from '../core/conversation';
import type { ConfigManager } from '../config/index.ts';
import type { DeepReadonly, GoodVibesConfig } from '../config/index.ts';
import type { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import type { PermissionRequestHandler } from '@pellux/goodvibes-sdk/platform/permissions';
import type { SelectionItem, SelectionResult, SelectionAction } from './selection-modal.ts';
import type { FileUndoManager } from '@pellux/goodvibes-sdk/platform/state';
import type { WorkspaceCheckpointManager } from '@pellux/goodvibes-sdk/platform/workspace';
import type { PanelManager, PanelDeepLinkTarget } from '../panels/panel-manager.ts';
import type { KeybindingsManager } from './keybindings.ts';
import type { OnboardingWizardMode } from './onboarding/onboarding-wizard.ts';
import type { OpenOnboardingWizardOptions } from './handler-ui-state.ts';
import type { KnowledgeApi } from '@pellux/goodvibes-sdk/platform/knowledge';
import type { MemorySpineClient } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import type { HookApi } from '@pellux/goodvibes-sdk/platform/hooks';
import type { McpApi } from '@pellux/goodvibes-sdk/platform/mcp';
import type { ProviderApi } from '@pellux/goodvibes-sdk/platform/providers';
import type { OpsApi } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { OperatorClient } from '@/runtime/index.ts';
import type { PeerClient } from '@/runtime/index.ts';
import type { DirectTransport } from '@/runtime/index.ts';
import type { VoiceProviderRegistry, VoiceService } from '@pellux/goodvibes-sdk/platform/voice';
import type {
  CommandWorkspaceShellServices,
} from '@/runtime/index.ts';
import type {
  CommandPlatformShellServices,
} from '@/runtime/index.ts';
import type {
  CommandExtensionShellServices,
} from '@/runtime/index.ts';
import type {
  CommandOpsShellServices,
  RemoteCommandService,
  PlanRuntimeService,
} from '@/runtime/index.ts';

export type {
  RemoteCommandService,
  PlanRuntimeService,
} from '@/runtime/index.ts';

export interface CommandRuntimeState {
  model: string;
  provider: string;
  debugMode: boolean;
  systemPrompt: string;
  reasoningEffort: string;
  sessionId: string;
  /**
   * Cumulative count of direct terminal writes the output guard intercepted
   * this session — surfaced by /debug. Optional so the SDK's MutableRuntimeState
   * (which has no such field) stays assignable; the guard sets it lazily on the
   * shared runtime object. (UX-B item 1a.)
   */
  terminalWritesIntercepted?: number;
}

/**
 * Top-level shell actions remain flat because commands and nearby shell routes
 * use them constantly, and nesting them would add noise without clarifying
 * ownership.
 */
export interface CommandUiActions {
  renderRequest: () => void;
  print: (text: string) => void;
  exit: () => void;
  /** Open the current composer draft in the user's $EDITOR and load back the edited text. */
  openComposerEditor?: () => void;
  submitInput?: (text: string, content?: import('@pellux/goodvibes-sdk/platform/providers').ContentPart[]) => void;
  submitSpokenInput?: (text: string, content?: import('@pellux/goodvibes-sdk/platform/providers').ContentPart[]) => void;
  stopSpokenOutput?: () => void;
  pasteFromClipboard?: () => {
    pasted: boolean;
    kind: 'image' | 'text' | 'none';
    marker?: string;
  };
  executeCommand?: (name: string, args: string[]) => Promise<boolean>;
  cancelGeneration?: () => void;
  /** True while an LLM turn is actively streaming. Used to give Escape
   *  cancel-turn precedence over a focused panel's own escape handling. */
  isGenerating?: () => boolean;
  completeModelSelection?: (selection: {
    model: { id: string; provider: string; displayName: string; registryKey: string };
    effort: string;
    contextCap?: number | null;
    /** Which config target to write the selected model to. Defaults to 'main'. */
    target?: import('./model-picker.ts').ModelPickerTarget;
  }) => void;
  /**
   * Commit an embedding-provider selection from the model picker's
   * 'embeddingProvider' mode (the 'embeddings' target). Deliberately separate
   * from completeModelSelection — embedding providers are not
   * ModelDefinition-shaped, so routing them through the same commit path
   * would require fabricating a fake model object.
   */
  completeEmbeddingProviderSelection?: (providerId: string) => void;
  clearScreen?: () => void;
  /**
   * Begin one line of concealed (masked) composer input for a password-like
   * secret. The typed text is masked in the composer and kept out of input
   * history and the transcript; the plaintext reaches only request.onSubmit.
   */
  beginConcealedInput?: (request: import('./concealed-input.ts').ConcealedInputRequest) => void;
  activatePlan?: (planId: string, task: string) => void;
  requestPermission?: PermissionRequestHandler;
  /**
   * Force a full-screen repaint on the next frame (reuses Compositor.resetDiff(),
   * the same call resize/bootstrap already use). Defense-in-depth for command
   * handlers whose spawned subprocess may have written to the real tty (e.g. a
   * stderr-capture regression) — nulls the diff buffers so the next composite()
   * repaints over any stray output instead of leaving it until an unrelated resize.
   */
  requestFullRepaint?: () => void;
}

export interface CommandShellUiOpeners {
  reloadSystemPrompt?: () => string;
  openOnboardingWizard?: (modeOrOptions?: OnboardingWizardMode | OpenOnboardingWizardOptions) => void;
  openModelPicker?: () => void;
  openModelPickerWithTarget?: (target: import('./model-picker.ts').ModelPickerTarget) => boolean;
  openProviderModelPickerWithTarget?: (target: import('./model-picker.ts').ModelPickerTarget) => boolean;
  openProviderPicker?: () => void;
  openContextInspector?: () => void;
  openBookmarkModal?: () => void;
  jumpToBookmark?: (key: string) => void;
  scrollToLine?: (line: number) => void;
  openHelpOverlay?: () => void;
  openSelection?: (
    title: string,
    items: SelectionItem[],
    opts: { preSelectId?: string; allowSearch?: boolean; customActions?: Map<string, SelectionAction>; primaryVerbLabel?: string } | undefined,
    callback: (result: SelectionResult | null) => void,
  ) => void;
  openSettingsModal?: (target?: string) => void;
  /**
   * Open a MIGRATE-TO-MODAL surface by name (W6.1 purge skeleton — WO-A/B
   * command runtimes call this instead of openCommandPanel once their panel
   * is converted to a ModalFactory config). Threaded from ui-openers.ts the
   * same way openSettingsModal is.
   */
  openModal?: (name: string) => void;
  openSessionPicker?: () => void;
  openProfilePicker?: () => void;
  openShortcutsOverlay?: () => void;
  getScrollTop?: () => number;
  openPanelPicker?: () => void;
  /**
   * Open the fuzzy command palette — a searchable picker over every registered
   * slash command (generated live from the registry). Bound to Ctrl+K and the
   * /palette command. Selecting a command pre-fills it into the composer.
   */
  openCommandPalette?: () => void;
  /**
   * Open (and optionally focus) a panel. UX-C focus rule: the command path is
   * "the user is mid-command-flow" — opening a panel this way leaves keyboard
   * focus in the composer by default. Pass `{ focus: true }` for a caller that
   * genuinely wants to grab focus (chords use panelManager.focusPanels()
   * directly instead of this method, so no current call site needs it — but
   * the intent is explicit rather than implicit here). `target` (DEBT-5) is a
   * fleet deep-link jump target forwarded to PanelManager.open.
   */
  showPanel?: (panelId: string, pane?: 'top' | 'bottom', target?: PanelDeepLinkTarget, opts?: { focus?: boolean }) => void;
  focusPanels?: () => void;
  focusPrompt?: () => void;
  openOpsPanel?: () => void;
  openCockpitPanel?: () => void;
  openOrchestrationPanel?: () => void;
  openForensicsPanel?: () => void;
  openIncidentPanel?: () => void;
  openPolicyPanel?: () => void;
  openHooksPanel?: () => void;
  openCommunicationPanel?: () => void;
  openMcpWorkspace?: () => void;
  openSecurityPanel?: () => void;
  openKnowledgePanel?: () => void;
  openMemoryPanel?: () => void;
  openRemotePanel?: () => void;
  openSubscriptionPanel?: () => void;
  /**
   * Open the LocalAuthPanel in masked-password-entry mode for the given
   * operation and username. The panel captures keystrokes into a private
   * buffer; no plaintext password is ever stored in input history, transcript,
   * logs, or recovery files.
   */
  openLocalAuthMaskedEntry?: (
    kind: 'add-user' | 'rotate-password',
    username: string,
  ) => void;
}

export interface CommandSessionServices {
  readonly conversationManager: ConversationManager;
  readonly runtime: CommandRuntimeState;
  readonly sessionManager?: import('@pellux/goodvibes-sdk/platform/sessions').SessionManager;
  readonly sessionMemoryStore?: import('@pellux/goodvibes-sdk/platform/core').SessionMemoryStore;
  readonly sessionLineageTracker?: import('@pellux/goodvibes-sdk/platform/core').SessionLineageTracker;
  readonly wrfcController?: import('@pellux/goodvibes-sdk/platform/agents').WrfcController;
  readonly changeTracker?: import('@pellux/goodvibes-sdk/platform/sessions').SessionChangeTracker;
  /**
   * Recompute the Orchestrator's session-wide usage totals from the
   * conversation's current message history. Call after a session resume
   * replays historical messages, before the next render, so the footer's
   * token counter reflects the resumed session's real usage instead of a
   * fresh Orchestrator's zeroed default (W0.9).
   */
  readonly hydrateSessionUsage?: () => void;
  /** The orchestration engine's command-facing facade — see runtime/workstream-services.ts. */
  readonly workstreamEngine?: import('../runtime/workstream-services.ts').WorkstreamCommandService;
  /** The repo source-tree code index — see runtime/code-index-services.ts. */
  readonly codeIndexStore?: import('@pellux/goodvibes-sdk/platform/state').CodeIndexStore;
  /** Tool-site reindex scheduler — `/codebase status` reports its last activity. */
  readonly codeIndexReindexScheduler?: import('@pellux/goodvibes-sdk/platform/state').CodeIndexReindexScheduler;
  /** Whether the (default-off) `agent-passive-code-injection` flag is on — for `/codebase status`. */
  readonly isPassiveCodeInjectionFlagEnabled?: () => boolean;
  /**
   * The MAIN interactive session's per-turn passive-injection
   * honesty ring — `Orchestrator.getTurnInjections()`, the main-session
   * counterpart to `AgentRecord.turnInjections` (wo801). `/recall injections`
   * with no agent id reads this. Optional so command contexts built without an
   * orchestrator (headless, tests) fall back to the honest empty state.
   */
  readonly getMainSessionTurnInjections?: () => readonly import('../renderer/turn-injection.ts').TurnInjectionEntry[];
}

export interface CommandProviderServices {
  readonly providerRegistry: ProviderRegistry;
  readonly providerOptimizer?: import('@pellux/goodvibes-sdk/platform/providers').ProviderOptimizer;
  readonly favoritesStore?: import('@pellux/goodvibes-sdk/platform/providers').FavoritesStore;
  readonly benchmarkStore?: import('@pellux/goodvibes-sdk/platform/providers').BenchmarkStore;
}

/**
 * Compose locally-owned command helpers with the narrower shell bridge-owned
 * runtime surfaces exported from runtime/shell-command-services.ts.
 */
export interface CommandWorkspaceUiServices {
  keybindingsManager?: KeybindingsManager;
  fileUndoManager?: FileUndoManager;
  workspaceCheckpointManager?: WorkspaceCheckpointManager;
  workspaceTrustManager?: import('../runtime/trust/workspace-trust.ts').WorkspaceTrustManager;
  panelManager?: PanelManager;
  profileManager?: import('@pellux/goodvibes-sdk/platform/profiles').ProfileManager;
  bookmarkManager?: import('@pellux/goodvibes-sdk/platform/bookmarks').BookmarkManager;
  projectPlanningService?: import('@pellux/goodvibes-sdk/platform/knowledge').ProjectPlanningService;
  projectPlanningProjectId?: string;
  workPlanStore?: import('../work-plans/work-plan-store.ts').WorkPlanStore;
}

export interface CommandWorkspaceServices
  extends CommandWorkspaceUiServices,
    CommandWorkspaceShellServices {}

export interface CommandPlatformConfigServices {
  readonly config: DeepReadonly<GoodVibesConfig>;
  readonly configManager: ConfigManager;
  /** Feature-flag runtime — backs the `/flags` command's listing and runtime toggling. */
  readonly featureFlagManager?: FeatureFlagManager;
  readonly voiceProviderRegistry?: VoiceProviderRegistry;
  readonly voiceService?: VoiceService;
  /** Direct-command consumer (`/search`) alongside the existing agent-tool consumer. */
  readonly webSearchService?: import('@pellux/goodvibes-sdk/platform/web-search').WebSearchService;
  /** Direct-command consumer (`/image`) — first production caller of `.generate()`. */
  readonly mediaProviders?: import('@pellux/goodvibes-sdk/platform/media').MediaProviderRegistry;
  readonly artifactStore?: import('@pellux/goodvibes-sdk/platform/artifacts').ArtifactStore;
}

export interface CommandPlatformServices
  extends CommandPlatformConfigServices,
    CommandPlatformShellServices {}

export interface CommandOpsServices
  extends CommandOpsShellServices {}

export interface CommandExtensionRegistryServices {
  readonly toolRegistry: ToolRegistry;
  readonly mcpRegistry: McpRegistry;
  readonly evalRegistry?: import('../panels/eval-registry.ts').EvalRegistry;
}

export interface CommandExtensionServices
  extends CommandExtensionRegistryServices,
    CommandExtensionShellServices {}

/**
 * CommandContext - Passed to every slash command handler so commands can
 * interact with the shell-facing platform surface without treating every
 * service as one flat bag of unrelated properties.
 */
export interface CommandContext
  extends CommandUiActions,
    CommandShellUiOpeners {
  readonly session: CommandSessionServices;
  readonly provider: CommandProviderServices;
  readonly workspace: CommandWorkspaceServices;
  readonly platform: CommandPlatformServices;
  readonly ops: CommandOpsServices;
  readonly extensions: CommandExtensionServices;
  readonly clients?: {
    readonly operator?: OperatorClient;
    readonly peer?: PeerClient;
    readonly providerApi?: ProviderApi;
    readonly knowledgeApi?: KnowledgeApi;
    /**
     * The cross-surface memory spine client (SDK 1.2.0 full-detach). `/recall`'s
     * browse/link/queue/export/import subcommands read and write through this —
     * not `knowledgeApi.memory` — so they fully detach from the local store file
     * when a daemon has been adopted, per
     * docs/decisions/2026-07-06-memory-wire-full-detach.md in the SDK repo.
     * `explain` and the `vector` diagnostic subcommand stay on `knowledgeApi.memory`
     * (host-side projection / host-only maintenance, ruled explicitly in that decision).
     */
    readonly memorySpine?: MemorySpineClient;
    readonly hookApi?: HookApi;
    readonly mcpApi?: McpApi;
    readonly opsApi?: OpsApi;
    readonly transport?: DirectTransport;
  };
}

/**
 * UX-C palette curation (item 4): the "common" first tier the slash-command
 * autocomplete dropdown shows before the alphabetical rest when it opens with
 * no filter typed yet (bare '/') — the "132-command palette unranked"
 * evaluator finding. Typed filtering (any non-empty query) is completely
 * unaffected — fuzzyMatch still searches every registered command exactly as
 * before; this only reorders the empty-query case. Curated for breadth across
 * the product's main workflows rather than raw usage frequency: help/config
 * (orientation), panel/model (workspace + provider), recall/codebase/search
 * (knowledge), workstream/checkpoint (control-plane), imagine (generation),
 * sessions (continuity), quit (exit).
 */
export const COMMON_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'help', 'config', 'panel', 'model', 'recall', 'codebase',
  'workstream', 'checkpoint', 'search', 'imagine', 'sessions', 'quit',
]);

/**
 * SlashCommand - A single slash command definition.
 */
export interface SlashCommand {
  /** Primary name, e.g. "model". Full invocation is "/model". */
  name: string;
  /** Alternate names, e.g. ["m"]. */
  aliases?: string[];
  /** One-line description shown in /help output. */
  description: string;
  /** Optional usage hint, e.g. "<model-id>". */
  usage?: string;
  /** Short inline argument hint shown after cursor in dim grey, e.g. "[name]". Falls back to usage if not set. */
  argsHint?: string;
  /** The function executed when the command is invoked. */
  handler: (args: string[], context: CommandContext) => void | Promise<void>;
}

/**
 * CommandRegistry - Central registry for all slash commands.
 * Supports fuzzy prefix matching for autocomplete.
 */
export class CommandRegistry {
  private commands = new Map<string, SlashCommand>();
  private aliasIndex = new Map<string, SlashCommand>();

  /**
   * Register a command. Also indexes all aliases for O(1) lookup.
   * Throws if the primary name or any alias collides with an existing
   * registration — silent last-write-wins previously shadowed whole
   * commands, so collisions must fail fast at startup (and are caught
   * statically by the alias lint test).
   */
  register(command: SlashCommand): void {
    const existingByName = this.commands.get(command.name) ?? this.aliasIndex.get(command.name);
    if (existingByName) {
      throw new Error(
        `Command registration collision: "${command.name}" is already registered by /${existingByName.name}.`,
      );
    }
    for (const alias of command.aliases ?? []) {
      const holder = this.commands.get(alias) ?? this.aliasIndex.get(alias);
      if (holder) {
        throw new Error(
          `Command alias collision: "${alias}" on /${command.name} is already registered by /${holder.name}.`,
        );
      }
    }
    this.commands.set(command.name, command);
    for (const alias of command.aliases ?? []) {
      this.aliasIndex.set(alias, command);
    }
  }

  /** Remove a command by primary name. Also removes its alias entries. */
  unregister(name: string): void {
    const cmd = this.commands.get(name);
    if (cmd) {
      for (const alias of cmd.aliases ?? []) {
        this.aliasIndex.delete(alias);
      }
    }
    this.commands.delete(name);
  }

  /**
   * get - Look up a command by its primary name or any alias. O(1) for both.
   */
  get(name: string): SlashCommand | undefined {
    return this.commands.get(name) ?? this.aliasIndex.get(name);
  }

  /** All registered commands. */
  getAll(): SlashCommand[] {
    return Array.from(this.commands.values());
  }

  /**
   * list - Compatibility alias for the simpler SDK registry surface.
   */
  list(): SlashCommand[] {
    return this.getAll();
  }

  /**
   * fuzzyMatch - Return commands ranked by how well `query` matches their
   * name or aliases. Returns all commands when query is empty.
   */
  fuzzyMatch(query: string): Array<{ command: SlashCommand; score: number }> {
    const q = query.toLowerCase();
    const results: Array<{ command: SlashCommand; score: number }> = [];

    for (const cmd of this.commands.values()) {
      const names = [cmd.name, ...(cmd.aliases ?? [])];
      let bestScore = 0;

      for (const candidate of names) {
        const score = scoreMatch(q, candidate);
        if (score > bestScore) bestScore = score;
      }

      if (bestScore > 0 || q === '') {
        // UX-C: with no query yet, rank the curated common tier (score 2)
        // ahead of everything else (score 1) — the tie-break below then sorts
        // each tier alphabetically, so the result is "common tier, then the
        // alphabetical rest" rather than one flat alphabetical list.
        const score = q === '' ? (COMMON_COMMAND_NAMES.has(cmd.name) ? 2 : 1) : bestScore;
        results.push({ command: cmd, score });
      }
    }

    // Sort: higher score first, then alphabetically
    results.sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name));
    return results;
  }

  /**
   * execute - Look up and run a command. Returns true if found, false otherwise.
   */
  async execute(rawName: string, args: string[], context: CommandContext): Promise<boolean> {
    const cmd = this.get(rawName);
    if (!cmd) return false;
    await cmd.handler(args, context);
    return true;
  }
}

/**
 * scoreMatch - Simple prefix/subsequence scorer.
 * Returns 0 if no match, higher is better.
 */
function scoreMatch(query: string, candidate: string): number {
  if (query === '') return 1;
  if (candidate === query) return 100;
  if (candidate.startsWith(query)) return 80;

  // Subsequence check
  let qi = 0;
  for (let ci = 0; ci < candidate.length && qi < query.length; ci++) {
    if (candidate[ci] === query[qi]) qi++;
  }
  if (qi === query.length) return 40 - query.length; // shorter query → higher score
  return 0;
}
