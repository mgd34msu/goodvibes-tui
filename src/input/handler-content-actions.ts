import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { copyToClipboard, pasteFromClipboard, pasteImageFromClipboard } from '../utils/clipboard.ts';
import type { InfiniteBuffer } from '../core/history.ts';
import type { ConversationManager } from '../core/conversation';
import type { PermissionCategory } from '@pellux/goodvibes-sdk/platform/permissions/manager';
import type { ContentPart } from '@pellux/goodvibes-sdk/platform/providers/interface';
import type { CommandContext } from './command-registry.ts';
import type { BookmarkManager } from '@pellux/goodvibes-sdk/platform/bookmarks/manager';
import { resolveAndValidatePath } from '@pellux/goodvibes-sdk/platform/utils/path-safety';
import { analyzePermissionRequest } from '@pellux/goodvibes-sdk/platform/permissions/analysis';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { SelectionManager } from './selection.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

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

  const lines = content.split('\n');
  if (lines.length <= 8) return { marker: content, nextPasteId: state.nextPasteId, nextImageId: state.nextImageId };
  const id = `p${state.nextPasteId++}`;
  state.pasteRegistry.set(id, content);
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

export function handleBlockCopy(
  conversationManager: ConversationManager | null,
  getScrollTop: () => number,
  requestRender: () => void,
  onCopied: () => void,
): void {
  if (!conversationManager) return;
  const lineIndex = getScrollTop();
  const content = conversationManager.getBlockContentAtLine(lineIndex);
  if (!content) return;
  copyToClipboard(content);
  onCopied();
  requestRender();
  setTimeout(() => requestRender(), 2005);
}

export function handleBookmark(
  conversationManager: ConversationManager | null,
  getScrollTop: () => number,
  requestRender: () => void,
  bookmarkManager: BookmarkManager,
): void {
  if (!conversationManager) return;
  const lineIndex = getScrollTop();
  const nearest = conversationManager.findNearestBlock(lineIndex);
  if (!nearest) {
    conversationManager.log('[Ctrl+B: No block found nearby]', { fg: '240' });
    requestRender();
    return;
  }
  const label = `${nearest.type}: ${nearest.rawContent.slice(0, 40).replace(/\n/g, ' ')}`;
  const added = bookmarkManager.toggle(nearest.collapseKey, label);
  const msg = added
    ? `[Bookmarked: ${nearest.collapseKey}]`
    : `[Bookmark removed: ${nearest.collapseKey}]`;
  conversationManager.log(msg, { fg: added ? '#22c55e' : '244' });
  requestRender();
}

export function handleBlockSave(
  conversationManager: ConversationManager | null,
  getScrollTop: () => number,
  requestRender: () => void,
  bookmarkManager: BookmarkManager,
): void {
  if (!conversationManager) return;
  const lineIndex = getScrollTop();
  const content = conversationManager.getBlockContentAtLine(lineIndex);
  if (!content) {
    conversationManager.log('[Ctrl+S: No block found nearby]', { fg: '240' });
    requestRender();
    return;
  }
  const nearest = conversationManager.findNearestBlock(lineIndex);
  const label = nearest?.type ?? 'block';
  try {
    const filePath = bookmarkManager.saveToFile(content, label);
    const homePath = process.env.HOME || process.env.USERPROFILE || '';
    const displayPath = homePath ? filePath.replace(homePath, '~') : filePath;
    conversationManager.log(`[Saved to: ${displayPath}]`, { fg: '#22c55e' });
  } catch (err) {
    const msg = summarizeError(err);
    conversationManager.log(`[Save failed: ${msg}]`, { fg: '#ef4444' });
  }
  requestRender();
}

export function handleBlockRerun(
  conversationManager: ConversationManager | null,
  getScrollTop: () => number,
  requestRender: () => void,
): void {
  if (!conversationManager) return;
  const lineIndex = getScrollTop();
  const nearest = conversationManager.findNearestBlock(lineIndex, 'tool');
  if (!nearest) {
    conversationManager.log('[Re-run: No tool block found nearby]', { fg: '240' });
    requestRender();
    return;
  }
  requestRender();
}

export function handleBlockToggle(
  conversationManager: ConversationManager | null,
  getScrollTop: () => number,
  requestRender: () => void,
): void {
  if (!conversationManager) return;
  const lineIndex = getScrollTop();
  const blockIdx = conversationManager.toggleCollapseAtLine(lineIndex);
  if (blockIdx >= 0) {
    requestRender();
  }
}

export function handleDiffApply(
  conversationManager: ConversationManager | null,
  getScrollTop: () => number,
  commandContext: CommandContext | undefined,
  requestRender: () => void,
  getCallId: () => string,
  category: PermissionCategory,
): boolean {
  if (!conversationManager) return false;
  const lineIndex = getScrollTop();
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
  cancelGeneration: (() => void) | undefined,
  exitApp: () => void,
  requestRender: () => void,
  lastCtrlCTime: number,
  setLastCtrlCTime: (value: number) => void,
  setShowExitNotice: (value: boolean) => void,
): void {
  if (prompt.length > 0) {
    saveUndoState();
    setPrompt('');
    setCursorPos(0);
    return;
  }
  cancelGeneration?.();
  const now = Date.now();
  if (now - lastCtrlCTime < 1000) {
    exitApp();
  } else {
    setLastCtrlCTime(now);
    setShowExitNotice(true);
    requestRender();
    setTimeout(() => {
      setShowExitNotice(false);
      requestRender();
    }, 1000);
  }
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
): { prompt: string; cursorPos: number; nextImageId: number; nextPasteId: number } {
  state.saveUndoState();
  const img = pasteImageFromClipboard();
  if (img) {
    const id = `img${state.nextImageId++}`;
    const sizeKB = Math.round(img.data.length * 3 / 4 / 1024);
    state.imageRegistry.set(id, img);
    const marker = `[IMAGE: ${id}, clipboard, ${sizeKB}KB]`;
    state.prompt = state.prompt.slice(0, state.cursorPos) + marker + state.prompt.slice(state.cursorPos);
    state.cursorPos += marker.length;
  } else {
    const raw = pasteFromClipboard();
    if (raw) {
      const { marker } = registerPaste(state, raw, projectRoot);
      state.prompt = state.prompt.slice(0, state.cursorPos) + marker + state.prompt.slice(state.cursorPos);
      state.cursorPos += marker.length;
    }
  }
  state.ensureInputCursorVisible();
  state.requestRender();
  return {
    prompt: state.prompt,
    cursorPos: state.cursorPos,
    nextImageId: state.nextImageId,
    nextPasteId: state.nextPasteId,
  };
}
