import { InputTokenizer } from '../core/tokenizer.ts';
import { SelectionManager } from './selection.ts';
import { copyToClipboard, pasteFromClipboard, pasteImageFromClipboard } from '../utils/clipboard.ts';
import type { EventBus } from '../core/event-bus.ts';
import type { InfiniteBuffer } from '../core/history.ts';
import type { CommandRegistry, CommandContext } from './command-registry.ts';
import { AutocompleteEngine } from './autocomplete.ts';
import { FilePickerModal } from './file-picker.ts';
import { ModelPickerModal } from './model-picker.ts';
import { SelectionModal } from './selection-modal.ts';
import type { SelectionResult, SelectionAction } from './selection-modal.ts';
import { SearchManager } from './search.ts';
import { InputHistory, HistorySearch } from './input-history.ts';
import type { ConversationManager } from '../core/conversation.ts';
import type { PermissionCategory } from '../permissions/manager.ts';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { getBookmarkManager } from '../bookmarks/manager.ts';
import { resolveAndValidatePath } from '../utils/path-safety.ts';
import type { ContentPart } from '../providers/interface.ts';
import { logger } from '../utils/logger.ts';
import { loadSkillByTrigger } from '../tools/registry-tool/skill-loader.ts';
import { ProcessModal } from '../renderer/process-modal.ts';
import { LiveTailModal } from '../renderer/live-tail-modal.ts';
import { BlockActionsMenu } from '../renderer/block-actions.ts';
import { AgentDetailModal } from '../renderer/agent-detail-modal.ts';
import { ContextInspectorModal } from '../renderer/context-inspector.ts';
import { BookmarkModal } from './bookmark-modal.ts';
import { SettingsModal } from './settings-modal.ts';
import { SessionPickerModal } from './session-picker-modal.ts';
import { ProfilePickerModal } from './profile-picker-modal.ts';
import { MODEL_PICKER_CHROME_LINES } from '../renderer/model-picker-overlay.ts';
import { getPanelManager } from '../panels/panel-manager.ts';
import { getKeybindingsManager } from './keybindings.ts';

/**
 * InputHandler - Owns prompt text, paste registry, and keyboard/mouse handling.
 * Extracted from main.ts and StateManager.
 */
export class InputHandler {
  public prompt = '';
  public cursorPos = 0;
  public showExitNotice = false;
  /** Max visible rows for the input area. Content beyond this scrolls internally. */
  public static readonly MAX_INPUT_ROWS = 8;
  /** Internal scroll offset for the input area when content exceeds MAX_INPUT_ROWS. */
  public inputScrollTop = 0;
  public lastCopyTime = 0;
  /** True when the user has entered slash-command mode (prompt starts with '/'). */
  public commandMode = false;
  /** True when the process indicator bar has keyboard focus. */
  public indicatorFocused = false;
  /** True when keyboard focus is on the active panel (arrow/enter go to panel, not prompt). */
  public panelFocused = false;

  private tokenizer = new InputTokenizer();
  private pasteRegistry = new Map<string, string>();
  private nextPasteId = 1;
  private lastCtrlCTime = 0;
  private commandRegistry: CommandRegistry | null = null;
  private commandContext: CommandContext | undefined = undefined;
  public autocomplete: AutocompleteEngine | null = null;
  public filePicker = new FilePickerModal();
  public modelPicker = new ModelPickerModal();
  public selectionModal = new SelectionModal();
  public searchManager = new SearchManager();
  public processModal = new ProcessModal();
  public liveTailModal = new LiveTailModal();
  public agentDetailModal = new AgentDetailModal();
  public contextInspectorModal = new ContextInspectorModal();
  public bookmarkModal = new BookmarkModal();
  public blockActionsMenu = new BlockActionsMenu();
  public settingsModal = new SettingsModal();
  public sessionPickerModal = new SessionPickerModal();
  public profilePickerModal = new ProfilePickerModal();
  /** True when the help overlay is visible. */
  public helpOverlayActive = false;
  public helpScrollOffset = 0;
  public shortcutsOverlayActive = false;
  public shortcutsScrollOffset = 0;
  private inputHistory: InputHistory | null = null;
  public historySearch: HistorySearch = new HistorySearch(() => this.inputHistory?.getEntries() ?? []);
  private conversationManager: ConversationManager | null = null;
  private selectionCallback: ((result: SelectionResult | null) => void) | null = null;
  /** Time of last [COPIED] block feedback, for brief display. */
  public lastBlockCopyTime = 0;
  private mouseDownRow = -1;
  private mouseDownCol = -1;

  /** Pasted images: maps marker IDs to base64 image data. */
  private imageRegistry = new Map<string, { data: string; mediaType: string }>();
  private nextImageId = 1;

  // ── Undo / Redo ────────────────────────────────────────────────────────────
  private undoStack: Array<{ prompt: string; cursorPos: number }> = [];
  private redoStack: Array<{ prompt: string; cursorPos: number }> = [];
  private static readonly MAX_UNDO = 50;

  // ── Path completion (Tab on path-like token) ───────────────────────────────
  /** Current list of path completions cycling on repeated Tab presses. */
  private pathCompletions: string[] = [];
  /** Index into pathCompletions for Tab cycling. */
  private pathCompletionIndex = -1;
  /** The raw prefix that triggered path completion (e.g. 'src/in'). */
  private pathCompletionPrefix = '';
  /** Start offset in prompt where the path token begins. */
  private pathCompletionStart = 0;

