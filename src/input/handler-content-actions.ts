import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { copyToClipboard, pasteFromClipboard, pasteImageFromClipboard } from '../utils/clipboard.ts';
import type { InfiniteBuffer } from '../core/history.ts';
import type { BlockMeta, ConversationManager } from '../core/conversation';
import type { PermissionCategory } from '@pellux/goodvibes-sdk/platform/permissions';
import type { ContentPart } from '@pellux/goodvibes-sdk/platform/providers';
import type { CommandContext } from './command-registry.ts';
import type { BookmarkManager } from '@pellux/goodvibes-sdk/platform/bookmarks';
import { resolveAndValidatePath } from '@pellux/goodvibes-sdk/platform/utils';
import { analyzePermissionRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { SelectionManager } from './selection.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

export const MARKER_REGEX = /\[(TEXT|IMAGE): [^\]]+\]/g;

export const IMAGE_PREFIXES: { prefix: string; mediaType: string }[] = [
  { prefix: 'iVBORw0KGgo', mediaType: 'image/png' },
  { prefix: '/9j/', mediaType: 'image/jpeg' },
  { prefix: 'UklGR', mediaType: 'image/webp' },
  { prefix: 'R0lGOD', mediaType: 'image/gif' },
];

export const BINARY_IMAGE_MAGIC: {
  magic: number[];
  mediaType: string;
  extraCheck?: (b: Buffer) => boolean;
}[] = [
  { magic: [0x89, 0x50, 0x4E, 0x47], mediaType: 'image/png' },
  { magic: [0xFF, 0xD8, 0xFF], mediaType: 'image/jpeg' },
  { magic: [0x52, 0x49, 0x46, 0x46], mediaType: 'image/webp', extraCheck: (b: Buffer) => b.length > 11 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  { magic: [0x47, 0x49, 0x46], mediaType: 'image/gif' },
];

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function mediaTypeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return 'image/jpeg';
  }
}

export type PasteRegistryState = {
  pasteRegistry: Map<string, string>;
  nextPasteId: number;
  imageRegistry: Map<string, { data: string; mediaType: string }>;
  nextImageId: number;
};

export type ClipboardPasteKind = 'image' | 'text' | 'none';

export interface ClipboardPasteResult {
  prompt: string;
  cursorPos: number;
  nextImageId: number;
  nextPasteId: number;
  pasted: boolean;
  kind: ClipboardPasteKind;
  marker?: string;
}

export interface ClipboardPasteSource {
  pasteImageFromClipboard: typeof pasteImageFromClipboard;
  pasteFromClipboard: typeof pasteFromClipboard;
}

export function registerPaste(
  state: PasteRegistryState,
  content: string,
  projectRoot: string,
): { marker: string; nextPasteId: number; nextImageId: number } {
  const bytes = Buffer.from(content, 'binary');
  if (bytes.length > 100) {
    for (const { magic, mediaType, extraCheck } of BINARY_IMAGE_MAGIC) {
      if (magic.every((b, i) => bytes[i] === b) && (!extraCheck || extraCheck(bytes))) {
        const id = `img${state.nextImageId++}`;
        const base64 = bytes.toString('base64');
        const sizeKB = Math.round(bytes.length / 1024);
        state.imageRegistry.set(id, { data: base64, mediaType });
        return { marker: `[IMAGE: ${id}, clipboard, ${sizeKB}KB]`, nextPasteId: state.nextPasteId, nextImageId: state.nextImageId };
      }
    }
  }

  const trimmed = content.trim();
  if (trimmed.length > 100) {
    for (const { prefix, mediaType } of IMAGE_PREFIXES) {
      if (trimmed.startsWith(prefix)) {
        const id = `img${state.nextImageId++}`;
        const sizeKB = Math.round(trimmed.length * 3 / 4 / 1024);
        state.imageRegistry.set(id, { data: trimmed, mediaType });
        return { marker: `[IMAGE: ${id}, clipboard, ${sizeKB}KB]`, nextPasteId: state.nextPasteId, nextImageId: state.nextImageId };
      }
    }
  }

  if (IMAGE_EXTENSIONS.some(ext => trimmed.toLowerCase().endsWith(ext))) {
    try {
      const resolvedPath = resolveAndValidatePath(trimmed, projectRoot);
      if (existsSync(resolvedPath)) {
        const data = readFileSync(resolvedPath);
        const base64 = data.toString('base64');
        const ext = trimmed.slice(trimmed.lastIndexOf('.'));
        const mediaType = mediaTypeFromExt(ext);
        const filename = trimmed.split('/').pop() ?? 'image';
        const id = `img${state.nextImageId++}`;
        state.imageRegistry.set(id, { data: base64, mediaType });
        return { marker: `[IMAGE: ${id}, ${filename}, ${formatFileSize(data.length)}]`, nextPasteId: state.nextPasteId, nextImageId: state.nextImageId };
      }
    } catch (err) {
      logger.debug('registerPaste: could not read image file path', { err });
    }
  }

  // Terminals transmit the line breaks inside a bracketed paste as \r (the
  // byte Enter sends), and external clipboards can carry \r\n. Normalize to
  // \n only here in the text branch — the image sniffing above must see the
  // raw bytes (PNG's magic sequence itself contains \r\n).
  const text = content.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (lines.length <= 8) return { marker: text, nextPasteId: state.nextPasteId, nextImageId: state.nextImageId };
  const id = `p${state.nextPasteId++}`;
  state.pasteRegistry.set(id, text);
  return { marker: `[TEXT: ${id}, ${lines.length} lines]`, nextPasteId: state.nextPasteId, nextImageId: state.nextImageId };
}

