import { type Line, createStyledCell } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';

/** Color by file extension category. */
function getFileColor(name: string): string {
  if (name.endsWith('/')) return '#00ffff'; // directory
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs'].includes(ext)) return '#dcdcaa';
  if (['json', 'yaml', 'yml', 'toml'].includes(ext)) return '#ce9178';
  if (['md', 'txt', 'rst'].includes(ext)) return '252';
  if (['sh', 'bash', 'zsh'].includes(ext)) return '#22c55e';
  if (['css', 'scss', 'less'].includes(ext)) return '#569cd6';
  if (['html', 'htm', 'xml', 'svg'].includes(ext)) return '#f97316';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico'].includes(ext)) return '#a855f7';
  if (['lock', 'env', 'gitignore'].includes(name)) return '238';
  return '252';
}

export interface FileTreeEntry {
  name: string;
  isDir: boolean;
  size?: number;
  depth: number;
  isLast: boolean;
  isLastAtDepth: boolean[]; // tracks if each ancestor was last child
}

/**
 * renderFileTree - Render a directory listing as a tree with colored file types.
 * Returns Line[] for the cell-based pipeline.
 */
export function renderFileTree(
  entries: FileTreeEntry[],
  width: number,
  title?: string
): Line[] {
  const lines: Line[] = [];

  // Optional header
  if (title) {
    lines.push(UIFactory.stringToLine(` [dir] ${title}`, width, { fg: '#00ffff', bold: true }));
    lines.push(UIFactory.stringToLine(' ' + '-'.repeat(width - 2), width, { fg: '240' }));
  }

  for (const entry of entries) {
    const { name, isDir, size, depth, isLast, isLastAtDepth } = entry;

    // Build tree prefix
    let prefix = '';
    for (let d = 0; d < depth; d++) {
      if (d < depth - 1) {
        prefix += isLastAtDepth[d] ? '   ' : '|  ';
      }
    }
    if (depth > 0) {
      prefix += isLast ? '`-- ' : '|-- ';
    } else {
      prefix += '';
    }

    const displayName = isDir ? name + '/' : name;
    const fg = getFileColor(isDir ? displayName : name);

    // Size info (dimmed)
    let sizeStr = '';
    if (size !== undefined && !isDir) {
      if (size < 1024) sizeStr = ` ${size}B`;
      else if (size < 1024 * 1024) sizeStr = ` ${(size / 1024).toFixed(1)}K`;
      else sizeStr = ` ${(size / (1024 * 1024)).toFixed(1)}M`;
    }

    const fullText = prefix + displayName;
    const sizeW = getDisplayWidth(sizeStr);
    const nameW = getDisplayWidth(fullText);
    const maxNameW = width - sizeW - 1;

    const truncated = nameW > maxNameW ? fullText.slice(0, Math.max(0, maxNameW - 3)) + '...' : fullText;

    // Compose: name + padding + size
    const paddingW = Math.max(0, width - getDisplayWidth(truncated) - sizeW);
    const fullLine = truncated + ' '.repeat(paddingW);

    // Build the line with per-character styles
    const line = UIFactory.stringToLine(fullLine, width, { fg });

    // Dim the size info
    if (sizeStr && sizeW > 0) {
      const sizeStartX = width - sizeW;
      let cx = sizeStartX;
      for (const ch of sizeStr) {
        if (cx >= width) break;
        const cw = getDisplayWidth(ch);
        line[cx] = createStyledCell(ch, { fg: '240', dim: true });
        if (cw === 2 && cx + 1 < width) line[cx + 1] = { ...line[cx], char: '' };
        cx += cw;
      }
    }

    lines.push(line);
  }

  return lines;
}

/**
 * parseListDirOutput - Convert a simple list directory output string to FileTreeEntry[].
 * Expects one path per line, relative paths with '/' for directories.
 */
export function parseListDirOutput(output: string, rootDir: string): FileTreeEntry[] {
  const rawLines = output.trim().split('\n').filter(Boolean);
  const entries: FileTreeEntry[] = [];

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const isDir = trimmed.endsWith('/');
    const name = isDir ? trimmed.slice(0, -1).split('/').pop() + '/' : trimmed.split('/').pop() ?? trimmed;
    const depth = (trimmed.match(/\//g) ?? []).length - (isDir ? 1 : 0);

    entries.push({
      name: name || trimmed,
      isDir,
      depth: Math.max(0, depth),
      isLast: false,
      isLastAtDepth: [],
    });
  }

  // Mark isLast for each entry (last sibling at same depth under same parent)
  for (let i = 0; i < entries.length; i++) {
    const nextSameOrLower = entries.slice(i + 1).findIndex(
      e => e.depth <= entries[i].depth
    );
    entries[i].isLast = nextSameOrLower === 0 || nextSameOrLower === -1;

    // Build isLastAtDepth[d] = true if the ancestor at depth d was the last child
    // of its parent. This governs whether to draw '|  ' or '   ' vertical bars.
    const isLastAtDepth: boolean[] = new Array(entries[i].depth).fill(false);
    for (let d = 0; d < entries[i].depth; d++) {
      // Walk backwards to find the most recent ancestor at depth d
      for (let j = i - 1; j >= 0; j--) {
        if (entries[j].depth === d) {
          isLastAtDepth[d] = entries[j].isLast;
          break;
        }
      }
    }
    entries[i].isLastAtDepth = isLastAtDepth;
  }

  return entries;
}