  /** Regex matching atomic markers in the prompt. Used by findMarkerAtPos and expandPrompt. */
  private static readonly MARKER_REGEX = /\[(TEXT|IMAGE): [^\]]+\]/g;

  /** Data-driven base64 image prefix detection. */
  private static readonly IMAGE_PREFIXES: { prefix: string; mediaType: string }[] = [
    { prefix: 'iVBORw0KGgo', mediaType: 'image/png' },
    { prefix: '/9j/', mediaType: 'image/jpeg' },
    { prefix: 'UklGR', mediaType: 'image/webp' },
    { prefix: 'R0lGOD', mediaType: 'image/gif' },
  ];

  /** Data-driven binary image magic byte detection. */
  private static readonly BINARY_IMAGE_MAGIC: {
    magic: number[];
    mediaType: string;
    extraCheck?: (b: Buffer) => boolean;
  }[] = [
    { magic: [0x89, 0x50, 0x4E, 0x47], mediaType: 'image/png' },
    { magic: [0xFF, 0xD8, 0xFF], mediaType: 'image/jpeg' },
    { magic: [0x52, 0x49, 0x46, 0x46], mediaType: 'image/webp', extraCheck: (b: Buffer) => b.length > 11 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
    { magic: [0x47, 0x49, 0x46], mediaType: 'image/gif' },
  ];

  /** Image file extensions handled as image attachments. */
  private static readonly IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

  constructor(
    private bus: EventBus,
    private selection: SelectionManager,
    private getScrollTop: () => number,
    private getViewportHeight: () => number,
    private getHistory: () => InfiniteBuffer,
    private scroll: (delta: number) => void,
    private exitApp: () => void,
  ) {}

  /**
   * setHistory - Wire in the InputHistory instance.
   * Optional; if not set, history navigation is disabled.
   */
  public setHistory(history: InputHistory): void {
    this.inputHistory = history;
  }

  /**
   * setCommandRegistry - Wire in the slash command registry and context.
   * Must be called before commands can be processed.
   */
  public setCommandRegistry(registry: CommandRegistry, context: CommandContext): void {
    this.commandRegistry = registry;
    this.commandContext = context;
    this.autocomplete = new AutocompleteEngine(registry);
  }

  /**
   * setConversationManager - Wire in the conversation manager for block copy/apply/collapse.
   */
  public setConversationManager(cm: ConversationManager): void {
    this.conversationManager = cm;
  }

  /**
   * openSelection - Open the generic selection modal with a callback.
   * The callback receives SelectionResult on selection, or null on cancel/escape.
   */
  public openSelection(
    title: string,
    items: import('./selection-modal.ts').SelectionItem[],
    opts: {
      preSelectId?: string;
      allowSearch?: boolean;
      customActions?: Map<string, SelectionAction>;
    } | undefined,
    callback: (result: SelectionResult | null) => void,
  ): void {
    this.selectionModal.open(title, items, opts);
    this.selectionCallback = callback;
    this.bus.emit('render:request');
  }

  /**
   * formatFileSize - Format bytes into a human-readable size string.
   */
  private static formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  /**
   * mediaTypeFromExt - Get image mediaType from file extension.
   */
  private static mediaTypeFromExt(ext: string): string {
    switch (ext.toLowerCase()) {
      case '.png': return 'image/png';
      case '.webp': return 'image/webp';
      case '.gif': return 'image/gif';
      default: return 'image/jpeg';
    }
  }

  /**
   * registerPaste - Stores multi-line content and returns a visual marker string.
   * Detects base64 image data (PNG, JPEG, WebP, GIF), image file paths, and text pastes.
   */
  public registerPaste(content: string): string {
    // Detect raw binary image data (pasted from clipboard as binary)
    const bytes = Buffer.from(content, 'binary');
    if (bytes.length > 100) {
      for (const { magic, mediaType, extraCheck } of InputHandler.BINARY_IMAGE_MAGIC) {
        if (magic.every((b, i) => bytes[i] === b) && (!extraCheck || extraCheck(bytes))) {
          const id = `img${this.nextImageId++}`;
          const base64 = bytes.toString('base64');
          const sizeKB = Math.round(bytes.length / 1024);
          this.imageRegistry.set(id, { data: base64, mediaType });
          return `[IMAGE: ${id}, clipboard, ${sizeKB}KB]`;
        }
      }
    }

    // Detect base64-encoded image data (data-driven prefix check)
    const trimmed = content.trim();
    if (trimmed.length > 100) {
      for (const { prefix, mediaType } of InputHandler.IMAGE_PREFIXES) {
        if (trimmed.startsWith(prefix)) {
          const id = `img${this.nextImageId++}`;
          const sizeKB = Math.round(trimmed.length * 3 / 4 / 1024);
          this.imageRegistry.set(id, { data: trimmed, mediaType });
          return `[IMAGE: ${id}, clipboard, ${sizeKB}KB]`;
        }
      }
    }

    // Detect pasted file paths that are images
    if (InputHandler.IMAGE_EXTENSIONS.some(ext => trimmed.toLowerCase().endsWith(ext))) {
      try {
        const resolvedPath = resolveAndValidatePath(trimmed);
        if (existsSync(resolvedPath)) {
          const data = readFileSync(resolvedPath);
          const base64 = data.toString('base64');
          const ext = trimmed.slice(trimmed.lastIndexOf('.'));
          const mediaType = InputHandler.mediaTypeFromExt(ext);
          const filename = trimmed.split('/').pop() ?? 'image';
          const id = `img${this.nextImageId++}`;
          this.imageRegistry.set(id, { data: base64, mediaType });
          return `[IMAGE: ${id}, ${filename}, ${InputHandler.formatFileSize(data.length)}]`;
        }
      } catch (err) {
        logger.debug('registerPaste: could not read image file path', { err });
      }
    }

    const lines = content.split('\n');
    if (lines.length <= 8) return content;
    const id = `p${this.nextPasteId++}`;
    this.pasteRegistry.set(id, content);
    return `[TEXT: ${id}, ${lines.length} lines]`;
  }

  /**
   * expandPrompt - Replaces paste markers with actual content.
   * If image markers are present, returns ContentPart[] for multimodal delivery.
   * Otherwise returns a plain string.
   */
  private expandPrompt(text: string): string | ContentPart[] {
    const foundPasteIds = new Set<string>();
    const markerRegex = /\[TEXT: (p\d+), (\d+) lines\]/g;

    const replacements: { marker: string; index: number; content: string }[] = [];
    let match;
    while ((match = markerRegex.exec(text)) !== null) {
      const id = match[1]; // e.g. 'p1'
      const content = this.pasteRegistry.get(id);
      if (content) {
        replacements.push({ marker: match[0], index: match.index, content });
        foundPasteIds.add(id);
      }
    }

    let expanded = text;
    for (let i = replacements.length - 1; i >= 0; i--) {
      const { marker, index, content } = replacements[i];
      expanded = expanded.slice(0, index) + content + expanded.slice(index + marker.length);
    }

    for (const id of this.pasteRegistry.keys()) {
      if (!foundPasteIds.has(id)) {
        this.pasteRegistry.delete(id);
      }
    }

    // Expand !@path content injection markers — only match !@ at word start
    const injectRegex = /(?:^|(?<=\s))!@(\S+)/g;
    let injectMatch;
    while ((injectMatch = injectRegex.exec(expanded)) !== null) {
      const filePath = injectMatch[1];
      try {
        const resolvedPath = resolveAndValidatePath(filePath);
        const content = readFileSync(resolvedPath, 'utf-8');
        expanded = expanded.slice(0, injectMatch.index) + content + expanded.slice(injectMatch.index + injectMatch[0].length);
        injectRegex.lastIndex = injectMatch.index + content.length;
      } catch (err) {
        // Leave the marker if file can't be read
        logger.debug('expandPrompt: failed to read injected file', { path: filePath, error: String(err) });
      }
    }

    // Check for image markers — extract ID from each marker and look up directly
    const imageMarkerRegex = /\[IMAGE: (img\d+), [^\]]+\]/g;
    const imageMarkers: { marker: string; index: number; id: string }[] = [];
    let imgMatch;
    while ((imgMatch = imageMarkerRegex.exec(expanded)) !== null) {
      imageMarkers.push({ marker: imgMatch[0], index: imgMatch.index, id: imgMatch[1] });
    }

    if (imageMarkers.length === 0) {
      // No images — clean up stale registry and return plain string
      this.imageRegistry.clear();
      return expanded;
    }

    // Build ContentPart array: interleave text segments and image parts
    // Images are looked up by ID extracted from the marker
    const parts: ContentPart[] = [];
    let lastIndex = 0;
    const usedIds = new Set<string>();

    for (const { marker, index, id } of imageMarkers) {
      // Text before this image marker
      if (index > lastIndex) {
        const textSegment = expanded.slice(lastIndex, index);
        if (textSegment) parts.push({ type: 'text', text: textSegment });
      }
      // Image part — look up by ID
      const img = this.imageRegistry.get(id);
      if (img) {
        parts.push({ type: 'image', data: img.data, mediaType: img.mediaType });
        usedIds.add(id);
      }
      lastIndex = index + marker.length;
    }

    // Trailing text after last image marker
    if (lastIndex < expanded.length) {
      const textSegment = expanded.slice(lastIndex);
      if (textSegment) parts.push({ type: 'text', text: textSegment });
    }

    // Keep only used image ids in registry
    for (const id of this.imageRegistry.keys()) {
      if (!usedIds.has(id)) this.imageRegistry.delete(id);
    }

    return parts;
  }

  /**
   * getImageAttachments - Returns a copy of the current image registry.
   * Callers can use this to attach images when building LLM messages.
   */
  public getImageAttachments(): Map<string, { data: string; mediaType: string }> {
    return new Map(this.imageRegistry);
  }

  /**
   * findMarkerAtPos - Returns the start/end of an atomic marker if pos is inside one.
   * Used to make backspace/delete/arrow treat markers as single units.
   */
  /**
   * cleanupMarkerRegistry - If the given marker text is an IMAGE marker,
   * parses its ID and removes it from imageRegistry.
   */
  private cleanupMarkerRegistry(markerText: string): void {
    const match = /^\[IMAGE: (img\d+),/.exec(markerText);
    if (match) {
      this.imageRegistry.delete(match[1]);
    }
  }

  private findMarkerAtPos(pos: number): { start: number; end: number } | null {
    const markerRegex = new RegExp(InputHandler.MARKER_REGEX.source, 'g');
    let m;
    while ((m = markerRegex.exec(this.prompt)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (pos > start && pos <= end) {
        return { start, end };
      }
    }
    return null;
  }

  private handleCopy(): void {
    if (this.selection.hasSelection()) {
      copyToClipboard(this.selection.getSelectedText(this.getHistory()));
      this.lastCopyTime = Date.now();
      this.bus.emit('render:request');
      setTimeout(() => this.bus.emit('render:request'), 2005);
    }
  }

  /**
   * handleBlockCopy - Ctrl+Y: Copy the content of the nearest code/tool block.
   */
  private handleBlockCopy(): void {
    const cm = this.conversationManager;
    if (!cm) return;
    const lineIndex = this.getScrollTop();
    const content = cm.getBlockContentAtLine(lineIndex);
    if (content) {
      copyToClipboard(content);
      this.lastBlockCopyTime = Date.now();
      this.bus.emit('render:request');
      setTimeout(() => this.bus.emit('render:request'), 2005);
    }
  }

  /**
   * handleBookmark - Ctrl+B: Toggle bookmark on the nearest block.
   */
  private handleBookmark(): void {
    const cm = this.conversationManager;
    if (!cm) return;
    const lineIndex = this.getScrollTop();
    // Access blockRegistry via findNearestBlock (uses private findNearestBlock)
    // We'll call getBlockContentAtLine to determine if there's a nearby block,
    // then use the block's collapseKey as bookmark key.
    const nearest = cm.findNearestBlock(lineIndex);
    if (!nearest) {
      cm.log('[Ctrl+B: No block found nearby]', { fg: '240' });
      this.bus.emit('render:request');
      return;
    }
    const bm = getBookmarkManager();
    const label = `${nearest.type}: ${nearest.rawContent.slice(0, 40).replace(/\n/g, ' ')}`;
    const added = bm.toggle(nearest.collapseKey, label);
    const msg = added
      ? `[Bookmarked: ${nearest.collapseKey}]`
      : `[Bookmark removed: ${nearest.collapseKey}]`;
    cm.log(msg, { fg: added ? '#22c55e' : '244' });
    this.bus.emit('render:request');
  }

  /**
   * handleBlockSave - Ctrl+S: Save nearest block content to a file.
   */
  private handleBlockSave(): void {
    const cm = this.conversationManager;
    if (!cm) return;
    const lineIndex = this.getScrollTop();
    const content = cm.getBlockContentAtLine(lineIndex);
    if (!content) {
      cm.log('[Ctrl+S: No block found nearby]', { fg: '240' });
      this.bus.emit('render:request');
      return;
    }
    const nearest = cm.findNearestBlock(lineIndex);
    const label = nearest?.type ?? 'block';
    try {
      const bm = getBookmarkManager();
      const filePath = bm.saveToFile(content, label);
      // Show tilde path for readability
      const homePath = process.env.HOME || process.env.USERPROFILE || '';
      const displayPath = homePath ? filePath.replace(homePath, '~') : filePath;
      cm.log(`[Saved to: ${displayPath}]`, { fg: '#22c55e' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cm.log(`[Save failed: ${msg}]`, { fg: '#ef4444' });
    }
    this.bus.emit('render:request');
  }

  /**
   * executeBlockAction - Execute a block action ID on the nearest block.
   * Called when the user selects an action from the BlockActionsMenu.
   */
  private executeBlockAction(actionId: string): void {
    switch (actionId) {
      case 'copy':     this.handleBlockCopy(); break;
      case 'bookmark': this.handleBookmark(); break;
      case 'toggle':   this.handleBlockToggle(); break;
      case 'apply':    this.handleDiffApply(); break;
      case 'rerun':    this.handleBlockRerun(); break;
    }
  }

  /**
   * handleBlockRerun - Re-run the tool call for the nearest tool block.
   * Emits a tool-rerun event for the orchestrator to handle.
   */
  private handleBlockRerun(): void {
    const cm = this.conversationManager;
    if (!cm) return;
    const lineIndex = this.getScrollTop();
    const nearest = cm.findNearestBlock(lineIndex, 'tool');
    if (!nearest) {
      cm.log('[Re-run: No tool block found nearby]', { fg: '240' });
      this.bus.emit('render:request');
      return;
    }
    this.bus.emit('block:rerun', { blockIndex: nearest.blockIndex, content: nearest.rawContent });
    this.bus.emit('render:request');
  }

  /**
   * handleBlockToggle - Tab (non-command mode): Toggle collapse of nearest block.
   */
  private handleBlockToggle(): void {
    const cm = this.conversationManager;
    if (!cm) return;
    const lineIndex = this.getScrollTop();
    const blockIdx = cm.toggleCollapseAtLine(lineIndex);
    if (blockIdx >= 0) {
      this.bus.emit('block:toggle-collapse', { blockIndex: blockIdx });
      this.bus.emit('render:request');
    }
  }

  /**
   * handleDiffApply - Ctrl+A when a diff block is nearest: Apply the diff via EventBus.
   * Returns true if a diff was found and applied (so caller can skip default Ctrl+A).
   */
  private handleDiffApply(): boolean {
    const cm = this.conversationManager;
    if (!cm) return false;
    const lineIndex = this.getScrollTop();
    const diff = cm.getDiffAtLine(lineIndex);
    if (!diff || !diff.filePath) return false;

    // Apply the diff using the file_edit permission flow via EventBus
    this.bus.emit('permission:request', {
      callId: `diff-apply-${Date.now()}`,
      tool: 'file_edit',
      args: { path: diff.filePath, original: diff.original, updated: diff.updated },
      category: 'write' as PermissionCategory,
      resolve: (approved: boolean) => {
        if (!approved) return;
        // Apply the diff using the imported fs functions
        let resolvedPath: string;
        try {
          resolvedPath = resolveAndValidatePath(diff.filePath);
        } catch (err) {
          cm.log(`[Diff apply failed: ${err instanceof Error ? err.message : err}]`, { fg: '#ef4444' });
          return;
        }
        try {
          const content = readFileSync(resolvedPath, 'utf-8');
          if (diff.original && content.includes(diff.original)) {
            // Count occurrences to prevent ambiguous replacement
            const occurrenceCount = content.split(diff.original).length - 1;
            if (occurrenceCount > 1) {
              cm.log(`[Diff apply failed: pattern found ${occurrenceCount} times in ${diff.filePath} — ambiguous]`, { fg: '#ef4444' });
            } else {
              const newContent = content.replace(diff.original, diff.updated);
              writeFileSync(resolvedPath, newContent, 'utf-8');
              cm.log(`[Applied diff to ${diff.filePath}]`, { fg: '#22c55e' });
            }
          } else {
            cm.log(`[Diff apply failed: original text not found in ${diff.filePath}]`, { fg: '#ef4444' });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          cm.log(`[Diff apply error: ${msg}]`, { fg: '#ef4444' });
        }
        this.bus.emit('render:request');
      },
    });
    return true;
  }

  /**
   * Handle Ctrl+C:
   * - If prompt has text: clear it
   * - If prompt is empty and LLM is thinking: cancel generation
   * - If prompt is empty and idle: show exit notice (double = exit)
   */
  private handleCtrlC(): void {
    if (this.prompt.length > 0) {
      // Clear the input
      this.saveUndoState();
      this.prompt = '';
      this.cursorPos = 0;
      return;
    }
    // Prompt is empty — try to cancel or exit
    this.bus.emit('cancel:generation');
    const now = Date.now();
    if (now - this.lastCtrlCTime < 1000) {
      this.exitApp();
    } else {
      this.lastCtrlCTime = now;
      this.showExitNotice = true;
      this.bus.emit('render:request');
      setTimeout(() => {
        this.showExitNotice = false;
        this.bus.emit('render:request');
      }, 1000);
    }
  }

  /**
   * Handle Escape:
   * - If prompt has text: clear it
   * - If prompt is empty: cancel generation (double-tap not needed)
   */
  private handleEscape(): void {
    // If help overlay is open, close it
    if (this.helpOverlayActive) {
      this.helpOverlayActive = false;
      this.helpScrollOffset = 0;
      this.bus.emit('render:request');
      return;
    }
    // If shortcuts overlay is open, close it
    if (this.shortcutsOverlayActive) {
      this.shortcutsOverlayActive = false;
      this.shortcutsScrollOffset = 0;
      this.bus.emit('render:request');
      return;
    }
    // If bookmark modal is open, close it
    if (this.bookmarkModal.active) {
      this.bookmarkModal.close();
      this.bus.emit('render:request');
      return;
    }
    // If agent detail modal is open, go back to process list
    if (this.agentDetailModal.active) {
      this.agentDetailModal.close();
      this.processModal.open();
      return;
    }
    // If live-tail peek is open, go back to process list
    if (this.liveTailModal.active) {
      this.liveTailModal.close();
      this.processModal.open();
      return;
    }
    // If settings modal is open, handle Esc — cancel edit if editing, else close
    if (this.settingsModal.active) {
      if (this.settingsModal.editingMode) {
        this.settingsModal.cancelEdit();
      } else {
        this.settingsModal.close();
      }
      this.bus.emit('render:request');
      return;
    }
    // If session picker is open, close it
    if (this.sessionPickerModal.active) {
      this.sessionPickerModal.close();
      this.bus.emit('render:request');
      return;
    }
    // If profile picker is open, close it
    if (this.profilePickerModal.active) {
      this.profilePickerModal.close();
      this.bus.emit('render:request');
      return;
    }
    // If context inspector is open, close it
    if (this.contextInspectorModal.active) {
      this.contextInspectorModal.close();
      return;
    }
    // If process modal is open, close it
    if (this.processModal.active) {
      this.processModal.close();
      return;
    }
    // If model picker is active, close it
    if (this.modelPicker.active) {
      this.modelPicker.close();
      return;
    }
    // If file picker is active, close it (don't clear input)
    if (this.filePicker.active) {
      this.filePicker.close();
      return;
    }
    // If selection modal is active, close it
    if (this.selectionModal.active) {
      const cb = this.selectionCallback;
      this.selectionCallback = null;
      this.selectionModal.close();
      cb?.(null);
      return;
    }
    if (this.prompt.length > 0) {
      this.saveUndoState();
      this.prompt = '';
      this.cursorPos = 0;
      return;
    }
    // Prompt is empty — cancel generation
    this.bus.emit('cancel:generation');
  }

  /**
   * feed - Process raw stdin data through the tokenizer.
   */
  public feed(data: string): void {
    const tokens = this.tokenizer.feed(data);
    const history = this.getHistory();
    const vHeight = this.getViewportHeight();
    const scrollTop = this.getScrollTop();
    const lineCount = history.getLineCount();

    const kb = getKeybindingsManager();

    for (const token of tokens) {

      // --- Search mode has focus: two phases ---
      // Phase 1 (unlocked): typing query, text goes to search, Enter/Tab locks
      // Phase 2 (locked): navigation with arrows/comma/period, Esc closes
      if (this.searchManager.active) {
        if (!this.searchManager.locked) {
          // --- Typing phase: build the query ---
          if (token.type === 'text') {
            const newQuery = this.searchManager.query + token.value;
            this.searchManager.search(newQuery, history);
            this.bus.emit('search:update', {
              query: this.searchManager.query,
              matchCount: this.searchManager.matches.length,
              currentMatch: this.searchManager.currentMatch,
            });
          } else if (token.type === 'key') {
            if (token.logicalName === 'escape') {
              this.searchManager.close();
              this.bus.emit('search:end');
            } else if (token.logicalName === 'enter' || token.logicalName === 'tab') {
              // Lock the query — switch to navigation mode
              if (this.searchManager.query.length > 0) {
                this.searchManager.lock();
                // Scroll to first match
                const matchLine = this.searchManager.getCurrentMatchLine();
                if (matchLine >= 0) {
                  this.scroll(matchLine - this.getScrollTop() - Math.floor(this.getViewportHeight() / 2));
                }
                this.bus.emit('search:update', {
                  query: this.searchManager.query,
                  matchCount: this.searchManager.matches.length,
                  currentMatch: this.searchManager.currentMatch,
                });
              }
            } else if (token.logicalName === 'backspace') {
              const newQuery = this.searchManager.query.slice(0, -1);
              this.searchManager.search(newQuery, history);
              this.bus.emit('search:update', {
                query: this.searchManager.query,
                matchCount: this.searchManager.matches.length,
                currentMatch: this.searchManager.currentMatch,
              });
            } else if (kb.matches('search', token)) {
              this.searchManager.close();
              this.bus.emit('search:end');
            }
          }
        } else {
          // --- Navigation phase: locked query, navigate matches ---
          if (token.type === 'key') {
            if (token.logicalName === 'escape' || kb.matches('search', token)) {
              this.searchManager.close();
              this.bus.emit('search:end');
            } else if (token.logicalName === 'right' || token.logicalName === 'down') {
              this.searchManager.nextMatch();
              const matchLine = this.searchManager.getCurrentMatchLine();
              if (matchLine >= 0) {
                this.scroll(matchLine - this.getScrollTop() - Math.floor(this.getViewportHeight() / 2));
              }
              this.bus.emit('search:update', {
                query: this.searchManager.query,
                matchCount: this.searchManager.matches.length,
                currentMatch: this.searchManager.currentMatch,
              });
            } else if (token.logicalName === 'left' || token.logicalName === 'up') {
              this.searchManager.prevMatch();
              const matchLine = this.searchManager.getCurrentMatchLine();
              if (matchLine >= 0) {
                this.scroll(matchLine - this.getScrollTop() - Math.floor(this.getViewportHeight() / 2));
              }
              this.bus.emit('search:update', {
                query: this.searchManager.query,
                matchCount: this.searchManager.matches.length,
                currentMatch: this.searchManager.currentMatch,
              });
            } else if (token.logicalName === 'backspace') {
              // Unlock — go back to typing mode
              this.searchManager.unlock();
            }
          } else if (token.type === 'text') {
            // . for next, , for previous
            if (token.value === 'j' || token.value === 'l') {
              this.searchManager.nextMatch();
              const matchLine = this.searchManager.getCurrentMatchLine();
              if (matchLine >= 0) {
                this.scroll(matchLine - this.getScrollTop() - Math.floor(this.getViewportHeight() / 2));
              }
              this.bus.emit('search:update', {
                query: this.searchManager.query,
                matchCount: this.searchManager.matches.length,
                currentMatch: this.searchManager.currentMatch,
              });
            } else if (token.value === 'k' || token.value === 'h') {
              this.searchManager.prevMatch();
              const matchLine = this.searchManager.getCurrentMatchLine();
              if (matchLine >= 0) {
                this.scroll(matchLine - this.getScrollTop() - Math.floor(this.getViewportHeight() / 2));
              }
              this.bus.emit('search:update', {
                query: this.searchManager.query,
                matchCount: this.searchManager.matches.length,
                currentMatch: this.searchManager.currentMatch,
              });
            }
          }
        }
        this.bus.emit('render:request');
        continue;
      }

      // --- Selection modal has focus: intercept all input ---
      if (this.selectionModal.active) {
        if (token.type === 'text') {
          // Space = toggle/cycle action on selected item (stays open)
          if (token.value === ' ') {
            const selected = this.selectionModal.getSelected();
            if (selected && this.selectionCallback) {
              // Fire callback with toggle action but DON'T close the modal
              this.selectionCallback({ item: selected, action: 'toggle' });
            }
          } else {
            // Other text input goes to fuzzy search query
            this.selectionModal.setQuery(this.selectionModal.query + token.value);
          }
        } else if (token.type === 'key') {
          if (token.logicalName === 'escape') {
            const cb = this.selectionCallback;
            this.selectionCallback = null;
            this.selectionModal.close();
            cb?.(null);
          } else if (token.logicalName === 'enter') {
            const customAction = this.selectionModal.customActions.get('enter');
            const selected = this.selectionModal.getSelected();
            if (selected) {
              const cb = this.selectionCallback;
              this.selectionCallback = null;
              this.selectionModal.close();
              cb?.({ item: selected, action: customAction ?? 'select' });
            }
          } else if (token.logicalName === 'up') {
            this.selectionModal.moveUp();
          } else if (token.logicalName === 'down') {
            this.selectionModal.moveDown();
          } else if (token.logicalName === 'backspace') {
            // Edit search query
            if (this.selectionModal.query.length > 0) {
              this.selectionModal.setQuery(this.selectionModal.query.slice(0, -1));
            }
          } else if (token.logicalName && token.logicalName.length === 1) {
            // Custom action keys must be single characters (e.g., 'd', 'e'). Multi-char keys like 'enter' are handled separately above.
            // Check custom action keys (single-char key names like 'd', 'e')
            const action = this.selectionModal.customActions.get(token.logicalName);
            if (action) {
              const selected = this.selectionModal.getSelected();
              if (selected) {
                const cb = this.selectionCallback;
                this.selectionCallback = null;
                this.selectionModal.close();
                cb?.({ item: selected, action });
              }
            }
          }
          // All other keys ignored while selection modal is active
        }
        this.bus.emit('render:request');
        continue;
      }

      // --- Bookmark modal has focus: intercept all input ---
      if (this.bookmarkModal.active) {
        if (token.type === 'key') {
          if (token.logicalName === 'escape') {
            this.bookmarkModal.close();
          } else if (token.logicalName === 'up') {
            this.bookmarkModal.moveUp();
          } else if (token.logicalName === 'down') {
            this.bookmarkModal.moveDown();
          } else if (token.logicalName === 'enter') {
            // Jump to block in conversation
            const entry = this.bookmarkModal.getSelected();
            if (entry) {
              this.bus.emit('bookmark:jump', { key: entry.key });
            }
            this.bookmarkModal.close();
          } else if (token.logicalName === 'd') {
            // Remove selected bookmark
            const removed = this.bookmarkModal.removeSelected();
            if (removed) {
              this.bus.emit('bookmark:removed', { key: removed.key });
            }
            if (this.bookmarkModal.entries.length === 0) {
              this.bookmarkModal.close();
            }
          } else if (token.logicalName === 'o') {
            // Open saved file content (emits event, not directly opening a viewer here)
            const content = this.bookmarkModal.openSelectedFile();
            if (content) {
              const entry = this.bookmarkModal.getSelected();
              this.bus.emit('bookmark:open-file', { key: entry?.key ?? '', content });
            }
          }
        } else if (token.type === 'text') {
          if (token.value === 'd') {
            const removed = this.bookmarkModal.removeSelected();
            if (removed) {
              this.bus.emit('bookmark:removed', { key: removed.key });
            }
            if (this.bookmarkModal.entries.length === 0) {
              this.bookmarkModal.close();
            }
          } else if (token.value === 'o') {
            const content = this.bookmarkModal.openSelectedFile();
            if (content) {
              const entry = this.bookmarkModal.getSelected();
              this.bus.emit('bookmark:open-file', { key: entry?.key ?? '', content });
            }
          }
        }
        this.bus.emit('render:request');
        continue;
      }

      // --- Settings modal has focus: intercept all input ---
      if (this.settingsModal.active) {
        if (token.type === 'key') {
          if (token.logicalName === 'escape') {
            if (this.settingsModal.editingMode) {
              this.settingsModal.cancelEdit();
            } else {
              this.settingsModal.close();
            }
          } else if (token.logicalName === 'enter') {
            if (this.settingsModal.editingMode) {
              this.settingsModal.commitEdit();
            } else {
              this.settingsModal.activateSelected();
            }
          } else if (token.logicalName === 'up') {
            this.settingsModal.moveUp();
          } else if (token.logicalName === 'down') {
            this.settingsModal.moveDown();
          } else if (token.logicalName === 'tab') {
            this.settingsModal.nextCategory();
          } else if (token.logicalName === 'backspace') {
            if (this.settingsModal.editingMode) {
              this.settingsModal.editBackspace();
            }
          }
        } else if (token.type === 'text') {
          if (this.settingsModal.editingMode) {
            this.settingsModal.editChar(token.value);
          }
        }
        this.bus.emit('render:request');
        continue;
      }

      // --- Session picker has focus: intercept all input ---
      if (this.sessionPickerModal.active) {
        if (token.type === 'key') {
          if (token.logicalName === 'escape') {
            this.sessionPickerModal.close();
          } else if (token.logicalName === 'enter') {
            if (this.commandContext?.conversationManager) {
              this.sessionPickerModal.loadSelected(this.commandContext.conversationManager);
            }
          } else if (token.logicalName === 'up') {
            this.sessionPickerModal.moveUp();
          } else if (token.logicalName === 'down') {
            this.sessionPickerModal.moveDown();
          } else if (token.logicalName === 'd') {
            this.sessionPickerModal.deleteSelected();
          }
        } else if (token.type === 'text') {
          if (token.value === 'd') {
            this.sessionPickerModal.deleteSelected();
          }
        }
        this.bus.emit('render:request');
        continue;
      }

      // --- Profile picker has focus: intercept all input ---
      if (this.profilePickerModal.active) {
        if (token.type === 'key') {
          if (token.logicalName === 'escape') {
            this.profilePickerModal.close();
          } else if (token.logicalName === 'enter') {
            if (this.commandContext?.configManager) {
              this.profilePickerModal.loadSelected(this.commandContext.configManager);
            }
          } else if (token.logicalName === 'up') {
            this.profilePickerModal.moveUp();
          } else if (token.logicalName === 'down') {
            this.profilePickerModal.moveDown();
          } else if (token.logicalName === 'd') {
            this.profilePickerModal.deleteSelected();
          } else if (token.logicalName === 's') {
            // Save current config as a new profile (prompt via statusMessage flow)
            if (this.commandContext?.configManager) {
              const name = `profile-${Date.now()}`;
              this.profilePickerModal.saveCurrentAs(name, this.commandContext.configManager);
            }
          }
        } else if (token.type === 'text') {
          if (token.value === 'd') {
            this.profilePickerModal.deleteSelected();
          } else if (token.value === 's') {
            if (this.commandContext?.configManager) {
              const name = `profile-${Date.now()}`;
              this.profilePickerModal.saveCurrentAs(name, this.commandContext.configManager);
            }
          }
        }
        this.bus.emit('render:request');
        continue;
      }

      // --- Help overlay has focus: intercept all input (? or Esc closes) ---
      if (this.helpOverlayActive) {
        if (token.type === 'key') {
          if (token.logicalName === 'escape') {
            this.helpOverlayActive = false;
            this.helpScrollOffset = 0;
          } else if (token.logicalName === 'up') {
            this.helpScrollOffset = Math.max(0, this.helpScrollOffset - 1);
          } else if (token.logicalName === 'down') {
            this.helpScrollOffset = Math.min(this.helpScrollOffset + 1, 100);
          }
        } else if (token.type === 'text' && token.value === '?') {
          this.helpOverlayActive = false;
          this.helpScrollOffset = 0;
        }
        this.bus.emit('render:request');
        continue;
      }

      // --- Shortcuts overlay has focus ---
      if (this.shortcutsOverlayActive) {
        if (token.type === 'key') {
          if (token.logicalName === 'escape') {
            this.shortcutsOverlayActive = false;
            this.shortcutsScrollOffset = 0;
          } else if (token.logicalName === 'up') {
            this.shortcutsScrollOffset = Math.max(0, this.shortcutsScrollOffset - 1);
          } else if (token.logicalName === 'down') {
            this.shortcutsScrollOffset = Math.min(this.shortcutsScrollOffset + 1, 50);
          }
        }
        this.bus.emit('render:request');
        continue;
      }

      // --- History search mode: intercept all input ---
      if (this.historySearch.active) {
        if (token.type === 'text') {
          this.historySearch.appendChar(token.value);
        } else if (token.type === 'key') {
          if (token.logicalName === 'escape' || (token.ctrl && token.logicalName === 'g')) {
            this.prompt = this.historySearch.cancel();
            this.cursorPos = this.prompt.length;
          } else if (token.logicalName === 'return') {
            this.prompt = this.historySearch.accept();
            this.cursorPos = this.prompt.length;
          } else if (token.logicalName === 'backspace') {
            this.historySearch.deleteChar();
          } else if (token.ctrl && token.logicalName === 'r') {
            this.historySearch.stepOlder();
          } else if (token.ctrl && token.logicalName === 's') {
            this.historySearch.stepNewer();
          }
        }
        this.bus.emit('render:request');
        continue;
      }

      // --- Model picker has focus: intercept all input ---
      if (this.modelPicker.active) {
        if (token.type === 'key') {
          if (token.logicalName === 'escape') {
            // Escape clears query first; second Escape closes picker
            if (this.modelPicker.query.length > 0) {
              this.modelPicker.clearQuery();
            } else {
              this.modelPicker.close();
            }
          } else if (token.logicalName === 'backspace') {
            // Backspace removes last char from query (model or provider mode)
            if (this.modelPicker.mode === 'model' || this.modelPicker.mode === 'provider') {
              this.modelPicker.deleteChar();
            }
          } else if (token.logicalName === 'enter') {
            const mode = this.modelPicker.mode;
            const idx = this.modelPicker.selectedIndex;
            if (mode === 'model') {
              // Model chosen — use filtered list for selection
              const selected = this.modelPicker.getSelected();
              if (selected) {
                if (selected.reasoningEffort && selected.reasoningEffort.length > 0) {
                  this.modelPicker.showEffortPicker(selected, this.commandContext?.runtime.reasoningEffort ?? 'medium');
                } else {
                  // No reasoning support — complete immediately with current effort
                  this.bus.emit('model-picker:complete', { model: selected, effort: this.commandContext?.runtime.reasoningEffort ?? 'medium' });
                  this.modelPicker.close();
                }
              }
            } else if (mode === 'provider') {
              // Provider chosen — show that provider's models
              const selectedProvider = this.modelPicker.getFilteredProviders()[idx];
              if (selectedProvider) {
                const models = this.commandContext
                  ? this.commandContext.providerRegistry.getSelectableModels().filter(m => m.provider === selectedProvider)
                  : [];
                this.modelPicker.showModelsForProvider(models, selectedProvider);
              }
            } else if (mode === 'effort') {
              // Effort chosen — emit complete and close
              const model = this.modelPicker.pendingModel;
              const effort = this.modelPicker.effortLevels[idx];
              if (model && effort) {
                this.bus.emit('model-picker:complete', { model, effort });
              }
              this.modelPicker.close();
            }
          } else if (token.logicalName === 'up') {
            const maxVis = Math.max(5, this.getViewportHeight() - MODEL_PICKER_CHROME_LINES - 4);
            this.modelPicker.moveUp(maxVis);
          } else if (token.logicalName === 'down') {
            const maxVis = Math.max(5, this.getViewportHeight() - MODEL_PICKER_CHROME_LINES - 4);
            this.modelPicker.moveDown(maxVis);
          } else if (token.logicalName === 'tab' && this.modelPicker.mode === 'model') {
            // Tab cycles category filter: all → free → paid → subscription → all
            const cycle: import('./model-picker.ts').CategoryFilter[] = ['all', 'free', 'paid', 'subscription'];
            const cur = cycle.indexOf(this.modelPicker.categoryFilter);
            this.modelPicker.setCategoryFilter(cycle[(cur + 1) % cycle.length]!);
          }
          // All other keys ignored while model picker is active
        } else if (token.type === 'text' && (this.modelPicker.mode === 'model' || this.modelPicker.mode === 'provider')) {
          // Printable character — append to search query (all chars available)
          const ch = token.value;
          if (ch.length === 1 && ch >= ' ') {
            this.modelPicker.appendChar(ch);
          }
        }
        this.bus.emit('render:request');
        continue;
      }

      // --- Live-tail peek modal has focus: intercept all input ---
      if (this.liveTailModal.active) {
        if (token.type === 'key') {
          if (token.logicalName === 'escape') {
            this.liveTailModal.close();
            this.processModal.open();
          } else if (token.logicalName === 'up') {
            this.liveTailModal.scrollUp();
          } else if (token.logicalName === 'down') {
            this.liveTailModal.scrollDown();
          } else if (token.logicalName === 'k') {
            this.liveTailModal.killProcess();
            this.liveTailModal.close();
            this.processModal.open();
          }
        } else if (token.type === 'text') {
          if (token.value === 'k') {
            this.liveTailModal.killProcess();
            this.liveTailModal.close();
            this.processModal.open();
          }
        }
        this.bus.emit('render:request');
        continue;
      }

      // --- Agent detail modal has focus: intercept all input ---
      if (this.agentDetailModal.active) {
        if (token.type === 'key' && token.logicalName === 'escape') {
          this.agentDetailModal.close();
          this.processModal.open();
        }
        this.bus.emit('render:request');
        continue;
      }

      // --- Context inspector modal has focus: intercept all input ---
      if (this.contextInspectorModal.active) {
        if (token.type === 'key' && token.logicalName === 'escape') {
          this.contextInspectorModal.close();
        }
        this.bus.emit('render:request');
        continue;
      }

      // --- Process modal has focus: intercept all input ---
      if (this.processModal.active) {
        if (token.type === 'key') {
          if (token.logicalName === 'escape') {
            this.processModal.close();
            this.indicatorFocused = false;
          } else if (token.logicalName === 'up') {
            this.processModal.moveUp();
          } else if (token.logicalName === 'down') {
            this.processModal.moveDown();
          } else if (token.logicalName === 'enter') {
            const entry = this.processModal.getSelected();
            if (entry) {
              this.processModal.close();
              if (entry.type === 'agent') {
                this.agentDetailModal.open(entry.id);
              } else {
                this.liveTailModal.open(entry);
              }
            }
          }
        } else if (token.type === 'text') {
          if (token.value === 'k') {
            const killed = this.processModal.killSelected();
            if (killed) this.processModal.refresh();
          }
        }
        this.bus.emit('render:request');
        continue;
      }

      // --- File picker has focus: intercept all input ---
      if (this.filePicker.active) {
        if (token.type === 'text') {
          if (token.value === ' ' && this.filePicker.query === '') {
            // Space immediately after @ — treat @ as literal, close picker
            this.filePicker.close();
            // The @ is already in the prompt from when we opened the picker
          } else {
            this.filePicker.setQuery(this.filePicker.query + token.value);
          }
        } else if (token.type === 'key') {
          if (token.logicalName === 'escape') {
            // Close picker, keep @ in prompt (user can delete it manually)
            this.filePicker.close();
          } else if (token.logicalName === 'enter') {
            const selected = this.filePicker.getSelected();
            if (selected) {
              this.saveUndoState();
              const atPos = this.filePicker.insertPos;
              const injectMode = this.filePicker.injectMode;
              // queryLen: the @ (or !@) plus the typed query characters
              const prefixLen = injectMode ? 2 : 1; // '!@' = 2, '@' = 1
              const queryLen = this.filePicker.query.length + prefixLen;
              // Check if selected file is an image (only for normal @ mode)
              const ext = selected.slice(selected.lastIndexOf('.'));
              if (!injectMode && InputHandler.IMAGE_EXTENSIONS.some(e => e === ext.toLowerCase())) {
                // Image file — read and store in imageRegistry, insert marker
                try {
                  const resolvedPath = resolveAndValidatePath(selected);
                  const data = readFileSync(resolvedPath);
                  const base64 = data.toString('base64');
                  const mediaType = InputHandler.mediaTypeFromExt(ext);
                  const filename = selected.split('/').pop() ?? selected;
                  const id = `img${this.nextImageId++}`;
                  this.imageRegistry.set(id, { data: base64, mediaType });
                  const marker = `[IMAGE: ${id}, ${filename}, ${InputHandler.formatFileSize(data.length)}]`;
                  this.prompt = this.prompt.slice(0, atPos) + marker + ' ' + this.prompt.slice(atPos + queryLen);
                  this.cursorPos = atPos + marker.length + 1;
                } catch (err) {
                  logger.debug('file-picker: could not read image file', { err });
                  // Fallback: insert as text path if file read fails
                  this.prompt = this.prompt.slice(0, atPos) + '@' + selected + ' ' + this.prompt.slice(atPos + queryLen);
                  this.cursorPos = atPos + selected.length + 2;
                }
              } else if (injectMode) {
                // Inject mode — insert !@path marker (expanded at submit time)
                const marker = `!@${selected}`;
                this.prompt = this.prompt.slice(0, atPos) + marker + ' ' + this.prompt.slice(atPos + queryLen);
                this.cursorPos = atPos + marker.length + 1;
              } else {
                // Non-image file — insert @path with trailing space for multi-@ support
                this.prompt = this.prompt.slice(0, atPos) + '@' + selected + ' ' + this.prompt.slice(atPos + queryLen);
                this.cursorPos = atPos + selected.length + 2; // +1 for @, +1 for space
              }
              this.ensureInputCursorVisible();
            }
            this.filePicker.close();
          } else if (token.logicalName === 'up') {
            this.filePicker.moveUp();
          } else if (token.logicalName === 'down') {
            this.filePicker.moveDown();
          } else if (token.logicalName === 'backspace') {
            if (this.filePicker.query.length > 0) {
              this.filePicker.setQuery(this.filePicker.query.slice(0, -1));
            } else {
              // Backspace with empty query — remove the @ (and ! if inject mode) and close
              const removeCount = this.filePicker.injectMode ? 2 : 1;
              if (this.cursorPos >= removeCount) {
                this.prompt = this.prompt.slice(0, this.cursorPos - removeCount) + this.prompt.slice(this.cursorPos);
                this.cursorPos -= removeCount;
              }
              this.filePicker.close();
            }
          }
          // All other keys ignored while picker is active
        }
        this.bus.emit('render:request');
        continue;
      }

      // --- Block actions menu has focus: intercept all input ---
      if (this.blockActionsMenu.active) {
        if (token.type === 'key') {
          if (token.logicalName === 'escape') {
            this.blockActionsMenu.close();
          } else if (token.logicalName === 'up') {
            this.blockActionsMenu.moveUp();
          } else if (token.logicalName === 'down') {
            this.blockActionsMenu.moveDown();
          } else if (token.logicalName === 'enter') {
            const action = this.blockActionsMenu.getSelected();
            this.blockActionsMenu.close();
            if (action) this.executeBlockAction(action.id);
          } else if (token.logicalName === 'tab') {
            const action = this.blockActionsMenu.getActionForKey('Tab');
            this.blockActionsMenu.close();
            if (action) this.executeBlockAction(action.id);
          }
        } else if (token.type === 'text') {
          const action = this.blockActionsMenu.getActionForKey(token.value);
          this.blockActionsMenu.close();
          if (action) this.executeBlockAction(action.id);
        }
        this.bus.emit('render:request');
        continue;
      }

      // --- Tab: toggle keyboard focus between prompt and active panel ---
      if (
        token.type === 'key' &&
        token.logicalName === 'tab' &&
        !this.commandMode &&
        !this.searchManager.active &&
        !(this.autocomplete?.isActive)
      ) {
        const pm = getPanelManager();
        if (pm.isVisible() && pm.getAllOpen().length > 0) {
          if (this.panelFocused) {
            // Panel focused: toggle pane focus if split, else return to prompt
            const pmInner = getPanelManager();
            if (pmInner.isBottomPaneVisible()) {
              pmInner.togglePaneFocus();
            } else {
              this.panelFocused = false;
            }
          } else {
            // Try path completion first; only focus panel if no completion available
            if (!this.handlePathCompletion()) {
              this.panelFocused = true;
            }
          }
          this.bus.emit('render:request');
          continue;
        }
      }

      // --- Panel has keyboard focus: route keys to active panel ---
      if (this.panelFocused) {
        if (token.type === 'key') {
          if (token.logicalName === 'escape') {
            this.panelFocused = false;
            this.bus.emit('render:request');
            continue;
          }

          // Panel tab cycling still works even when panel focused
          const kb = getKeybindingsManager();
          if (kb.matches('panel-tab-next', token)) {
            this.cyclePanelTab('next');
            continue;
          }
          if (kb.matches('panel-tab-prev', token)) {
            this.cyclePanelTab('prev');
            continue;
          }
          // Route to active panel's handleInput
          const pm = getPanelManager();
          const activePanel = pm.getActive();
          if (activePanel?.handleInput) {
            const consumed = activePanel.handleInput(token.logicalName);
            if (consumed) {
              this.bus.emit('render:request');
              continue;
            }
          }
        }
        // , and . cycle panel tabs when panel is focused
        if (token.type === 'text' && (token.value === ',' || token.value === '.')) {
          this.cyclePanelTab(token.value === '.' ? 'next' : 'prev');
          this.bus.emit('render:request');
        }
        // Consume all tokens (text and unhandled keys) while panel is focused
        continue;
      }

      // --- Process indicator has focus: intercept keys ---
      if (this.indicatorFocused) {
        if (token.type === 'key') {
          if (token.logicalName === 'up' || token.logicalName === 'escape') {
            this.indicatorFocused = false;
            this.bus.emit('render:request');
            continue;
          } else if (token.logicalName === 'enter') {
            this.indicatorFocused = false;
            this.processModal.open();
            this.bus.emit('render:request');
            continue;
          } else if (token.ctrl) {
            // Ctrl-combos should work globally; unfocus and fall through
            this.indicatorFocused = false;
            // Don't continue -- let the key reach global shortcuts below
          } else {
            this.bus.emit('render:request');
            continue;
          }
        }
        // Text input: unfocus and fall through
        this.indicatorFocused = false;
      }

      if (token.type === 'text') {
        // '?' with empty prompt in normal mode: toggle help overlay
        if (token.value === '?' && this.prompt === '' && !this.commandMode) {
          // ? key opens the same selection modal as /help
          if (this.commandContext?.openSelection) {
            this.commandRegistry?.execute('help', [], this.commandContext!);
          }
          this.bus.emit('render:request');
          continue;
        }
        // 'a' shortcut removed — use Ctrl+A for diff apply instead
        // Reset history browsing when user types
        if (this.inputHistory?.isBrowsing) {
          this.inputHistory.resetPosition();
        }
        this.saveUndoState();
        // Reset path completion state on any new typing
        this.pathCompletions = [];
        this.pathCompletionIndex = -1;
        const text = this.registerPaste(token.value);
        this.prompt = this.prompt.slice(0, this.cursorPos) + text + this.prompt.slice(this.cursorPos);
        this.cursorPos += text.length;
        this.ensureInputCursorVisible();

        // Detect @ at start of word — open file picker
        // Also detect !@ sequence for inject mode
        if (token.value === '@' && !this.commandMode) {
          const charBefore = this.cursorPos >= 2 ? this.prompt[this.cursorPos - 2] : undefined;
          if (charBefore === '!') {
            // !@ sequence — open file picker in inject mode
            // insertPos points to the '!' character
            this.filePicker.open(this.cursorPos - 2, true);
          } else if (charBefore === undefined || charBefore === ' ' || charBefore === '\n') {
            // @ is at word start — open file picker
            this.filePicker.open(this.cursorPos - 1);
          }
        }

        // Detect slash-command mode: '/' typed into empty prompt
        if (this.prompt === '/' && this.commandRegistry) {
          this.commandMode = true;
          this.autocomplete?.update('');
          this.bus.emit('command:mode-enter');
        } else if (this.commandMode && this.commandRegistry) {
          // Update autocomplete with text after '/'
          const query = this.prompt.startsWith('/') ? this.prompt.slice(1) : '';
          const spaceIdx = query.indexOf(' ');
          // Only autocomplete while still typing the command name (no space yet)
          if (spaceIdx === -1) {
            this.autocomplete?.update(query);
          }
          this.bus.emit('command:autocomplete', { query });
        }
        continue;
      } else if (token.type === 'key') {
        // --- Global shortcuts (always active) ---
        const kb = getKeybindingsManager();
        if (kb.matches('copy-selection', token)) {
          this.handleCopy();
          continue;
        }
        if (kb.matches('clear-cancel', token)) {
          this.handleCtrlC();
          continue;
        }
        if (token.logicalName === 'escape') {
          this.handleEscape();
          continue;
        }
        // Ctrl+L: clear screen (full repaint)
        if (kb.matches('screen-clear', token)) {
          this.bus.emit('clear:screen');
          continue;
        }
        // Toggle panel sidebar
        if (kb.matches('panel-picker', token)) {
          if (this.commandContext?.openPanelPicker) {
            this.commandContext.openPanelPicker();
          }
          this.bus.emit('render:request');
          continue;
        }

        // Next panel tab
        if (kb.matches('panel-tab-next', token)) {
          this.cyclePanelTab('next');
          continue;
        }
        // Previous panel tab
        if (kb.matches('panel-tab-prev', token)) {
          this.cyclePanelTab('prev');
          continue;
        }
        // Reverse-i-search (history search)
        if (kb.matches('history-search', token)) {
          this.historySearch.open(this.prompt);
          this.bus.emit('render:request');
          continue;
        }
        // Toggle search mode
        if (kb.matches('search', token)) {
          if (this.searchManager.active) {
            this.searchManager.close();
            this.bus.emit('search:end');
          } else {
            this.searchManager.open();
            this.bus.emit('search:start');
          }
          this.bus.emit('render:request');
          continue;
        }
        // Copy nearest code/tool block to clipboard
        if (kb.matches('block-copy', token) && !this.commandMode) {
          this.handleBlockCopy();
          continue;
        }
        // Bookmark/unbookmark nearest block
        if (kb.matches('bookmark', token) && !this.commandMode) {
          this.handleBookmark();
          continue;
        }
        // Save nearest block content to file
        if (kb.matches('block-save', token) && !this.commandMode) {
          this.handleBlockSave();
          continue;
        }
        // Delete word backward
        if (kb.matches('delete-word', token)) {
          this.saveUndoState();
          let pos = this.cursorPos;
          // Skip trailing whitespace
          while (pos > 0 && this.prompt[pos - 1] === ' ') pos--;
          // Skip word characters
          while (pos > 0 && this.prompt[pos - 1] !== ' ') pos--;
          this.prompt = this.prompt.slice(0, pos) + this.prompt.slice(this.cursorPos);
          this.cursorPos = pos;
          this.ensureInputCursorVisible();
          continue;
        }
        // Apply nearest diff block if one is nearby, else move to start of line
        if (kb.matches('apply-diff-line-start', token)) {
          if (!this.commandMode && this.handleDiffApply()) {
            continue; // Diff found and apply initiated — skip cursor move
          }
          // In multiline, move to start of current wrapped line
          const info = this.getWrappedPromptInfo(this.contentWidth);
          if (info.wrappedLines.length > 1) {
            this.cursorPos = info.segments[info.cursorWrappedLine].rawStart;
          } else {
            this.cursorPos = 0;
          }
          this.ensureInputCursorVisible();
          continue;
        }
        // Navigate to next error when prompt is empty; else move to end of line
        if (kb.matches('next-error-line-end', token)) {
          if (this.prompt === '' && !this.commandMode) {
            const cm = this.conversationManager;
            if (cm) {
              const nextLine = cm.nextErrorLine(this.getScrollTop());
              if (nextLine >= 0) {
                this.scroll(nextLine - this.getScrollTop());
                this.bus.emit('render:request');
                continue;
              }
            }
          }
          // In multiline, move to end of current wrapped line
          const info = this.getWrappedPromptInfo(this.contentWidth);
          if (info.wrappedLines.length > 1) {
            const seg = info.segments[info.cursorWrappedLine];
            this.cursorPos = seg.rawStart + seg.length;
          } else {
            this.cursorPos = this.prompt.length;
          }
          this.ensureInputCursorVisible();
          continue;
        }
        // Kill to end of line
        if (kb.matches('kill-line', token)) {
          this.saveUndoState();
          this.prompt = this.prompt.slice(0, this.cursorPos);
          this.ensureInputCursorVisible();
          continue;
        }
        // Clear prompt line
        if (kb.matches('clear-prompt', token)) {
          this.saveUndoState();
          this.prompt = '';
          this.cursorPos = 0;
          if (this.commandMode) {
            this.commandMode = false;
            this.autocomplete?.reset();
            this.bus.emit('command:mode-exit');
          }
          continue;
        }
        // Undo last prompt edit
        if (kb.matches('undo', token)) {
          this.handleUndo();
          continue;
        }
        // Redo
        if (kb.matches('redo', token)) {
          this.handleRedo();
          continue;
        }
        // Paste (image first, then text)
        if (kb.matches('paste', token)) {
          this.handlePaste();
          continue;
        }
        // PageUp: scroll by viewport page
        if (token.logicalName === 'pageup') {
          this.scroll(-Math.max(1, vHeight - 2));
          continue;
        }
        // PageDown: scroll by viewport page
        if (token.logicalName === 'pagedown') {
          this.scroll(Math.max(1, vHeight - 2));
          continue;
        }

        // --- Command mode routing ---
        if (this.commandMode) {
          if (token.logicalName === 'escape') {
            // Exit command mode without executing
            this.prompt = '';
            this.cursorPos = 0;
            this.commandMode = false;
            this.autocomplete?.reset();
            this.bus.emit('command:mode-exit');
            continue;
          }
          if (token.logicalName === 'up') {
            this.autocomplete?.moveUp();
            continue;
          }
          if (token.logicalName === 'down') {
            this.autocomplete?.moveDown();
            continue;
          }
          if (token.logicalName === 'tab') {
            // Tab: autocomplete to selected command
            const selected = this.autocomplete?.getSelected();
            if (selected) {
              this.prompt = `/${selected.name} `;
              this.cursorPos = this.prompt.length;
              this.autocomplete?.reset();
            }
            continue;
          }
          if (token.logicalName === 'backspace') {
            if (this.cursorPos > 0) {
              this.prompt = this.prompt.slice(0, this.cursorPos - 1) + this.prompt.slice(this.cursorPos);
              this.cursorPos--;
            }
            if (this.prompt === '') {
              // Erased the '/' — exit command mode
              this.commandMode = false;
              this.autocomplete?.reset();
              this.bus.emit('command:mode-exit');
            } else {
              const query = this.prompt.startsWith('/') ? this.prompt.slice(1) : '';
              const spaceIdx = query.indexOf(' ');
              if (spaceIdx === -1) this.autocomplete?.update(query);
            }
            continue;
          }
          if (token.logicalName === 'enter') {
            // If autocomplete is active and has a selection, execute that command
            const selectedCmd = this.autocomplete?.isActive ? this.autocomplete.getSelected() : undefined;
            const raw = selectedCmd ? `/${selectedCmd.name}` : this.prompt.trim();
            this.prompt = '';
            this.cursorPos = 0;
            this.commandMode = false;
            this.autocomplete?.reset();
            this.bus.emit('command:mode-exit');

            if (raw.startsWith('/') && this.commandRegistry && this.commandContext) {
              const parts = raw.slice(1).trim().split(/\s+/);
              const name = parts[0];
              const args = parts.slice(1);
              const ctx = this.commandContext;
              this.commandRegistry.execute(name, args, ctx).then((handled) => {
                if (handled) {
                  this.bus.emit('command:execute', { name, args });
                } else {
                  // Fallback: check if this matches a skill trigger
                  const skillContent = loadSkillByTrigger('/' + name);
                  if (skillContent) {
                    this.bus.emit('input:submit', { text: skillContent });
                  } else {
                    this.conversationManager?.log(`Unknown command: /${name}. Type /help for available commands.`, { fg: '#ef4444' });
                    this.bus.emit('render:request');
                  }
                }
              });
            }
            continue;
          }
          continue; // in command mode: let text tokens handle character typing
        }

        // --- Normal mode ---
        // Tab: path completion if cursor is in a path-like token, else block toggle
        if (token.logicalName === 'tab' && !this.commandMode) {
          if (!this.handlePathCompletion()) {
            // No path token — reset any stale completion state and toggle block
            this.pathCompletions = [];
            this.pathCompletionIndex = -1;
            this.handleBlockToggle();
          }
          continue;
        }
        if (token.logicalName === 'enter') {
          if (token.shift) {
            this.prompt = this.prompt.slice(0, this.cursorPos) + '\n' + this.prompt.slice(this.cursorPos);
            this.cursorPos++;
            this.ensureInputCursorVisible();
          } else {
            const text = this.prompt.trim();
            // Enter with empty prompt in normal mode: open block actions menu
            if (!text && !this.commandMode) {
              const cm = this.conversationManager;
              if (cm) {
                const lineIndex = this.getScrollTop();
                const nearest = cm.findNearestBlock(lineIndex);
                if (nearest) {
                  this.blockActionsMenu.open(nearest);
                  this.bus.emit('render:request');
                  continue;
                }
              }
            }
            if (text === ':q') {
              this.exitApp();
              return;
            }
            if (text) {
              this.inputHistory?.add(text);
              this.prompt = '';
              this.cursorPos = 0;
              const expanded = this.expandPrompt(text);
              if (typeof expanded === 'string') {
                this.bus.emit('input:submit', { text: expanded });
              } else {
                // ContentPart[] — extract text portions for display/history
                const textOnly = expanded
                  .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                  .map(p => p.text)
                  .join('');
                this.bus.emit('input:submit', { text: textOnly, content: expanded });
              }
            }
          }
          continue;
        }

        if (token.logicalName === 'backspace') {
          if (this.cursorPos > 0) {
            this.saveUndoState();
            const marker = this.findMarkerAtPos(this.cursorPos);
            if (marker) {
              // Delete entire atomic marker and clean up registry
              const markerText = this.prompt.slice(marker.start, marker.end);
              this.cleanupMarkerRegistry(markerText);
              this.prompt = this.prompt.slice(0, marker.start) + this.prompt.slice(marker.end);
              this.cursorPos = marker.start;
            } else {
              this.prompt = this.prompt.slice(0, this.cursorPos - 1) + this.prompt.slice(this.cursorPos);
              this.cursorPos--;
            }
            this.ensureInputCursorVisible(this.contentWidth);
          }
        } else if (token.logicalName === 'delete') {
          if (this.cursorPos < this.prompt.length) {
            this.saveUndoState();
            const marker = this.findMarkerAtPos(this.cursorPos + 1);
            if (marker) {
              // Delete entire atomic marker and clean up registry
              const markerText = this.prompt.slice(marker.start, marker.end);
              this.cleanupMarkerRegistry(markerText);
              this.prompt = this.prompt.slice(0, marker.start) + this.prompt.slice(marker.end);
            } else {
              this.prompt = this.prompt.slice(0, this.cursorPos) + this.prompt.slice(this.cursorPos + 1);
            }
            this.ensureInputCursorVisible(this.contentWidth);
          }
        } else if (token.logicalName === 'left') {
          if (this.cursorPos > 0) {
            const marker = this.findMarkerAtPos(this.cursorPos);
            if (marker) {
              // Skip to before the marker
              this.cursorPos = marker.start;
            } else {
              this.cursorPos--;
            }
            this.ensureInputCursorVisible(this.contentWidth);
          }
        } else if (token.logicalName === 'right') {
          if (this.cursorPos < this.prompt.length) {
            const marker = this.findMarkerAtPos(this.cursorPos + 1);
            if (marker) {
              // Skip to after the marker
              this.cursorPos = marker.end;
            } else {
              this.cursorPos++;
            }
            this.ensureInputCursorVisible(this.contentWidth);
          }
        } else if (token.logicalName === 'home') {
          this.cursorPos = 0;
        } else if (token.logicalName === 'end') {
          this.cursorPos = this.prompt.length;
        } else if (token.logicalName === 'up') {
          // In multiline input: move cursor up. At boundary: no-op.
          // Only scroll viewport if input is single-line.
          if (!this.moveCursorVertical(-1)) {
            const info = this.getWrappedPromptInfo(this.contentWidth);
            if (info.wrappedLines.length <= 1) {
              // Single-line: try history recall first
              if (this.inputHistory) {
                const recalled = this.inputHistory.up(this.prompt);
                if (recalled !== null) {
                  this.prompt = recalled;
                  this.cursorPos = recalled.length;
                  this.ensureInputCursorVisible();
                  // Don't scroll viewport when recalling history
                } else {
                  this.scroll(-3);
                }
              } else {
                this.scroll(-3);
              }
            }
          }
        } else if (token.logicalName === 'down') {
          if (!this.moveCursorVertical(1)) {
            const info = this.getWrappedPromptInfo(this.contentWidth);
            if (info.wrappedLines.length <= 1) {
              // Single-line: try history recall first
              if (this.inputHistory?.isBrowsing) {
                const recalled = this.inputHistory.down();
                if (recalled !== null) {
                  this.prompt = recalled;
                  this.cursorPos = recalled.length;
                  this.ensureInputCursorVisible();
                } else {
                  this.indicatorFocused = true;
                }
              } else {
                this.indicatorFocused = true;
              }
            } else {
              // Multiline: cursor at bottom wrapped line, focus indicator
              this.indicatorFocused = true;
            }
          }
        } else if (token.logicalName === 'f2') {
          // F2: open the background process monitor
          this.indicatorFocused = false;  // clear focus if it was set
          this.processModal.open();
        }
      } else if (token.type === 'mouse') {
        const headerH = 2;
        const viewportRow = token.row - headerH;

        if (token.button === 64) this.scroll(-3);
        else if (token.button === 65) this.scroll(3);

        if (token.button === 1 && token.action === 'press') {
          this.handlePaste();
          continue;
        }

        if (token.button === 0 && token.action === 'press') {
          this.mouseDownRow = token.row;
          this.mouseDownCol = token.col;
          this.selection.startSelection(token.col, viewportRow, scrollTop, vHeight, lineCount);
        } else if (token.button === 32) {
          this.selection.extendSelection(token.col, viewportRow, scrollTop, vHeight, lineCount);
        } else if (token.action === 'release') {
          const moved = Math.abs(token.row - this.mouseDownRow) + Math.abs(token.col - this.mouseDownCol);
          if (moved <= 2 && this.conversationManager) {
            // Click (not drag) — toggle nearest block
            // Convert viewport row to absolute line index
            const offset = Math.max(0, vHeight - lineCount);
            const absoluteLine = scrollTop + (viewportRow - offset);
            if (absoluteLine >= 0) {
              const blockIdx = this.conversationManager.toggleCollapseAtLine(absoluteLine);
              if (blockIdx >= 0) {
                this.selection.clearSelection();
                this.bus.emit('block:toggle-collapse', { blockIndex: blockIdx });
                this.bus.emit('render:request');
                this.mouseDownRow = -1;
                this.mouseDownCol = -1;
                continue;
              }
            }
          }
          // Normal release — copy selection if any
          this.handleCopy();
          this.selection.endSelection();
          this.mouseDownRow = -1;
          this.mouseDownCol = -1;
        }
      }
    }
    this.bus.emit('render:request');
  }

  /**
   * handlePaste - Shared paste logic for Ctrl+V and middle-click.
   * Tries image clipboard first, falls back to text paste.
   */
  private handlePaste(): void {
    this.saveUndoState();
    const img = pasteImageFromClipboard();
    if (img) {
      const id = `img${this.nextImageId++}`;
      const sizeKB = Math.round(img.data.length * 3 / 4 / 1024);
      this.imageRegistry.set(id, img);
      const marker = `[IMAGE: ${id}, clipboard, ${sizeKB}KB]`;
      this.prompt = this.prompt.slice(0, this.cursorPos) + marker + this.prompt.slice(this.cursorPos);
      this.cursorPos += marker.length;
    } else {
      const raw = pasteFromClipboard();
      if (raw) {
        const text = this.registerPaste(raw);
        this.prompt = this.prompt.slice(0, this.cursorPos) + text + this.prompt.slice(this.cursorPos);
        this.cursorPos += text.length;
      }
    }
    this.ensureInputCursorVisible();
    this.bus.emit('render:request');
  }

  /** Content width for wrapping — set by main.ts via setContentWidth(). */
  private contentWidth = 76;

  /** Set the content width used for wrapping calculations. Call from main.ts. */
  public setContentWidth(w: number): void {
    this.contentWidth = w;
  }

  /**
   * Move cursor up or down by one WRAPPED line.
   * Uses the segment table to navigate visual lines, not raw \n lines.
   * Returns true if the cursor moved, false if at boundary.
   */
  private moveCursorVertical(direction: -1 | 1): boolean {
    const info = this.getWrappedPromptInfo(this.contentWidth);
    if (info.wrappedLines.length <= 1) return false;

    const targetLine = info.cursorWrappedLine + direction;
    if (targetLine < 0 || targetLine >= info.wrappedLines.length) return false;

    // Preserve column, clamped to target line length
    const col = Math.min(info.cursorCol, info.segments[targetLine].length);
    this.cursorPos = info.segments[targetLine].rawStart + col;

    this.ensureInputCursorVisible(this.contentWidth);
    return true;
  }

  /**
   * Ensure the cursor's wrapped line is visible within the input scroll window.
   */
  public ensureInputCursorVisible(contentWidth?: number): void {
    const info = this.getWrappedPromptInfo(contentWidth ?? this.contentWidth);
    const maxRows = InputHandler.MAX_INPUT_ROWS;
    if (info.cursorWrappedLine < this.inputScrollTop) {
      this.inputScrollTop = info.cursorWrappedLine;
    } else if (info.cursorWrappedLine >= this.inputScrollTop + maxRows) {
      this.inputScrollTop = info.cursorWrappedLine - maxRows + 1;
    }
  }

  /**
   * Get the number of visible prompt lines (capped at MAX_INPUT_ROWS),
   * accounting for word-wrapping within the content width.
   */
  public getVisiblePromptLineCount(contentWidth?: number): number {
    const info = this.getWrappedPromptInfo(contentWidth ?? 76);
    return Math.min(info.wrappedLines.length, InputHandler.MAX_INPUT_ROWS);
  }

  /**
   * Word-wrap the prompt and compute cursor display coordinates.
   * Returns wrapped lines, the cursor's position in wrapped coordinates,
   * and the visible slice respecting inputScrollTop.
   */
  public getWrappedPromptInfo(contentWidth: number): {
    wrappedLines: string[];
    segments: { rawStart: number; length: number }[];
    cursorWrappedLine: number;
    cursorCol: number;
    visibleLines: string[];
    visibleCursorLine: number;
    visibleCursorCol: number;
  } {
    const rawLines = this.prompt.split('\n');
    const wrappedLines: string[] = [];
    // Segment table: maps each wrapped line to its raw prompt offset
    const segments: { rawStart: number; length: number }[] = [];
    let rawOffset = 0;

    for (let r = 0; r < rawLines.length; r++) {
      const rawLine = rawLines[r];
      const wrapped = this.wordWrapLine(rawLine, contentWidth);
      let posInRaw = 0;

      for (let w = 0; w < wrapped.length; w++) {
        const seg = wrapped[w];
        segments.push({ rawStart: rawOffset + posInRaw, length: seg.length });
        wrappedLines.push(seg);
        posInRaw += seg.length;
        // New wrapper preserves all whitespace in segments — no consumed spaces to skip
      }

      rawOffset += rawLine.length;
      if (r < rawLines.length - 1) rawOffset++; // \n
    }

    // Map cursorPos to wrapped coordinates using the segment table
    let cursorWrappedLine = wrappedLines.length > 0 ? wrappedLines.length - 1 : 0;
    let cursorCol = 0;

    for (let s = 0; s < segments.length; s++) {
      const { rawStart, length } = segments[s];
      if (length === 0 && this.cursorPos === rawStart) {
        // Empty segment (blank line) — cursor lands here
        cursorWrappedLine = s;
        cursorCol = 0;
        break;
      } else if (this.cursorPos >= rawStart && this.cursorPos < rawStart + length) {
        // Cursor is strictly inside this segment
        cursorWrappedLine = s;
        cursorCol = this.cursorPos - rawStart;
        break;
      } else if (this.cursorPos === rawStart + length) {
        // Cursor is at the end of this segment
        if (s === segments.length - 1) {
          // Last segment — cursor at end
          cursorWrappedLine = s;
          cursorCol = length;
          break;
        }
        if (segments[s + 1].rawStart > this.cursorPos) {
          // Gap between segments. Check if it's a \n or a consumed space.
          const gapChar = this.prompt[this.cursorPos];
          if (gapChar === '\n') {
            // Newline gap: cursor should show at start of next line
            cursorWrappedLine = s + 1;
            cursorCol = 0;
            break;
          }
          // Consumed space from word-wrap: cursor at end of this line
          cursorWrappedLine = s;
          cursorCol = length;
          break;
        }
        // No gap — cursor is at start of next segment, let loop continue
      } else if (this.cursorPos < rawStart) {
        // Cursor is in a gap before this segment
        cursorWrappedLine = s;
        cursorCol = 0;
        break;
      }
    }

    const maxRows = InputHandler.MAX_INPUT_ROWS;
    const visibleLines = wrappedLines.slice(this.inputScrollTop, this.inputScrollTop + maxRows);
    const visibleCursorLine = cursorWrappedLine - this.inputScrollTop;
    const isVisible = visibleCursorLine >= 0 && visibleCursorLine < maxRows;

    return {
      wrappedLines,
      segments,
      cursorWrappedLine,
      cursorCol,
      visibleLines,
      visibleCursorLine: isVisible ? visibleCursorLine : -1,
      visibleCursorCol: isVisible ? cursorCol : 0,
    };
  }

  // ── Undo / Redo methods ─────────────────────────────────────────────────

  /**
   * saveUndoState - Snapshot current prompt + cursor onto the undo stack.
   * Clears the redo stack because a new edit invalidates future states.
   */
  private saveUndoState(): void {
    this.undoStack.push({ prompt: this.prompt, cursorPos: this.cursorPos });
    if (this.undoStack.length > InputHandler.MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }

  /**
   * handleUndo - Ctrl+Z: pop from undo stack, push current to redo stack.
   */
  private handleUndo(): void {
    if (this.undoStack.length === 0) return;
    this.redoStack.push({ prompt: this.prompt, cursorPos: this.cursorPos });
    if (this.redoStack.length > InputHandler.MAX_UNDO) this.redoStack.shift();
    const state = this.undoStack.pop()!;
    this.prompt = state.prompt;
    this.cursorPos = state.cursorPos;
    this.ensureInputCursorVisible();
  }

  /**
   * handleRedo - Ctrl+Shift+Z: pop from redo stack, push current to undo stack.
   */
  private handleRedo(): void {
    if (this.redoStack.length === 0) return;
    this.undoStack.push({ prompt: this.prompt, cursorPos: this.cursorPos });
    const state = this.redoStack.pop()!;
    this.prompt = state.prompt;
    this.cursorPos = state.cursorPos;
    this.ensureInputCursorVisible();
  }

  // ── Path completion methods ─────────────────────────────────────────────

  /**
   * findPathToken - Scan backward from cursor to find a path-like token.
   * Detects:
   *   - !@<partial>  (inject mode)
   *   - @<partial>   (normal file ref)
   *   - plain word containing '/'
   * Returns { start, prefix } or null if no path token found.
   */
  private findPathToken(): { start: number; prefix: string } | null {
    const pos = this.cursorPos;
    const p = this.prompt;

    // Scan backward to find the start of the current word (stop at whitespace/newline)
    let start = pos;
    while (start > 0 && p[start - 1] !== ' ' && p[start - 1] !== '\n') {
      start--;
    }

    const word = p.slice(start, pos);
    if (word.length === 0) return null;

    // Must look like a path: starts with @, !@, or contains '/'
    if (word.startsWith('!@') || word.startsWith('@') || word.includes('/')) {
      // Strip leading @ or !@ to get the raw partial path
      let prefix = word;
      if (prefix.startsWith('!@')) prefix = prefix.slice(2);
      else if (prefix.startsWith('@')) prefix = prefix.slice(1);
      return { start, prefix };
    }
    return null;
  }

  /**
   * handlePathCompletion - Tab on a path-like token: fuzzy-complete from filePicker.allFiles.
   * Repeated Tab cycles through matches.
   * Returns true if path completion was performed.
   */
  private handlePathCompletion(): boolean {
    const token = this.findPathToken();
    if (!token) return false;

    const { start, prefix } = token;
    const word = this.prompt.slice(start, this.cursorPos);

    // Determine whether this is a new completion or continuing a cycle.
    // After Tab replaces text, findPathToken returns the completed path as prefix,
    // so we cannot compare prefix content — use start position only.
    const isContinuing =
      this.pathCompletions.length > 0 &&
      this.pathCompletionStart === start;

    if (!isContinuing) {
      // Fresh completion: build the list
      const allFiles = this.filePicker.allFiles;
      if (allFiles.length === 0) return false; // Files not yet loaded

      const lowerPrefix = prefix.toLowerCase();
      const matches = allFiles
        .filter(f => f.toLowerCase().includes(lowerPrefix))
        .sort((a, b) => {
          // Prefer matches where the filename itself starts with the prefix
          const aFile = a.slice(a.lastIndexOf('/') + 1).toLowerCase();
          const bFile = b.slice(b.lastIndexOf('/') + 1).toLowerCase();
          const aScore = aFile.startsWith(lowerPrefix) ? 2 : a.toLowerCase().startsWith(lowerPrefix) ? 1 : 0;
          const bScore = bFile.startsWith(lowerPrefix) ? 2 : b.toLowerCase().startsWith(lowerPrefix) ? 1 : 0;
          return bScore - aScore;
        });

      if (matches.length === 0) return false;

      this.pathCompletions = matches;
      this.pathCompletionIndex = 0;
      this.pathCompletionPrefix = prefix;
      this.pathCompletionStart = start;
    } else {
      // Cycle to next match
      this.pathCompletionIndex = (this.pathCompletionIndex + 1) % this.pathCompletions.length;
    }

    const completed = this.pathCompletions[this.pathCompletionIndex];
    // Determine the prefix characters to keep (@ or !@)
    let leader = '';
    if (word.startsWith('!@')) leader = '!@';
    else if (word.startsWith('@')) leader = '@';

    const replacement = leader + completed;
    this.saveUndoState();
    this.prompt = this.prompt.slice(0, start) + replacement + this.prompt.slice(this.cursorPos);
    this.cursorPos = start + replacement.length;
    this.ensureInputCursorVisible();
    return true;
  }

  /**
   * Word-wrap a single line to fit within maxW columns.
   * Breaks at spaces; words wider than maxW are force-broken.
   */
  private cyclePanelTab(direction: 'next' | 'prev'): void {
    const pm = getPanelManager();
    if (pm.isVisible()) {
      if (direction === 'next') pm.nextPanel();
      else pm.prevPanel();
      this.bus.emit('render:request');
    }
  }

  private wordWrapLine(line: string, maxW: number): string[] {
    if (maxW <= 0) return [line];
    if (line.length === 0) return [''];

    // Character-by-character wrap that preserves ALL whitespace.
    // split(' ') drops leading/trailing/consecutive spaces, causing cursor drift.
    const result: string[] = [];
    let current = '';
    let wordBuf = '';

    const flushWord = () => {
      if (wordBuf.length === 0) return;
      if (current.length > 0 && current.length + wordBuf.length > maxW) {
        // Word doesn't fit on current line — push current, start new
        result.push(current);
        current = '';
      }
      // Force-break words wider than maxW
      while (wordBuf.length > maxW) {
        if (current.length > 0) {
          result.push(current);
          current = '';
        }
        result.push(wordBuf.slice(0, maxW));
        wordBuf = wordBuf.slice(maxW);
      }
      current += wordBuf;
      wordBuf = '';
    };

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === ' ') {
        flushWord();
        // Add the space to current line (spaces are never break points —
        // the break happens BEFORE the next word if it won't fit)
        if (current.length >= maxW) {
          result.push(current);
          current = ' ';
        } else {
          current += ' ';
        }
      } else {
        wordBuf += ch;
      }
    }
    flushWord();
    if (current.length > 0 || result.length === 0) {
      result.push(current);
    }
    return result;
  }
}