export function expandPrompt(
  pasteRegistry: Map<string, string>,
  imageRegistry: Map<string, { data: string; mediaType: string }>,
  text: string,
  projectRoot: string,
): string | ContentPart[] {
  const foundPasteIds = new Set<string>();
  const markerRegex = /\[TEXT: (p\d+), (\d+) lines\]/g;

  const replacements: { marker: string; index: number; content: string }[] = [];
  let match;
  while ((match = markerRegex.exec(text)) !== null) {
    const id = match[1];
    const content = pasteRegistry.get(id);
    if (content) {
      replacements.push({ marker: match[0], index: match.index, content });
      foundPasteIds.add(id);
    }
  }

  let expanded = text;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { marker, index, content } = replacements[i]!;
    expanded = expanded.slice(0, index) + content + expanded.slice(index + marker.length);
  }

  for (const id of pasteRegistry.keys()) {
    if (!foundPasteIds.has(id)) {
      pasteRegistry.delete(id);
    }
  }

  const injectRegex = /(?:^|(?<=\s))!@(\S+)/g;
  let injectMatch;
  while ((injectMatch = injectRegex.exec(expanded)) !== null) {
    const filePath = injectMatch[1];
    try {
      const resolvedPath = resolveAndValidatePath(filePath, projectRoot);
      const content = readFileSync(resolvedPath, 'utf-8');
      expanded = expanded.slice(0, injectMatch.index) + content + expanded.slice(injectMatch.index + injectMatch[0].length);
      injectRegex.lastIndex = injectMatch.index + content.length;
    } catch (err) {
      logger.debug('expandPrompt: failed to read injected file', { path: filePath, error: summarizeError(err) });
    }
  }

  const imageMarkerRegex = /\[IMAGE: (img\d+), [^\]]+\]/g;
  const imageMarkers: { marker: string; index: number; id: string }[] = [];
  let imgMatch;
  while ((imgMatch = imageMarkerRegex.exec(expanded)) !== null) {
    imageMarkers.push({ marker: imgMatch[0], index: imgMatch.index, id: imgMatch[1] });
  }

  if (imageMarkers.length === 0) {
    imageRegistry.clear();
    return expanded;
  }

  const parts: ContentPart[] = [];
  let lastIndex = 0;
  const usedIds = new Set<string>();

  for (const { marker, index, id } of imageMarkers) {
    if (index > lastIndex) {
      const textSegment = expanded.slice(lastIndex, index);
      if (textSegment) parts.push({ type: 'text', text: textSegment });
    }
    const img = imageRegistry.get(id);
    if (img) {
      parts.push({ type: 'image', data: img.data, mediaType: img.mediaType });
      usedIds.add(id);
    }
    lastIndex = index + marker.length;
  }

  if (lastIndex < expanded.length) {
    const textSegment = expanded.slice(lastIndex);
    if (textSegment) parts.push({ type: 'text', text: textSegment });
  }

  for (const id of imageRegistry.keys()) {
    if (!usedIds.has(id)) imageRegistry.delete(id);
  }

  return parts;
}

