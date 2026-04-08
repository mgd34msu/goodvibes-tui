import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type MarkdownFrontmatterValue = string | string[];

export interface MarkdownFrontmatter {
  readonly [key: string]: MarkdownFrontmatterValue | undefined;
}

export interface MarkdownDisclosure {
  readonly path: string;
  readonly metadata: MarkdownFrontmatter;
  readonly body: string;
  readonly includes: readonly string[];
  readonly sections: readonly string[];
  readonly preview: string;
}

const MAX_INCLUDE_DEPTH = 5;

export function parseMarkdownFrontmatter(content: string): {
  metadata: MarkdownFrontmatter;
  body: string;
} {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return { metadata: {}, body: content };
  }

  const secondDash = trimmed.indexOf('\n---', 3);
  if (secondDash === -1) {
    return { metadata: {}, body: content };
  }

  const rawFrontmatter = trimmed.slice(3, secondDash).trim();
  const body = trimmed.slice(secondDash + 4).trimStart();
  return {
    metadata: parseSimpleYamlFrontmatter(rawFrontmatter),
    body,
  };
}

function parseSimpleYamlFrontmatter(frontmatter: string): MarkdownFrontmatter {
  const result: Record<string, MarkdownFrontmatterValue> = {};
  const lines = frontmatter.split('\n');
  let currentKey: string | null = null;
  let listBuffer: string[] = [];
  let collectingList = false;

  const flushList = () => {
    if (collectingList && currentKey) {
      result[currentKey] = listBuffer.slice();
    }
    collectingList = false;
    currentKey = null;
    listBuffer = [];
  };

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) {
      if (collectingList) flushList();
      continue;
    }

    const listItem = line.match(/^\s+-\s+(.+)$/);
    if (collectingList && listItem) {
      listBuffer.push(stripWrappingQuotes(listItem[1]!.trim()));
      continue;
    }

    const kv = line.match(/^([\w.-]+):\s*(.*)$/);
    if (!kv) continue;

    if (collectingList) flushList();

    currentKey = kv[1]!;
    const rawValue = kv[2]!.trim();

    if (!rawValue) {
      collectingList = true;
      continue;
    }

    const inlineList = rawValue.match(/^\[(.*)\]$/);
    if (inlineList) {
      result[currentKey] = inlineList[1]!
        .split(',')
        .map((part) => stripWrappingQuotes(part.trim()))
        .filter(Boolean);
      currentKey = null;
      continue;
    }

    result[currentKey] = stripWrappingQuotes(rawValue);
    currentKey = null;
  }

  if (collectingList) flushList();

  return result;
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

export function normalizeFrontmatterList(value: MarkdownFrontmatterValue | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((entry) => entry.trim()).filter(Boolean);
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

export function collectMarkdownReferences(body: string): string[] {
  const refs: string[] = [];
  const refRegex = /^\s*@([A-Za-z0-9_./#-]+)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = refRegex.exec(body)) !== null) {
    refs.push(match[1]!);
  }
  return refs;
}

export function extractMarkdownSections(body: string): string[] {
  const sections: string[] = [];
  const headingRegex = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(body)) !== null) {
    sections.push(match[2]!.trim());
  }
  return sections;
}

export function extractMarkdownPreview(body: string, maxChars = 220): string {
  const cleaned = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('@') && !line.startsWith('#'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function readMarkdownDisclosure(filePath: string): MarkdownDisclosure {
  const resolvedPath = resolve(filePath);
  const raw = readFileSync(resolvedPath, 'utf-8');
  const { metadata, body } = parseMarkdownFrontmatter(raw);
  return {
    path: resolvedPath,
    metadata,
    body,
    includes: collectMarkdownReferences(body),
    sections: extractMarkdownSections(body),
    preview: extractMarkdownPreview(body),
  };
}

export function materializeMarkdownBody(filePath: string, body?: string): string {
  const resolvedPath = resolve(filePath);
  const sourceBody = body ?? readMarkdownDisclosure(resolvedPath).body;
  return resolveMarkdownIncludes(resolvedPath, sourceBody, new Set<string>(), 0);
}

function resolveMarkdownIncludes(
  sourcePath: string,
  body: string,
  visited: Set<string>,
  depth: number,
): string {
  if (depth >= MAX_INCLUDE_DEPTH) return '';

  const resolvedSourcePath = resolve(sourcePath);
  if (visited.has(resolvedSourcePath)) return '';
  visited.add(resolvedSourcePath);

  const baseDir = dirname(resolvedSourcePath);
  const lines = body.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('@@')) {
      const marker = line.indexOf('@@');
      result.push(`${line.slice(0, marker)}${line.slice(marker + 1)}`);
      continue;
    }

    const includeMatch = trimmed.match(/^@([A-Za-z0-9_./#-]+)\s*$/);
    if (!includeMatch) {
      result.push(line);
      continue;
    }

    const includeTarget = includeMatch[1]!;
    const includePath = resolve(baseDir, includeTarget.split('#')[0]!);
    if (!existsSync(includePath)) {
      continue;
    }

    const included = readMarkdownDisclosure(includePath);
    const materialized = resolveMarkdownIncludes(includePath, included.body, visited, depth + 1);
    if (!materialized) continue;
    result.push(materialized);
  }

  return result.join('\n');
}
