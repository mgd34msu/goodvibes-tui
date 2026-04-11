import type { KnowledgeBookmarkSeed } from './types.ts';

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function normalizeFolderPath(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed
    .split(/[/>|]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(' / ');
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
  }
  if (typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function parseJsonBookmarks(value: unknown, inheritedFolder?: string): KnowledgeBookmarkSeed[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return [{ url: trimmed, ...(inheritedFolder ? { folderPath: inheritedFolder } : {}) }];
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseJsonBookmarks(entry, inheritedFolder));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  const folderName = normalizeFolderPath(
    typeof record.folderPath === 'string' ? record.folderPath
      : typeof record.folder === 'string' ? record.folder
        : typeof record.name === 'string' && !record.url && !record.href && !record.uri ? record.name
          : inheritedFolder,
  );
  const url = typeof record.url === 'string'
    ? record.url
    : typeof record.href === 'string'
      ? record.href
      : typeof record.uri === 'string'
        ? record.uri
        : undefined;
  const title = typeof record.title === 'string'
    ? record.title
    : typeof record.name === 'string'
      ? record.name
      : undefined;
  const metadata = typeof record.metadata === 'object' && record.metadata !== null
    ? record.metadata as Record<string, unknown>
    : {};
  const tags = normalizeTags(record.tags);
  const nested = parseJsonBookmarks(record.children ?? record.items ?? [], folderName);
  const current = url && /^https?:\/\//i.test(url)
    ? [{
        url,
        ...(title?.trim() ? { title: title.trim() } : {}),
        ...(folderName ? { folderPath: folderName } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        metadata,
      } satisfies KnowledgeBookmarkSeed]
    : [];
  return [...current, ...nested];
}

function parseNetscapeBookmarks(content: string): KnowledgeBookmarkSeed[] {
  const entries: KnowledgeBookmarkSeed[] = [];
  const folderStack: string[] = [];
  let pendingFolder: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const folderMatch = line.match(/<H3[^>]*>([\s\S]*?)<\/H3>/i);
    if (folderMatch?.[1]) {
      pendingFolder = decodeHtml(folderMatch[1].replace(/<[^>]+>/g, ''));
      continue;
    }

    if (/<DL/i.test(line)) {
      if (pendingFolder) {
        folderStack.push(pendingFolder);
        pendingFolder = null;
      }
      continue;
    }

    if (/<\/DL>/i.test(line)) {
      folderStack.pop();
      continue;
    }

    const linkMatch = line.match(/<A\s+([^>]*?)>([\s\S]*?)<\/A>/i);
    if (!linkMatch) continue;

    const attrs = linkMatch[1];
    const href = attrs.match(/\bHREF=["']([^"']+)["']/i)?.[1];
    if (!href || !/^https?:\/\//i.test(href)) continue;
    const tags = attrs.match(/\bTAGS=["']([^"']+)["']/i)?.[1];
    const addDate = attrs.match(/\bADD_DATE=["']([^"']+)["']/i)?.[1];
    const title = decodeHtml(linkMatch[2].replace(/<[^>]+>/g, ''));
    const folderPath = folderStack.length > 0 ? folderStack.join(' / ') : undefined;
    entries.push({
      url: href,
      ...(title ? { title } : {}),
      ...(folderPath ? { folderPath } : {}),
      ...(tags ? { tags: normalizeTags(tags) } : {}),
      metadata: {
        ...(addDate ? { addDate } : {}),
      },
    });
  }

  return entries;
}

function parseUrlList(content: string): KnowledgeBookmarkSeed[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .filter((line) => /^https?:\/\//i.test(line))
    .map((url) => ({ url }));
}

export function parseBookmarkSeeds(content: string): KnowledgeBookmarkSeed[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return parseJsonBookmarks(JSON.parse(trimmed));
    } catch {
      return parseUrlList(trimmed);
    }
  }

  if (/<A\s/i.test(trimmed) && /<DL/i.test(trimmed)) {
    return parseNetscapeBookmarks(trimmed);
  }

  return parseUrlList(trimmed);
}
