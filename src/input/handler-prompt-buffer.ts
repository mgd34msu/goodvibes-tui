type WrappedSegment = { rawStart: number; length: number };

export type WrappedPromptInfo = {
  wrappedLines: string[];
  segments: WrappedSegment[];
  cursorWrappedLine: number;
  cursorCol: number;
  visibleLines: string[];
  visibleCursorLine: number;
  visibleCursorCol: number;
};

export type UndoState = { prompt: string; cursorPos: number };

// ---------------------------------------------------------------------------
// Undo coalescing support
// ---------------------------------------------------------------------------

/** Milliseconds within which consecutive text insertions are merged into one
 *  undo group. Cursor moves or kill/yank operations always break the group. */
export const UNDO_COALESCE_MS = 500;

export type EditKind = 'text' | 'kill' | 'yank' | 'other';

/**
 * shouldCoalesceUndo — returns true when the new edit should be merged into
 * the most recent undo group rather than creating a new snapshot.
 *
 * Coalesces only when:
 *   - Both the last edit and the incoming edit are plain text insertions
 *   - The time delta is within UNDO_COALESCE_MS
 */
export function shouldCoalesceUndo(
  lastEditKind: EditKind,
  incomingKind: EditKind,
  lastEditMs: number,
  nowMs: number,
): boolean {
  if (lastEditKind !== 'text' || incomingKind !== 'text') return false;
  return (nowMs - lastEditMs) < UNDO_COALESCE_MS;
}

