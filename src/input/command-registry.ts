import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { ConversationManager } from '../core/conversation';
import type { ConfigManager } from '../config/index.ts';
import type { DeepReadonly, GoodVibesConfig } from '../config/index.ts';
import type { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import type { PermissionRequestHandler } from '@pellux/goodvibes-sdk/platform/permissions';
import type { SelectionItem, SelectionResult, SelectionAction } from './selection-modal.ts';
import type { FileUndoManager } from '@pellux/goodvibes-sdk/platform/state';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { KeybindingsManager } from './keybindings.ts';
import type { OnboardingWizardMode } from './onboarding/onboarding-wizard.ts';
import type { OpenOnboardingWizardOptions } from './handler-ui-state.ts';
import type { KnowledgeApi } from '@pellux/goodvibes-sdk/platform/knowledge';
import type { HookApi } from '@pellux/goodvibes-sdk/platform/hooks';
import type { McpApi } from '@pellux/goodvibes-sdk/platform/mcp';
import type { ProviderApi } from '@pellux/goodvibes-sdk/platform/providers';
import type { OpsApi } from '@/runtime/index.ts';
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
  submitInput?: (text: string, content?: import('@pellux/goodvibes-sdk/platform/providers').ContentPart[]) => void;
  submitSpokenInput?: (text: string, content?: import('@pellux/goodvibes-sdk/platform/providers').ContentPart[]) => void;
  stopSpokenOutput?: () => void;
  executeCommand?: (name: string, args: string[]) => Promise<boolean>;
  cancelGeneration?: () => void;
  completeModelSelection?: (selection: {
    model: { id: string; provider: string; displayName: string; registryKey: string };
    effort: string;
    contextCap?: number | null;
    /** Which config target to write the selected model to. Defaults to 'main'. */
    target?: import('./model-picker.ts').ModelPickerTarget;
  }) => void;
  clearScreen?: () => void;
  activatePlan?: (planId: string, task: string) => void;
  requestPermission?: PermissionRequestHandler;
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
    opts: { preSelectId?: string; allowSearch?: boolean; customActions?: Map<string, SelectionAction> } | undefined,
    callback: (result: SelectionResult | null) => void,
  ) => void;
  openSettingsModal?: (target?: string) => void;
  openSessionPicker?: () => void;
  openProfilePicker?: () => void;
  openShortcutsOverlay?: () => void;
  getScrollTop?: () => number;
  openPanelPicker?: () => void;
  showPanel?: (panelId: string, pane?: 'top' | 'bottom') => void;
  focusPanels?: () => void;
  openOpsPanel?: () => void;
  openCockpitPanel?: () => void;
  openOrchestrationPanel?: () => void;
  openForensicsPanel?: () => void;
  openIncidentPanel?: () => void;
  openPolicyPanel?: () => void;
  openHooksPanel?: () => void;
  openCommunicationPanel?: () => void;
  openMcpPanel?: () => void;
  openSecurityPanel?: () => void;
  openKnowledgePanel?: () => void;
  openRemotePanel?: () => void;
  openSubscriptionPanel?: () => void;
}

export interface CommandSessionServices {
  readonly conversationManager: ConversationManager;
  readonly runtime: CommandRuntimeState;
  readonly sessionManager?: import('@pellux/goodvibes-sdk/platform/sessions').SessionManager;
  readonly sessionMemoryStore?: import('@pellux/goodvibes-sdk/platform/core').SessionMemoryStore;
  readonly sessionLineageTracker?: import('@pellux/goodvibes-sdk/platform/core').SessionLineageTracker;
  readonly changeTracker?: import('@pellux/goodvibes-sdk/platform/sessions').SessionChangeTracker;
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
  readonly voiceProviderRegistry?: VoiceProviderRegistry;
  readonly voiceService?: VoiceService;
}

export interface CommandPlatformServices
  extends CommandPlatformConfigServices,
    CommandPlatformShellServices {}

export interface CommandOpsServices
  extends CommandOpsShellServices {}

export interface CommandExtensionRegistryServices {
  readonly toolRegistry: ToolRegistry;
  readonly mcpRegistry: McpRegistry;
  readonly evalRegistry?: import('../panels/eval-panel.ts').EvalRegistry;
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
    readonly hookApi?: HookApi;
    readonly mcpApi?: McpApi;
    readonly opsApi?: OpsApi;
    readonly transport?: DirectTransport;
  };
}

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

  /** Register a command. Also indexes all aliases for O(1) lookup. */
  register(command: SlashCommand): void {
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
        results.push({ command: cmd, score: q === '' ? 1 : bestScore });
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