export function cleanupMarkerRegistry(
  imageRegistry: Map<string, { data: string; mediaType: string }>,
  markerText: string,
): void {
  const match = /^\[IMAGE: (img\d+),/.exec(markerText);
  if (match) {
    imageRegistry.delete(match[1]!);
  }
}

export function findMarkerAtPos(prompt: string, pos: number): { start: number; end: number } | null {
  const markerRegex = new RegExp(MARKER_REGEX.source, 'g');
  let m;
  while ((m = markerRegex.exec(prompt)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (pos > start && pos <= end) {
      return { start, end };
    }
  }
  return null;
}

/**
 * describeBlockForReceipt - Honest, human-readable name for a block, used by
 * every anchor-based action's receipt (Ctrl+Y/B/S/A, Tab, block-actions menu)
 * so the transcript always says exactly what was acted on — never just an
 * internal collapseKey or a bare "done".
 */
export function describeBlockForReceipt(block: BlockMeta): string {
  const lineText = `${block.lineCount} line${block.lineCount === 1 ? '' : 's'}`;
  switch (block.type) {
    case 'tool':
      return block.toolName ? `tool result: ${block.toolName} (${lineText})` : `tool result (${lineText})`;
    case 'tool_group':
      return `tool result group (${lineText})`;
    case 'diff':
      return block.filePath ? `diff: ${block.filePath} (${lineText})` : `diff (${lineText})`;
    case 'code':
      return `code block (${lineText})`;
    case 'thinking':
      return `thinking (${lineText})`;
    default:
      return `${block.type} (${lineText})`;
  }
}

export function handleCopy(
  selection: SelectionManager,
  getHistory: () => InfiniteBuffer,
  requestRender: () => void,
  onCopied: () => void,
): void {
  if (!selection.hasSelection()) return;
  copyToClipboard(selection.getSelectedText(getHistory()));
  onCopied();
  requestRender();
  setTimeout(() => requestRender(), 2005);
}

/**
 * handleBlockCopy - Ctrl+Y: copy the content of the block the user is
 * actually looking at. `getAnchorLine` resolves to the viewport's
 * bottom-most visible line (see getViewportBottomLine in
 * conversation-layout.ts), not the raw scroll position — the top of the
 * viewport is off-screen-above once the transcript is longer than one page.
 */
export function handleBlockCopy(
  conversationManager: ConversationManager | null,
  getAnchorLine: () => number,
  requestRender: () => void,
  onCopied: () => void,
): void {
  if (!conversationManager) return;
  const lineIndex = getAnchorLine();
  const nearest = conversationManager.findNearestBlock(lineIndex);
  if (!nearest) {
    conversationManager.log('[Ctrl+Y: No block found nearby]', { fg: '240' });
    requestRender();
    return;
  }
  copyToClipboard(nearest.rawContent);
  onCopied();
  // An explicit action on this block permanently exempts it from the
  // search-close auto-re-collapse (see ConversationManager.noteUserTouch) —
  // copying content the user just had search reveal is a deliberate choice
  // to keep it visible, not an accident of typing a query.
  conversationManager.searchExpansion.noteUserTouch(nearest.collapseKey);
  conversationManager.log(`[Copied ${describeBlockForReceipt(nearest)}]`, { fg: '#22c55e' });
  requestRender();
  setTimeout(() => requestRender(), 2005);
}

export function handleBookmark(
  conversationManager: ConversationManager | null,
  getAnchorLine: () => number,
  requestRender: () => void,
  bookmarkManager: BookmarkManager,
): void {
  if (!conversationManager) return;
  const lineIndex = getAnchorLine();
  const nearest = conversationManager.findNearestBlock(lineIndex);
  if (!nearest) {
    conversationManager.log('[Ctrl+B: No block found nearby]', { fg: '240' });
    requestRender();
    return;
  }
  const label = `${nearest.type}: ${nearest.rawContent.slice(0, 40).replace(/\n/g, ' ')}`;
  const added = bookmarkManager.toggle(nearest.collapseKey, label);
  // See handleBlockCopy's note — bookmarking is an explicit block action too.
  conversationManager.searchExpansion.noteUserTouch(nearest.collapseKey);
  const target = describeBlockForReceipt(nearest);
  const msg = added
    ? `[Bookmarked: ${target}]`
    : `[Bookmark removed: ${target}]`;
  conversationManager.log(msg, { fg: added ? '#22c55e' : '244' });
  requestRender();
}

export function handleBlockSave(
  conversationManager: ConversationManager | null,
  getAnchorLine: () => number,
  requestRender: () => void,
  bookmarkManager: BookmarkManager,
): void {
  if (!conversationManager) return;
  const lineIndex = getAnchorLine();
  const nearest = conversationManager.findNearestBlock(lineIndex);
  if (!nearest) {
    conversationManager.log('[Ctrl+S: No block found nearby]', { fg: '240' });
    requestRender();
    return;
  }
  // See handleBlockCopy's note — saving to a file is an explicit block action too.
  conversationManager.searchExpansion.noteUserTouch(nearest.collapseKey);
  const target = describeBlockForReceipt(nearest);
  try {
    const filePath = bookmarkManager.saveToFile(nearest.rawContent, nearest.type);
    const homePath = process.env.HOME || process.env.USERPROFILE || '';
    const displayPath = homePath ? filePath.replace(homePath, '~') : filePath;
    conversationManager.log(`[Saved ${target} to: ${displayPath}]`, { fg: '#22c55e' });
  } catch (err) {
    const msg = summarizeError(err);
    conversationManager.log(`[Save failed (${target}): ${msg}]`, { fg: '#ef4444' });
  }
  requestRender();
}

export function handleBlockToggle(
  conversationManager: ConversationManager | null,
  getAnchorLine: () => number,
  requestRender: () => void,
): void {
  if (!conversationManager) return;
  const lineIndex = getAnchorLine();
  const nearest = conversationManager.findNearestBlock(lineIndex);
  if (!nearest) return;
  const wasCollapsed = conversationManager.isCollapsed(nearest.blockIndex);
  const blockIdx = conversationManager.toggleCollapseAtLine(lineIndex);
  if (blockIdx >= 0) {
    conversationManager.log(`[${wasCollapsed ? 'Expanded' : 'Collapsed'} ${describeBlockForReceipt(nearest)}]`, { fg: '244' });
    requestRender();
  }
}

export function handleDiffApply(
  conversationManager: ConversationManager | null,
  getAnchorLine: () => number,
  commandContext: CommandContext | undefined,
  requestRender: () => void,
  getCallId: () => string,
  category: PermissionCategory,
): boolean {
  if (!conversationManager) return false;
  const lineIndex = getAnchorLine();
  const diff = conversationManager.getDiffAtLine(lineIndex);
  if (!diff || !diff.filePath) return false;
  const projectRoot = commandContext?.workspace.shellPaths?.workingDirectory
    ?? commandContext?.platform.configManager.getWorkingDirectory();

  commandContext?.requestPermission?.({
    callId: getCallId(),
    tool: 'edit',
    args: { path: diff.filePath, original: diff.original, updated: diff.updated },
    category,
    analysis: analyzePermissionRequest(
      'edit',
      { path: diff.filePath, original: diff.original, updated: diff.updated },
      category,
    ),
  }).then(({ approved }) => {
    if (!approved) return;
    if (!projectRoot) {
      conversationManager.log('[Diff apply failed: missing working directory]', { fg: '#ef4444' });
      return;
    }
    let resolvedPath: string;
    try {
      resolvedPath = resolveAndValidatePath(diff.filePath!, projectRoot);
    } catch (err) {
      conversationManager.log(`[Diff apply failed: ${err instanceof Error ? err.message : err}]`, { fg: '#ef4444' });
      return;
    }
    try {
      const content = readFileSync(resolvedPath, 'utf-8');
      if (diff.original && content.includes(diff.original)) {
        const occurrenceCount = content.split(diff.original).length - 1;
        if (occurrenceCount > 1) {
          conversationManager.log(`[Diff apply failed: pattern found ${occurrenceCount} times in ${diff.filePath} - ambiguous]`, { fg: '#ef4444' });
        } else {
          const newContent = content.replace(diff.original, diff.updated);
          writeFileSync(resolvedPath, newContent, 'utf-8');
          conversationManager.log(`[Applied diff to ${diff.filePath}]`, { fg: '#22c55e' });
        }
      } else {
        conversationManager.log(`[Diff apply failed: original text not found in ${diff.filePath}]`, { fg: '#ef4444' });
      }
    } catch (err) {
      const msg = summarizeError(err);
      conversationManager.log(`[Diff apply error: ${msg}]`, { fg: '#ef4444' });
    }
    requestRender();
  }).catch((err) => {
    conversationManager.log(`[Diff apply error: ${summarizeError(err)}]`, { fg: '#ef4444' });
    requestRender();
  });
  return true;
}

export function handleCtrlC(
  prompt: string,
  saveUndoState: () => void,
  setPrompt: (value: string) => void,
  setCursorPos: (value: number) => void,
  cancelGeneration: (() => boolean | void) | undefined,
  exitApp: () => void,
  requestRender: () => void,
  lastCtrlCTime: number,
  setLastCtrlCTime: (value: number) => void,
  setShowExitNotice: (value: boolean) => void,
  lastCtrlCTimeoutId: ReturnType<typeof setTimeout> | null,
  setLastCtrlCTimeoutId: (value: ReturnType<typeof setTimeout> | null) => void,
): void {
  if (prompt.length > 0) {
    saveUndoState();
    setPrompt('');
    setCursorPos(0);
    return;
  }
  // Stopping in-flight speech / aborting the turn must never prevent the quit
  // double-press window from advancing. A throw from the async TTS-stop path
  // (e.g. killing the audio subprocess) would otherwise swallow this press and
  // strand the user unable to quit while TTS is speaking. Decouple the two: the
  // press below is recorded no matter how speech-stop fares. (item 6b.)
  let stoppedSpeech = false;
  try {
    stoppedSpeech = cancelGeneration?.() === true;
  } catch {
    // Non-fatal to the exit chord; the quit-window bookkeeping still runs.
  }
  // A press that silenced LIVE speech is consumed by that job (an earlier replay
  // fix) — symmetric with the prompt-clearing press above. The quit chord
  // ("Ctrl+C x2") starts from a quiet state; turn-aborts still count toward
  // the double-press.
  if (stoppedSpeech) return;
  const now = Date.now();
  // Clear any hide-timer pending from a prior press before deciding this
  // one's outcome, whichever branch below runs. Without this, a hide-timer
  // scheduled by an earlier press could still fire after a newer notice
  // window opened, or after exitApp() was just called (if exitApp isn't
  // synchronous) — flipping showExitNotice/requestRender during a shutdown
  // the user already believes is in progress.
  if (lastCtrlCTimeoutId !== null) {
    clearTimeout(lastCtrlCTimeoutId);
    setLastCtrlCTimeoutId(null);
  }
  if (now - lastCtrlCTime < 1000) {
    exitApp();
    return;
  }
  setLastCtrlCTime(now);
  setShowExitNotice(true);
  requestRender();
  const timeoutId = setTimeout(() => {
    setShowExitNotice(false);
    setLastCtrlCTimeoutId(null);
    requestRender();
  }, 1000);
  setLastCtrlCTimeoutId(timeoutId);
}

export function handleClipboardPaste(
  state: PasteRegistryState & {
    prompt: string;
    cursorPos: number;
    saveUndoState: () => void;
    ensureInputCursorVisible: () => void;
    requestRender: () => void;
  },
  projectRoot: string,
  clipboard: ClipboardPasteSource = { pasteImageFromClipboard, pasteFromClipboard },
): ClipboardPasteResult {
  const img = clipboard.pasteImageFromClipboard();
  let pasted = false;
  let kind: ClipboardPasteKind = 'none';
  let insertedMarker: string | undefined;

  if (img) {
    state.saveUndoState();
    const id = `img${state.nextImageId++}`;
    const sizeKB = Math.round(img.data.length * 3 / 4 / 1024);
    state.imageRegistry.set(id, img);
    const marker = `[IMAGE: ${id}, clipboard, ${sizeKB}KB]`;
    state.prompt = state.prompt.slice(0, state.cursorPos) + marker + state.prompt.slice(state.cursorPos);
    state.cursorPos += marker.length;
    pasted = true;
    kind = 'image';
    insertedMarker = marker;
  } else {
    const raw = clipboard.pasteFromClipboard();
    if (raw) {
      state.saveUndoState();
      const { marker } = registerPaste(state, raw, projectRoot);
      state.prompt = state.prompt.slice(0, state.cursorPos) + marker + state.prompt.slice(state.cursorPos);
      state.cursorPos += marker.length;
      pasted = true;
      kind = marker.startsWith('[IMAGE:') ? 'image' : 'text';
      insertedMarker = marker;
    }
  }
  state.ensureInputCursorVisible();
  state.requestRender();
  return {
    prompt: state.prompt,
    cursorPos: state.cursorPos,
    nextImageId: state.nextImageId,
    nextPasteId: state.nextPasteId,
    pasted,
    kind,
    marker: insertedMarker,
  };
}
