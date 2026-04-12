import type { FetchExtractMode } from './schema.ts';

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function htmlToMarkdown(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '### $1\n')
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '#### $1\n')
    .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '##### $1\n')
    .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '###### $1\n')
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/(strong|b)>/gi, '**$2**')
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/(em|i)>/gi, '_$2_')
    .replace(/<a[^>]+href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<img[^>]*>/gi, (match) => {
      const alt = match.match(/\balt=["']([^"']*)["']/i)?.[1] ?? '';
      const src = match.match(/\bsrc=["']([^"']*)["']/i)?.[1] ?? '';
      return alt ? `![${alt}](${src})` : `![](${src})`;
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1')
    .replace(/<ul[^>]*>/gi, '\n').replace(/<\/ul>/gi, '\n')
    .replace(/<ol[^>]*>/gi, '\n').replace(/<\/ol>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n').replace(/<\/p>/gi, '\n')
    .replace(/<br[^>]*>/gi, '\n')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '```\n$1\n```')
    .replace(/<hr[^>]*>/gi, '\n---\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractReadable(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '');
  return stripHtml(stripped);
}

function extractCodeBlocks(html: string): string {
  const blocks: string[] = [];
  const preRe = /<pre[^>]*>([\s\S]*?)<\/pre>/gi;
  let m: RegExpExecArray | null;
  while ((m = preRe.exec(html)) !== null) {
    blocks.push(stripHtml(m[1]));
  }
  const withoutPre = html.replace(/<pre[\s\S]*?<\/pre>/gi, '');
  const codeRe = /<code[^>]*>([\s\S]*?)<\/code>/gi;
  while ((m = codeRe.exec(withoutPre)) !== null) {
    const code = stripHtml(m[1]);
    if (code.trim()) blocks.push(code);
  }
  return blocks.join('\n\n');
}

function extractLinks(html: string): string {
  const links: string[] = [];
  const re = /(?:href|src)=["']([^"'#][^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    links.push(m[1]);
  }
  return links.join('\n');
}

function extractStructured(html: string, selectors: string[]): string {
  const results: string[] = [];

  for (const selector of selectors) {
    const trimmed = selector.trim();
    let tagPattern: string | null = null;
    let classFilter: string | null = null;
    let idFilter: string | null = null;

    if (trimmed.startsWith('#')) {
      idFilter = trimmed.slice(1);
      tagPattern = '[a-z][a-z0-9]*';
    } else if (trimmed.startsWith('.')) {
      classFilter = trimmed.slice(1);
      tagPattern = '[a-z][a-z0-9]*';
    } else if (trimmed.includes('.')) {
      const [tag, cls] = trimmed.split('.');
      tagPattern = tag || '[a-z][a-z0-9]*';
      classFilter = cls;
    } else {
      tagPattern = trimmed || '[a-z][a-z0-9]*';
    }

    let attrClause = '';
    if (idFilter) {
      attrClause = `(?=[^>]*\\bid=["']${idFilter}["'])`;
    } else if (classFilter) {
      attrClause = `(?=[^>]*\\bclass=["'][^"']*\\b${classFilter}\\b[^"']*["'])`;
    }

    const re = new RegExp(`<(${tagPattern})${attrClause}[^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');

    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const text = stripHtml(m[2]).trim();
      if (text) results.push(text);
    }
  }

  return JSON.stringify(results);
}

function extractTables(html: string): string {
  const tables: Array<{ headers: string[]; rows: string[][] }> = [];

  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableM: RegExpExecArray | null;

  while ((tableM = tableRe.exec(html)) !== null) {
    const tableHtml = tableM[1];
    const headers: string[] = [];
    const rows: string[][] = [];

    const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    let thM: RegExpExecArray | null;
    while ((thM = thRe.exec(tableHtml)) !== null) {
      headers.push(stripHtml(thM[1]).trim());
    }

    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trM: RegExpExecArray | null;
    while ((trM = trRe.exec(tableHtml)) !== null) {
      const rowHtml = trM[1];
      if (/<th[^>]*>/i.test(rowHtml)) continue;
      const cells: string[] = [];
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let tdM: RegExpExecArray | null;
      while ((tdM = tdRe.exec(rowHtml)) !== null) {
        cells.push(stripHtml(tdM[1]).trim());
      }
      if (cells.length > 0) rows.push(cells);
    }

    tables.push({ headers, rows });
  }

  return JSON.stringify(tables);
}

function extractPdf(body: string): string {
  const texts: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(body)) !== null) {
    const chunk = m[1];
    const parenRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
    let pm: RegExpExecArray | null;
    while ((pm = parenRe.exec(chunk)) !== null) {
      const text = pm[1]
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\')
        .replace(/\\\(/g, '(')
        .replace(/\\\)/g, ')')
        .trim();
      if (text.length > 1) texts.push(text);
    }
  }

  if (texts.length === 0) {
    return JSON.stringify({
      note: 'PDF text extraction requires a dedicated library for complex PDFs. No readable text streams found.',
      byteSize: Buffer.byteLength(body, 'utf-8'),
    });
  }

  return texts.join(' ');
}

function extractMetadata(html: string): string {
  const result: Record<string, string> = {};

  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleM) result['title'] = stripHtml(titleM[1]);

  const metaRe = /<meta[^>]+>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    const nameM = tag.match(/name=["'](\w[^"']*)["']/i);
    const contentM = tag.match(/content=["']([^"']*)["']/i);
    if (nameM && contentM) {
      result[nameM[1]] = contentM[1];
    }
    const propM = tag.match(/property=["'](og:[^"']*)["']/i);
    if (propM && contentM) {
      result[propM[1]] = contentM[1];
    }
  }

  return JSON.stringify(result, null, 2);
}

function extractSummary(body: string, contentType: string): string {
  const isHtml = /text\/html/i.test(contentType);
  if (!isHtml) {
    const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    return paragraphs.slice(0, 2).join('\n\n');
  }

  const parts: string[] = [];

  const headingM = body.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  if (headingM) {
    parts.push(stripHtml(headingM[1]).trim());
  }

  const paraM = body.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (paraM) {
    const text = stripHtml(paraM[1]).trim();
    if (text) parts.push(text);
  }

  const headingRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let hm: RegExpExecArray | null;
  const headings: string[] = [];
  while ((hm = headingRe.exec(body)) !== null) {
    const level = parseInt(hm[1], 10);
    const text = stripHtml(hm[2]).trim();
    if (text && !parts.includes(text)) {
      headings.push(`${'#'.repeat(level)} ${text}`);
    }
  }

  if (headings.length > 0) {
    parts.push('\nHeadings:\n' + headings.join('\n'));
  }

  return parts.join('\n\n') || extractReadable(body).slice(0, 500);
}

export function sniffContentType(contentType: string, body: string): string {
  const isMissing = !contentType || /application\/octet-stream/i.test(contentType);
  if (!isMissing) return contentType;

  const sample = body.slice(0, 512).trimStart();
  if (/^<!DOCTYPE\s+html/i.test(sample) || /^<html/i.test(sample)) {
    return 'text/html';
  }
  if (/^<\?xml/i.test(sample)) {
    return 'application/xml';
  }
  if (/^[{[]/.test(sample)) {
    return 'application/json';
  }
  return contentType;
}

export function applyExtract(
  body: string,
  contentType: string,
  mode: FetchExtractMode,
  opts?: { selectors?: string[] },
): string {
  const effectiveContentType = sniffContentType(contentType, body);
  const isHtml = /text\/html/i.test(effectiveContentType);

  switch (mode) {
    case 'raw':
      return body;
    case 'text':
      return isHtml ? stripHtml(body) : body;
    case 'json':
      try {
        return JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        return body;
      }
    case 'markdown':
      return isHtml ? htmlToMarkdown(body) : body;
    case 'readable':
      return isHtml ? extractReadable(body) : body;
    case 'code_blocks':
      return isHtml ? extractCodeBlocks(body) : body;
    case 'links':
      return isHtml ? extractLinks(body) : '';
    case 'metadata':
      return isHtml ? extractMetadata(body) : '{}';
    case 'structured': {
      const selectors = opts?.selectors ?? [];
      if (selectors.length === 0) return JSON.stringify([]);
      return isHtml ? extractStructured(body, selectors) : JSON.stringify([]);
    }
    case 'tables':
      return isHtml ? extractTables(body) : JSON.stringify([]);
    case 'pdf': {
      const isPdf = /application\/pdf/i.test(effectiveContentType);
      return isPdf ? extractPdf(body) : JSON.stringify({
        note: 'PDF extraction only applies to application/pdf responses.',
      });
    }
    case 'summary':
      return extractSummary(body, effectiveContentType);
    default:
      return body;
  }
}

