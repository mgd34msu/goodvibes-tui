import { InputTokenizer } from '../core/tokenizer.ts';
import { SelectionManager } from './selection.ts';
import { copyToClipboard, pasteFromClipboard, pasteImageFromClipboard } from '../utils/clipboard.ts';
import type { EventBus } from '../core/event-bus.ts';
import type { InfiniteBuffer } from '../core/history.ts';
import type { CommandRegistry, CommandContext } from './command-registry.ts';
import { AutocompleteEngine } from './autocomplete.ts';
import { FilePickerModal } from './file-picker.ts';
import { InputHistory } from './input-history.ts';
import type { ConversationManager } from '../core/conversation.ts';
import type { PermissionCategory } from '../permissions/manager.ts';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolveAndValidatePath } from '../utils/path-safety.ts';
import type { ContentPart } from '../providers/interface.ts';
import { logger } from '../utils/logger.ts';

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

  private tokenizer = new InputTokenizer();
  private pasteRegistry = new Map<string, string>();
  private nextPasteId = 1;
  private lastCtrlCTime = 0;
  private commandRegistry: CommandRegistry | null = null;
  private commandContext: CommandContext | null = null;
  public autocomplete: AutocompleteEngine | null = null;
  public filePicker = new FilePickerModal();
  private inputHistory: InputHistory | null = null;
  private conversationManager: ConversationManager | null = null;
  /** Time of last [COPIED] block feedback, for brief display. */
  public lastBlockCopyTime = 0;

  /** Pasted images: maps marker IDs to base64 image data. */
  private imageRegistry = new Map<string, { data: string; mediaType: string }>();
  private nextImageId = 1;

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
    // If file picker is active, close it (don't clear input)
    if (this.filePicker.active) {
      this.filePicker.close();
      return;
    }
    if (this.prompt.length > 0) {
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

    for (const token of tokens) {
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
              const atPos = this.filePicker.insertPos;
              const queryLen = this.filePicker.query.length + 1; // +1 for the @
              // Check if selected file is an image
              const ext = selected.slice(selected.lastIndexOf('.'));
              if (InputHandler.IMAGE_EXTENSIONS.some(e => e === ext.toLowerCase())) {
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
                  this.prompt = this.prompt.slice(0, atPos) + marker + this.prompt.slice(atPos + queryLen);
                  this.cursorPos = atPos + marker.length;
                } catch (err) {
                  logger.debug('file-picker: could not read image file', { err });
                  // Fallback: insert as text path if file read fails
                  this.prompt = this.prompt.slice(0, atPos) + '@' + selected + this.prompt.slice(atPos + queryLen);
                  this.cursorPos = atPos + selected.length + 1;
                }
              } else {
                // Non-image file — insert @path as before
                this.prompt = this.prompt.slice(0, atPos) + '@' + selected + this.prompt.slice(atPos + queryLen);
                this.cursorPos = atPos + selected.length + 1; // +1 for @
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
              // Backspace with empty query — remove the @ and close
              if (this.cursorPos > 0) {
                this.prompt = this.prompt.slice(0, this.cursorPos - 1) + this.prompt.slice(this.cursorPos);
                this.cursorPos--;
              }
              this.filePicker.close();
            }
          }
          // All other keys ignored while picker is active
        }
        this.bus.emit('render:request');
        continue;
      }

      if (token.type === 'text') {
        // Reset history browsing when user types
        if (this.inputHistory?.isBrowsing) {
          this.inputHistory.resetPosition();
        }
        const text = this.registerPaste(token.value);
        this.prompt = this.prompt.slice(0, this.cursorPos) + text + this.prompt.slice(this.cursorPos);
        this.cursorPos += text.length;
        this.ensureInputCursorVisible();

        // Detect @ at start of word — open file picker
        if (token.value === '@' && !this.commandMode) {
          const charBefore = this.cursorPos >= 2 ? this.prompt[this.cursorPos - 2] : undefined;
          if (charBefore === undefined || charBefore === ' ' || charBefore === '\n') {
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
        if (token.logicalName === 'c' && token.ctrl && token.shift) {
          this.handleCopy();
          continue;
        }
        if (token.logicalName === 'c' && token.ctrl && !token.shift) {
          this.handleCtrlC();
          continue;
        }
        if (token.logicalName === 'escape') {
          this.handleEscape();
          continue;
        }
        // Ctrl+L: clear screen (re-render)
        if (token.logicalName === 'l' && token.ctrl) {
          this.bus.emit('render:request');
          continue;
        }
        // Ctrl+Y: copy nearest code/tool block to clipboard
        if (token.logicalName === 'y' && token.ctrl && !this.commandMode) {
          this.handleBlockCopy();
          continue;
        }
        // Ctrl+W: delete word backward
        if (token.logicalName === 'w' && token.ctrl) {
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
        // Ctrl+A: apply nearest diff block if one is nearby, else move to start of line
        if (token.logicalName === 'a' && token.ctrl) {
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
        // Ctrl+E: move to end of line
        if (token.logicalName === 'e' && token.ctrl) {
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
        // Ctrl+K: kill to end of line
        if (token.logicalName === 'k' && token.ctrl) {
          this.prompt = this.prompt.slice(0, this.cursorPos);
          this.ensureInputCursorVisible();
          continue;
        }
        // Ctrl+U: clear prompt line
        if (token.logicalName === 'u' && token.ctrl) {
          this.prompt = '';
          this.cursorPos = 0;
          if (this.commandMode) {
            this.commandMode = false;
            this.autocomplete?.reset();
            this.bus.emit('command:mode-exit');
          }
          continue;
        }
        // Ctrl+V: paste (image first, then text)
        if (token.logicalName === 'v' && token.ctrl) {
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
              this.autocomplete?.reset();
            }
            continue;
          }
          if (token.logicalName === 'backspace') {
            this.prompt = this.prompt.slice(0, -1);
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
            // Execute the command
            const raw = this.prompt.trim();
            this.prompt = '';
            this.cursorPos = 0;
            this.commandMode = false;
            this.autocomplete?.reset();
            this.bus.emit('command:mode-exit');

            if (raw.startsWith('/') && this.commandRegistry && this.commandContext) {
              const parts = raw.slice(1).trim().split(/\s+/);
              const name = parts[0];
              const args = parts.slice(1);
              void this.commandRegistry.execute(name, args, this.commandContext);
              this.bus.emit('command:execute', { name, args });
            }
            continue;
          }
          continue; // in command mode: let text tokens handle character typing
        }

        // --- Normal mode ---
        // Tab: toggle collapse of nearest block (when not in command mode)
        if (token.logicalName === 'tab' && !this.commandMode) {
          this.handleBlockToggle();
          continue;
        }
        if (token.logicalName === 'enter') {
          if (token.shift) {
            this.prompt = this.prompt.slice(0, this.cursorPos) + '\n' + this.prompt.slice(this.cursorPos);
            this.cursorPos++;
            this.ensureInputCursorVisible();
          } else {
            const text = this.prompt.trim();
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
                  this.scroll(3);
                }
              } else {
                this.scroll(3);
              }
            }
          }
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
          this.selection.startSelection(token.col, viewportRow, scrollTop, vHeight, lineCount);
        } else if (token.button === 32) {
          this.selection.extendSelection(token.col, viewportRow, scrollTop, vHeight, lineCount);
        } else if (token.action === 'release') {
          this.handleCopy();
          this.selection.endSelection();
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

  /**
   * Word-wrap a single line to fit within maxW columns.
   * Breaks at spaces; words wider than maxW are force-broken.
   */
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
