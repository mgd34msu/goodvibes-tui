import type { BlockMeta } from './conversation.ts';

export function parseDiffForApply(diffText: string): Pick<BlockMeta, 'filePath' | 'diffOriginal' | 'diffUpdated'> {
  const lines = diffText.split('\n');
  let filePath: string | undefined;

  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      const path = raw.startsWith('b/') ? raw.slice(2) : raw.split(' ')[0];
      if (path && path !== '/dev/null') filePath = path;
      break;
    }
  }

  const originalLines: string[] = [];
  const updatedLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
    if (line.startsWith('-')) {
      originalLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      updatedLines.push(line.slice(1));
    } else {
      const content = line.startsWith(' ') ? line.slice(1) : line;
      originalLines.push(content);
      updatedLines.push(content);
    }
  }

  return {
    filePath,
    diffOriginal: originalLines.join('\n'),
    diffUpdated: updatedLines.join('\n'),
  };
}

export function applyDiffContent(
  fileContent: string,
  original: string,
  updated: string,
): { ok: true; content: string } | { ok: false; error: string } {
  if (!original) {
    return { ok: false, error: 'empty original pattern' };
  }
  if (!fileContent.includes(original)) {
    return { ok: false, error: 'original text not found in file' };
  }
  const occurrenceCount = fileContent.split(original).length - 1;
  if (occurrenceCount > 1) {
    return { ok: false, error: `ambiguous: pattern found ${occurrenceCount} times` };
  }
  return { ok: true, content: fileContent.replace(original, updated) };
}
