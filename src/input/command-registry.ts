import type { EventBus } from '../core/event-bus.ts';
import type { McpRegistry } from '../mcp/registry.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { ConversationManager } from '../core/conversation.ts';
import type { AppConfig } from '../config/index.ts';
import type { ConfigManager } from '../config/index.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { SelectionItem, SelectionResult, SelectionAction } from './selection-modal.ts';
import type { FileUndoManager } from '../state/file-undo.ts';

/**
 * CommandContext - Passed to every slash command handler so commands can
 * interact with the full application without circular-import issues.
 */
export interface CommandContext {
  eventBus: EventBus;
  providerRegistry: ProviderRegistry;
  conversationManager: ConversationManager;
  config: AppConfig;
  configManager: ConfigManager;
  /** Mutable runtime state — commands can mutate these in-place. */
  runtime: {
    model: string;
    provider: string;
    debugMode: boolean;
    systemPrompt: string;
    reasoningEffort: string;
    /** Current active session ID (e.g. "user-abc123"). Commands can update this to swap sessions. */
    sessionId: string;
  };
  /** Request a re-render. */
  renderRequest: () => void;
  /** Print a message to the conversation as a system note. */
  print: (text: string) => void;
  /** Exit the application cleanly. */
  exit: () => void;
  /** Reload system prompt from file (if configured). Returns new prompt string. */
  reloadSystemPrompt?: () => string;
  /** Open the model picker modal. */
  openModelPicker?: () => void;
  /** Open the provider picker modal. */
  openProviderPicker?: () => void;
  /** Open the context inspector modal. */
  openContextInspector?: () => void;
  /** Open the bookmark browser modal. */
  openBookmarkModal?: () => void;
  /** Toggle the help/shortcuts overlay. */
  openHelpOverlay?: () => void;
  /** Open the generic selection modal and call back with the result. */
  openSelection?: (
    title: string,
    items: SelectionItem[],
    opts: { preSelectId?: string; allowSearch?: boolean; customActions?: Map<string, SelectionAction> } | undefined,
    callback: (result: SelectionResult | null) => void,
  ) => void;
  /** Open the settings config browser modal. */
  openSettingsModal?: () => void;
  /** Open the dedicated session picker modal. */
  openSessionPicker?: () => void;
  /** Open the dedicated profile picker modal. */
  openProfilePicker?: () => void;
  /** Registry of all available tools. */
  toolRegistry: ToolRegistry;
  /** MCP server registry — available after startup auto-connect. */
  mcpRegistry: McpRegistry;
  /** File-level undo/redo for write and edit tool operations. */
  fileUndoManager?: FileUndoManager;
  /** Toggle the shortcuts/keyboard overlay. */
  openShortcutsOverlay?: () => void;
  /** Return the current scroll top line of the viewport. */
  getScrollTop?: () => number;
  /** Toggle the panel sidebar (open/close). */
  openPanelPicker?: () => void;
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
