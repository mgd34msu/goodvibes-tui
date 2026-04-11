import JSZip from 'jszip';
import { extname } from 'node:path';
import type { ArtifactDescriptor, ArtifactRecord } from '../artifacts/types.ts';
import { guessMimeType } from '../artifacts/types.ts';
import type { KnowledgeExtractionFormat } from './types.ts';

export interface KnowledgeExtractionResult {
  readonly extractorId: string;
  readonly format: KnowledgeExtractionFormat;
  readonly title?: string;
  readonly summary?: string;
  readonly excerpt?: string;
  readonly sections: readonly string[];
  readonly links: readonly string[];
  readonly estimatedTokens: number;
  readonly structure: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function cleanText(value: string): string {
  return value
    .replace(/\u0000/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function estimateTokens(...chunks: Array<string | undefined | null>): number {
  const total = chunks
    .filter((value): value is string => typeof value === 'string')
    .reduce((sum, value) => sum + value.length, 0);
  return Math.max(1, Math.ceil(total / 4));
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .find(Boolean);
}

function summarizeText(text: string, maxLength = 320): string | undefined {
  const cleaned = cleanText(text);
  if (!cleaned) return undefined;
  if (cleaned.length <= maxLength) return cleaned;
  const sentence = cleaned.match(/^(.{0,320}?[.!?])(?:\s|$)/)?.[1]?.trim();
  return sentence && sentence.length >= 40 ? sentence : `${cleaned.slice(0, maxLength - 1).trim()}…`;
}

function excerptText(text: string, maxLength = 480): string | undefined {
  const cleaned = cleanText(text);
  if (!cleaned) return undefined;
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1).trim()}…`;
}

function uniqueStrings(values: Iterable<string>, limit = 24): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = cleanText(value);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result;
}

function decodeBuffer(buffer: Buffer): string {
  return cleanText(buffer.toString('utf-8'));
}

function extractLinksFromHtml(html: string): string[] {
  const urls: string[] = [];
  const regex = /\bhref=["']([^"'#]+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const candidate = match[1]?.trim();
    if (candidate) urls.push(candidate);
  }
  return uniqueStrings(urls, 50);
}

function extractHtml(buffer: Buffer): KnowledgeExtractionResult {
  const html = buffer.toString('utf-8');
  const title = cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
    || cleanText(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '');
  const headings = uniqueStrings(
    Array.from(html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi), (match) => stripHtml(match[2] ?? '')),
    16,
  );
  const paragraphs = uniqueStrings(
    Array.from(html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi), (match) => stripHtml(match[1] ?? '')),
    8,
  );
  const readable = stripHtml(html);
  const summary = summarizeText([headings[0], paragraphs[0], readable].filter(Boolean).join(' '));
  return {
    extractorId: 'html',
    format: 'html',
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(excerptText(readable) ? { excerpt: excerptText(readable) } : {}),
    sections: headings.length > 0 ? headings : uniqueStrings(readable.split(/\n+/), 8),
    links: extractLinksFromHtml(html),
    estimatedTokens: estimateTokens(title, summary, readable),
    structure: {
      headings,
      paragraphCount: paragraphs.length,
      readableLength: readable.length,
    },
    metadata: {
      paragraphSamples: paragraphs.slice(0, 4),
    },
  };
}

function extractTextLike(
  buffer: Buffer,
  format: KnowledgeExtractionFormat,
  extractorId: string,
): KnowledgeExtractionResult {
  const text = decodeBuffer(buffer);
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const headings = lines.filter((line) => /^#{1,6}\s+/.test(line)).map((line) => line.replace(/^#{1,6}\s+/, ''));
  const sections = headings.length > 0 ? headings : uniqueStrings(lines.slice(0, 8), 8);
  const title = headings[0] ?? firstNonEmptyLine(text);
  const summary = summarizeText(text);
  const links = uniqueStrings(
    Array.from(text.matchAll(/\bhttps?:\/\/[^\s)>"']+/g), (match) => match[0]),
    50,
  );
  return {
    extractorId,
    format,
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(excerptText(text) ? { excerpt: excerptText(text) } : {}),
    sections,
    links,
    estimatedTokens: estimateTokens(text),
    structure: {
      lineCount: lines.length,
      headingCount: headings.length,
    },
    metadata: {},
  };
}

function extractJson(buffer: Buffer): KnowledgeExtractionResult {
  const text = decodeBuffer(buffer);
  try {
    const parsed = JSON.parse(text) as unknown;
    const rootKeys = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? Object.keys(parsed as Record<string, unknown>).slice(0, 24)
      : [];
    const title = rootKeys.length > 0 ? `JSON object: ${rootKeys.slice(0, 3).join(', ')}` : 'JSON document';
    const summary = Array.isArray(parsed)
      ? `JSON array with ${parsed.length} item(s).`
      : `JSON object with ${rootKeys.length} top-level key(s).`;
    return {
      extractorId: 'json',
      format: 'json',
      title,
      summary,
      excerpt: excerptText(text),
      sections: rootKeys,
      links: uniqueStrings(Array.from(text.matchAll(/\bhttps?:\/\/[^\s",]+/g), (match) => match[0]), 50),
      estimatedTokens: estimateTokens(text),
      structure: {
        rootType: Array.isArray(parsed) ? 'array' : typeof parsed,
        rootKeys,
        itemCount: Array.isArray(parsed) ? parsed.length : undefined,
      },
      metadata: {},
    };
  } catch {
    return extractTextLike(buffer, 'json', 'json-fallback');
  }
}

function parseDelimited(text: string, delimiter: ',' | '\t'): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return { headers: [], rows: [] };
  const parseLine = (line: string): string[] => {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]!;
      if (char === '"') {
        if (inQuotes && line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (char === delimiter && !inQuotes) {
        cells.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }
    cells.push(current.trim());
    return cells;
  };
  return {
    headers: parseLine(lines[0]!),
    rows: lines.slice(1, 6).map(parseLine),
  };
}

function extractDelimited(buffer: Buffer, delimiter: ',' | '\t', format: 'csv' | 'tsv'): KnowledgeExtractionResult {
  const text = decodeBuffer(buffer);
  const { headers, rows } = parseDelimited(text, delimiter);
  const summary = headers.length > 0
    ? `${format.toUpperCase()} table with ${headers.length} column(s); sampled ${rows.length} row(s).`
    : `${format.toUpperCase()} table.`;
  return {
    extractorId: format,
    format,
    title: headers.length > 0 ? `${format.toUpperCase()} sheet: ${headers.slice(0, 3).join(', ')}` : `${format.toUpperCase()} data`,
    summary,
    excerpt: excerptText(text),
    sections: headers,
    links: uniqueStrings(Array.from(text.matchAll(/\bhttps?:\/\/[^\s",]+/g), (match) => match[0]), 50),
    estimatedTokens: estimateTokens(text),
    structure: {
      headers,
      sampleRows: rows,
      rowCountSampled: rows.length,
    },
    metadata: {},
  };
}

function extractXml(buffer: Buffer): KnowledgeExtractionResult {
  const text = decodeBuffer(buffer);
  const tags = uniqueStrings(Array.from(text.matchAll(/<([a-zA-Z0-9:_-]+)(?:\s|>)/g), (match) => match[1] ?? ''), 20);
  const readable = cleanText(decodeHtmlEntities(text.replace(/<[^>]+>/g, ' ')));
  return {
    extractorId: 'xml',
    format: 'xml',
    title: tags[0] ? `XML: <${tags[0]}>` : 'XML document',
    summary: summarizeText(readable) ?? 'XML document.',
    excerpt: excerptText(readable),
    sections: tags,
    links: uniqueStrings(Array.from(text.matchAll(/\bhttps?:\/\/[^\s"'<]+/g), (match) => match[0]), 50),
    estimatedTokens: estimateTokens(readable),
    structure: { tags },
    metadata: {},
  };
}

function extractYaml(buffer: Buffer): KnowledgeExtractionResult {
  const text = decodeBuffer(buffer);
  const keys = uniqueStrings(
    Array.from(text.matchAll(/^([A-Za-z0-9_.-]+):/gm), (match) => match[1] ?? ''),
    24,
  );
  return {
    extractorId: 'yaml',
    format: 'yaml',
    title: keys[0] ? `YAML: ${keys.slice(0, 3).join(', ')}` : 'YAML document',
    summary: summarizeText(text) ?? 'YAML document.',
    excerpt: excerptText(text),
    sections: keys.length > 0 ? keys : uniqueStrings(text.split(/\n+/), 8),
    links: uniqueStrings(Array.from(text.matchAll(/\bhttps?:\/\/[^\s"']+/g), (match) => match[0]), 50),
    estimatedTokens: estimateTokens(text),
    structure: { keys },
    metadata: {},
  };
}

function extractPdf(buffer: Buffer): KnowledgeExtractionResult {
  const body = buffer.toString('latin1');
  const texts: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(body)) !== null) {
    const chunk = match[1];
    const parenRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
    let textMatch: RegExpExecArray | null;
    while ((textMatch = parenRe.exec(chunk)) !== null) {
      const text = cleanText(
        textMatch[1]
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\\\/g, '\\')
          .replace(/\\\(/g, '(')
          .replace(/\\\)/g, ')'),
      );
      if (text.length > 1) texts.push(text);
    }
  }
  const combined = uniqueStrings(texts, 64).join('\n');
  return {
    extractorId: 'pdf',
    format: 'pdf',
    title: firstNonEmptyLine(combined) ?? 'PDF document',
    summary: summarizeText(combined) ?? 'PDF extraction produced limited text; OCR is not used in-core.',
    excerpt: excerptText(combined),
    sections: uniqueStrings(combined.split(/\n+/), 8),
    links: uniqueStrings(Array.from(combined.matchAll(/\bhttps?:\/\/[^\s)]+/g), (match) => match[0]), 50),
    estimatedTokens: estimateTokens(combined),
    structure: {
      extractedStringCount: texts.length,
    },
    metadata: {
      limitations: texts.length === 0
        ? ['No readable text streams were found. Complex PDFs need OCR or a dedicated provider.']
        : ['PDF extraction is best-effort and does not use OCR.'],
    },
  };
}

async function extractDocx(buffer: Buffer): Promise<KnowledgeExtractionResult> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) return extractTextLike(buffer, 'docx', 'docx-fallback');
  const xml = await file.async('string');
  const paragraphs = uniqueStrings(
    Array.from(xml.matchAll(/<w:p[\s\S]*?<\/w:p>/g), (match) => {
      const text = Array.from(match[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g), (part) => decodeHtmlEntities(part[1] ?? '')).join('');
      return text;
    }),
    48,
  );
  const headings = uniqueStrings(
    Array.from(xml.matchAll(/<w:p[\s\S]*?<w:pStyle[^>]*w:val="Heading[0-9]+"[\s\S]*?<\/w:p>/g), (match) => {
      const text = Array.from(match[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g), (part) => decodeHtmlEntities(part[1] ?? '')).join('');
      return text;
    }),
    12,
  );
  const text = paragraphs.join('\n\n');
  return {
    extractorId: 'docx',
    format: 'docx',
    title: headings[0] ?? paragraphs[0] ?? 'DOCX document',
    summary: summarizeText(text) ?? 'DOCX document.',
    excerpt: excerptText(text),
    sections: headings.length > 0 ? headings : paragraphs.slice(0, 8),
    links: uniqueStrings(Array.from(text.matchAll(/\bhttps?:\/\/[^\s)]+/g), (match) => match[0]), 50),
    estimatedTokens: estimateTokens(text),
    structure: {
      paragraphCount: paragraphs.length,
      headingCount: headings.length,
    },
    metadata: {},
  };
}

function readSharedStrings(xml: string): string[] {
  return Array.from(xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g), (match) => decodeHtmlEntities(match[1] ?? ''));
}

async function extractXlsx(buffer: Buffer): Promise<KnowledgeExtractionResult> {
  const zip = await JSZip.loadAsync(buffer);
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string') ?? '';
  const sharedStringsXml = await zip.file('xl/sharedStrings.xml')?.async('string') ?? '';
  const sharedStrings = readSharedStrings(sharedStringsXml);
  const sheetNames = uniqueStrings(
    Array.from(workbookXml.matchAll(/<sheet[^>]+name="([^"]+)"/g), (match) => decodeHtmlEntities(match[1] ?? '')),
    20,
  );
  const sampleSheets: Array<{ name: string; rows: string[][] }> = [];
  const sheetEntries = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 3);
  for (const [index, sheetPath] of sheetEntries.entries()) {
    const xml = await zip.file(sheetPath)?.async('string');
    if (!xml) continue;
    const rows = Array.from(xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g), (rowMatch) => {
      return Array.from(rowMatch[1].matchAll(/<c[^>]*?(?:\st="([^"]+)")?[^>]*>([\s\S]*?)<\/c>/g), (cellMatch) => {
        const type = cellMatch[1] ?? '';
        const body = cellMatch[2] ?? '';
        const raw = body.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1]
          ?? body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1]
          ?? '';
        const value = type === 's'
          ? (sharedStrings[Number(raw)] ?? raw)
          : decodeHtmlEntities(raw);
        return cleanText(value);
      }).filter(Boolean);
    }).filter((row) => row.length > 0).slice(0, 6);
    sampleSheets.push({
      name: sheetNames[index] ?? sheetPath,
      rows,
    });
  }
  const flatText = sampleSheets.flatMap((sheet) => [sheet.name, ...sheet.rows.flatMap((row) => row)]).join('\n');
  return {
    extractorId: 'xlsx',
    format: 'xlsx',
    title: sheetNames[0] ? `Workbook: ${sheetNames[0]}` : 'XLSX workbook',
    summary: sheetNames.length > 0
      ? `Workbook with ${sheetNames.length} sheet(s): ${sheetNames.slice(0, 4).join(', ')}.`
      : 'XLSX workbook.',
    excerpt: excerptText(flatText),
    sections: sheetNames,
    links: uniqueStrings(Array.from(flatText.matchAll(/\bhttps?:\/\/[^\s)]+/g), (match) => match[0]), 50),
    estimatedTokens: estimateTokens(flatText),
    structure: {
      sheetNames,
      sampleSheets,
    },
    metadata: {},
  };
}

async function extractPptx(buffer: Buffer): Promise<KnowledgeExtractionResult> {
  const zip = await JSZip.loadAsync(buffer);
  const slideEntries = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 12);
  const slides: Array<{ title: string; text: string }> = [];
  for (const path of slideEntries) {
    const xml = await zip.file(path)?.async('string');
    if (!xml) continue;
    const text = uniqueStrings(Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g), (match) => decodeHtmlEntities(match[1] ?? '')), 64).join('\n');
    if (!text) continue;
    slides.push({
      title: firstNonEmptyLine(text) ?? path,
      text,
    });
  }
  const combined = slides.map((slide) => `${slide.title}\n${slide.text}`).join('\n\n');
  return {
    extractorId: 'pptx',
    format: 'pptx',
    title: slides[0]?.title ?? 'PPTX deck',
    summary: slides.length > 0 ? `Slide deck with ${slides.length} extracted slide(s).` : 'PPTX deck.',
    excerpt: excerptText(combined),
    sections: slides.map((slide) => slide.title).slice(0, 12),
    links: uniqueStrings(Array.from(combined.matchAll(/\bhttps?:\/\/[^\s)]+/g), (match) => match[0]), 50),
    estimatedTokens: estimateTokens(combined),
    structure: {
      slideCount: slides.length,
      slides: slides.slice(0, 6),
    },
    metadata: {},
  };
}

function chooseFormat(artifact: Pick<ArtifactDescriptor, 'mimeType' | 'filename'>): KnowledgeExtractionFormat {
  const mime = artifact.mimeType.toLowerCase();
  const filenameType = guessMimeType(artifact.filename);
  const effective = mime === 'application/octet-stream' ? filenameType : mime;
  if (effective === 'text/markdown') return 'markdown';
  if (effective === 'text/html') return 'html';
  if (effective === 'application/json') return 'json';
  if (effective === 'text/csv') return 'csv';
  if (effective === 'text/tab-separated-values') return 'tsv';
  if (effective === 'application/xml' || effective === 'text/xml') return 'xml';
  if (effective === 'application/yaml' || effective === 'text/yaml' || effective === 'text/x-yaml') return 'yaml';
  if (effective === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (effective === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  if (effective === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
  if (effective === 'application/pdf') return 'pdf';
  if (effective.startsWith('text/')) return 'text';
  const ext = extname((artifact.filename ?? '').toLowerCase());
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.json') return 'json';
  if (ext === '.csv') return 'csv';
  if (ext === '.tsv') return 'tsv';
  if (ext === '.xml') return 'xml';
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx') return 'xlsx';
  if (ext === '.pptx') return 'pptx';
  if (ext === '.pdf') return 'pdf';
  return 'unknown';
}

export async function extractKnowledgeArtifact(
  artifact: Pick<ArtifactRecord, 'id' | 'mimeType' | 'filename'>,
  buffer: Buffer,
): Promise<KnowledgeExtractionResult> {
  const format = chooseFormat(artifact);
  switch (format) {
    case 'html':
      return extractHtml(buffer);
    case 'markdown':
      return extractTextLike(buffer, 'markdown', 'markdown');
    case 'json':
      return extractJson(buffer);
    case 'csv':
      return extractDelimited(buffer, ',', 'csv');
    case 'tsv':
      return extractDelimited(buffer, '\t', 'tsv');
    case 'xml':
      return extractXml(buffer);
    case 'yaml':
      return extractYaml(buffer);
    case 'docx':
      return extractDocx(buffer);
    case 'xlsx':
      return extractXlsx(buffer);
    case 'pptx':
      return extractPptx(buffer);
    case 'pdf':
      return extractPdf(buffer);
    case 'text':
      return extractTextLike(buffer, 'text', 'text');
    default:
      return {
        extractorId: 'binary-fallback',
        format: 'unknown',
        title: artifact.filename ?? artifact.id,
        summary: `Stored artifact ${artifact.filename ?? artifact.id} (${artifact.mimeType}) has no specialized in-core extractor yet.`,
        sections: [],
        links: [],
        estimatedTokens: 1,
        structure: {
          mimeType: artifact.mimeType,
        },
        metadata: {
          limitations: ['No specialized extractor matched this artifact type.'],
        },
      };
  }
}