export function wordWrapLine(line: string, maxW: number): string[] {
  if (maxW <= 0) return [line];
  if (line.length === 0) return [''];

  const result: string[] = [];
  let current = '';
  let wordBuf = '';

  const flushWord = () => {
    if (wordBuf.length === 0) return;
    if (current.length > 0 && current.length + wordBuf.length > maxW) {
      result.push(current);
      current = '';
    }
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
    const ch = line[i]!;
    if (ch === ' ') {
      flushWord();
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

export function getWrappedPromptInfo(
  prompt: string,
  cursorPos: number,
  inputScrollTop: number,
  contentWidth: number,
  maxRows: number,
): WrappedPromptInfo {
  const rawLines = prompt.split('\n');
  const wrappedLines: string[] = [];
  const segments: WrappedSegment[] = [];
  let rawOffset = 0;

  for (let r = 0; r < rawLines.length; r++) {
    const rawLine = rawLines[r]!;
    const wrapped = wordWrapLine(rawLine, contentWidth);
    let posInRaw = 0;

    for (let w = 0; w < wrapped.length; w++) {
      const seg = wrapped[w]!;
      segments.push({ rawStart: rawOffset + posInRaw, length: seg.length });
      wrappedLines.push(seg);
      posInRaw += seg.length;
    }

    rawOffset += rawLine.length;
    if (r < rawLines.length - 1) rawOffset++;
  }

  let cursorWrappedLine = wrappedLines.length > 0 ? wrappedLines.length - 1 : 0;
  let cursorCol = 0;

  for (let s = 0; s < segments.length; s++) {
    const { rawStart, length } = segments[s]!;
    if (length === 0 && cursorPos === rawStart) {
      cursorWrappedLine = s;
      cursorCol = 0;
      break;
    } else if (cursorPos >= rawStart && cursorPos < rawStart + length) {
      cursorWrappedLine = s;
      cursorCol = cursorPos - rawStart;
      break;
    } else if (cursorPos === rawStart + length) {
      if (s === segments.length - 1) {
        cursorWrappedLine = s;
        cursorCol = length;
        break;
      }
      if (segments[s + 1]!.rawStart > cursorPos) {
        const gapChar = prompt[cursorPos];
        if (gapChar === '\n') {
          cursorWrappedLine = s + 1;
          cursorCol = 0;
          break;
        }
        cursorWrappedLine = s;
        cursorCol = length;
        break;
      }
    } else if (cursorPos < rawStart) {
      cursorWrappedLine = s;
      cursorCol = 0;
      break;
    }
  }

  const visibleLines = wrappedLines.slice(inputScrollTop, inputScrollTop + maxRows);
  const visibleCursorLine = cursorWrappedLine - inputScrollTop;
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

export function ensureInputCursorVisible(
  prompt: string,
  cursorPos: number,
  inputScrollTop: number,
  contentWidth: number,
  maxRows: number,
): number {
  const info = getWrappedPromptInfo(prompt, cursorPos, inputScrollTop, contentWidth, maxRows);
  if (info.cursorWrappedLine < inputScrollTop) {
    return info.cursorWrappedLine;
  }
  if (info.cursorWrappedLine >= inputScrollTop + maxRows) {
    return info.cursorWrappedLine - maxRows + 1;
  }
  return inputScrollTop;
}

export function moveCursorVertical(
  prompt: string,
  cursorPos: number,
  inputScrollTop: number,
  contentWidth: number,
  maxRows: number,
  direction: -1 | 1,
): { moved: boolean; cursorPos: number; inputScrollTop: number } {
  const info = getWrappedPromptInfo(prompt, cursorPos, inputScrollTop, contentWidth, maxRows);
  if (info.wrappedLines.length <= 1) {
    return { moved: false, cursorPos, inputScrollTop };
  }

  const targetLine = info.cursorWrappedLine + direction;
  if (targetLine < 0 || targetLine >= info.wrappedLines.length) {
    return { moved: false, cursorPos, inputScrollTop };
  }

  const col = Math.min(info.cursorCol, info.segments[targetLine]!.length);
  const nextCursorPos = info.segments[targetLine]!.rawStart + col;
  const nextScrollTop = ensureInputCursorVisible(prompt, nextCursorPos, inputScrollTop, contentWidth, maxRows);
  return { moved: true, cursorPos: nextCursorPos, inputScrollTop: nextScrollTop };
}

export function saveUndoState(
  undoStack: UndoState[],
  redoStack: UndoState[],
  prompt: string,
  cursorPos: number,
  maxUndo: number,
): void {
  undoStack.push({ prompt, cursorPos });
  if (undoStack.length > maxUndo) undoStack.shift();
  redoStack.length = 0;
}

export function undoPromptState(
  undoStack: UndoState[],
  redoStack: UndoState[],
  prompt: string,
  cursorPos: number,
): UndoState | null {
  if (undoStack.length === 0) return null;
  redoStack.push({ prompt, cursorPos });
  const state = undoStack.pop()!;
  return state;
}

export function redoPromptState(
  undoStack: UndoState[],
  redoStack: UndoState[],
  prompt: string,
  cursorPos: number,
): UndoState | null {
  if (redoStack.length === 0) return null;
  undoStack.push({ prompt, cursorPos });
  return redoStack.pop()!;
}

export function findPathToken(prompt: string, cursorPos: number): { start: number; prefix: string } | null {
  let start = cursorPos;
  while (start > 0 && prompt[start - 1] !== ' ' && prompt[start - 1] !== '\n') {
    start--;
  }

  const word = prompt.slice(start, cursorPos);
  if (word.length === 0) return null;

  if (word.startsWith('!@') || word.startsWith('@') || word.includes('/')) {
    let prefix = word;
    if (prefix.startsWith('!@')) prefix = prefix.slice(2);
    else if (prefix.startsWith('@')) prefix = prefix.slice(1);
    return { start, prefix };
  }
  return null;
}

export type PathCompletionState = {
  prompt: string;
  cursorPos: number;
  inputScrollTop: number;
  contentWidth: number;
  maxRows: number;
  pathCompletions: string[];
  pathCompletionIndex: number;
  pathCompletionPrefix: string;
  pathCompletionStart: number;
  allFiles: string[];
  saveUndoState: () => void;
};

export function handlePathCompletion(state: PathCompletionState): {
  handled: boolean;
  prompt: string;
  cursorPos: number;
  inputScrollTop: number;
  pathCompletions: string[];
  pathCompletionIndex: number;
  pathCompletionPrefix: string;
  pathCompletionStart: number;
} {
  const token = findPathToken(state.prompt, state.cursorPos);
  if (!token) {
    return { handled: false, ...state };
  }

  const { start, prefix } = token;
  const word = state.prompt.slice(start, state.cursorPos);
  const isContinuing = state.pathCompletions.length > 0 && state.pathCompletionStart === start;

  let pathCompletions = state.pathCompletions;
  let pathCompletionIndex = state.pathCompletionIndex;
  let pathCompletionPrefix = state.pathCompletionPrefix;
  let pathCompletionStart = state.pathCompletionStart;

  if (!isContinuing) {
    if (state.allFiles.length === 0) {
      return { handled: false, ...state };
    }
    const lowerPrefix = prefix.toLowerCase();
    const matches = state.allFiles
      .filter(f => f.toLowerCase().includes(lowerPrefix))
      .sort((a, b) => {
        const aFile = a.slice(a.lastIndexOf('/') + 1).toLowerCase();
        const bFile = b.slice(b.lastIndexOf('/') + 1).toLowerCase();
        const aScore = aFile.startsWith(lowerPrefix) ? 2 : a.toLowerCase().startsWith(lowerPrefix) ? 1 : 0;
        const bScore = bFile.startsWith(lowerPrefix) ? 2 : b.toLowerCase().startsWith(lowerPrefix) ? 1 : 0;
        return bScore - aScore;
      });
    if (matches.length === 0) {
      return { handled: false, ...state };
    }
    pathCompletions = matches;
    pathCompletionIndex = 0;
    pathCompletionPrefix = prefix;
    pathCompletionStart = start;
  } else {
    pathCompletionIndex = (pathCompletionIndex + 1) % pathCompletions.length;
  }

  const completed = pathCompletions[pathCompletionIndex]!;
  let leader = '';
  if (word.startsWith('!@')) leader = '!@';
  else if (word.startsWith('@')) leader = '@';

  const replacement = leader + completed;
  state.saveUndoState();
  const prompt = state.prompt.slice(0, start) + replacement + state.prompt.slice(state.cursorPos);
  const cursorPos = start + replacement.length;
  const inputScrollTop = ensureInputCursorVisible(prompt, cursorPos, state.inputScrollTop, state.contentWidth, state.maxRows);

  return {
    handled: true,
    prompt,
    cursorPos,
    inputScrollTop,
    pathCompletions,
    pathCompletionIndex,
    pathCompletionPrefix,
    pathCompletionStart,
  };
}
