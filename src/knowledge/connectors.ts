import { parseBookmarkSeeds } from './bookmarks.ts';
import type {
  KnowledgeBookmarkSeed,
  KnowledgeConnector,
  KnowledgeConnectorDoctorReport,
  KnowledgeConnectorParseResult,
} from './types.ts';

function cloneSeed(seed: KnowledgeBookmarkSeed): KnowledgeBookmarkSeed {
  return {
    url: seed.url,
    ...(seed.title ? { title: seed.title } : {}),
    ...(seed.folderPath ? { folderPath: seed.folderPath } : {}),
    ...(seed.tags?.length ? { tags: [...seed.tags] } : {}),
    ...(seed.metadata ? { metadata: { ...seed.metadata } } : {}),
  };
}

function normalizeSingleSeed(input: unknown): KnowledgeBookmarkSeed {
  if (typeof input === 'string' && /^https?:\/\//i.test(input.trim())) {
    return { url: input.trim() };
  }
  if (!input || typeof input !== 'object') {
    throw new Error('Connector expects a URL string or an object containing a url field.');
  }
  const record = input as Record<string, unknown>;
  const url = typeof record.url === 'string' ? record.url.trim() : '';
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Connector input must include an http(s) url.');
  }
  const title = typeof record.title === 'string' ? record.title.trim() : undefined;
  const folderPath = typeof record.folderPath === 'string' ? record.folderPath.trim() : undefined;
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
    : undefined;
  const metadata = typeof record.metadata === 'object' && record.metadata !== null
    ? record.metadata as Record<string, unknown>
    : undefined;
  return {
    url,
    ...(title ? { title } : {}),
    ...(folderPath ? { folderPath } : {}),
    ...(tags?.length ? { tags } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function cloneResult(connector: KnowledgeConnector, result: KnowledgeConnectorParseResult): KnowledgeConnectorParseResult {
  return {
    connectorId: result.connectorId ?? connector.id,
    sourceType: result.sourceType ?? connector.sourceType,
    seeds: result.seeds.map((seed) => cloneSeed(seed)),
  };
}

function defaultDoctor(connector: KnowledgeConnector, detail: string): KnowledgeConnectorDoctorReport {
  return {
    connectorId: connector.id,
    ready: true,
    summary: detail,
    checks: [{
      id: 'builtin-ready',
      label: 'Built-in connector available',
      status: 'pass',
      detail,
    }],
    hints: [],
    metadata: {
      sourceType: connector.sourceType,
    },
  };
}

export class KnowledgeConnectorRegistry {
  private readonly connectors = new Map<string, KnowledgeConnector>();

  register(connector: KnowledgeConnector, options: { replace?: boolean } = {}): void {
    if (!options.replace && this.connectors.has(connector.id)) {
      throw new Error(`Knowledge connector already registered: ${connector.id}`);
    }
    this.connectors.set(connector.id, connector);
  }

  get(id: string): KnowledgeConnector | undefined {
    return this.connectors.get(id);
  }

  list(): KnowledgeConnector[] {
    return [...this.connectors.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async resolve(id: string, input: unknown): Promise<KnowledgeConnectorParseResult> {
    const connector = this.connectors.get(id);
    if (!connector) throw new Error(`Unknown knowledge connector: ${id}`);
    return cloneResult(connector, await connector.resolve(input));
  }

  async doctor(id: string): Promise<KnowledgeConnectorDoctorReport | null> {
    const connector = this.connectors.get(id);
    if (!connector) return null;
    if (connector.doctor) return connector.doctor();
    return defaultDoctor(connector, `${connector.description} No additional setup is required.`);
  }
}

export function createDefaultKnowledgeConnectorRegistry(): KnowledgeConnectorRegistry {
  const registry = new KnowledgeConnectorRegistry();

  registry.register({
    id: 'url',
    displayName: 'Direct URL',
    version: '1',
    description: 'Ingest a single URL or normalized URL seed.',
    sourceType: 'url',
    capabilities: ['single-url', 'http-fetch', 'artifact-snapshot'],
    inputSchema: {
      anyOf: [
        { type: 'string', format: 'uri' },
        {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri' },
            title: { type: 'string' },
            folderPath: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            metadata: { type: 'object', additionalProperties: true },
          },
          required: ['url'],
          additionalProperties: true,
        },
      ],
    },
    examples: [
      'https://goodvibes.sh/docs',
      {
        url: 'https://goodvibes.sh/docs',
        title: 'GoodVibes Docs',
        tags: ['docs', 'goodvibes'],
      },
    ],
    metadata: {
      accepts: ['inline-url', 'json-object'],
      transportHints: ['inline'],
    },
    setup: {
      version: '1',
      summary: 'Accepts direct HTTP(S) URLs with no connector-side setup.',
      steps: ['Provide a URL string or an object with `url`, optional metadata, and optional tags.'],
      fields: [{
        key: 'url',
        label: 'URL',
        kind: 'uri',
      }],
      metadata: {
        auth: 'none',
      },
    },
    resolve(input) {
      return {
        seeds: [normalizeSingleSeed(input)],
      };
    },
    doctor(this: KnowledgeConnector) {
      return defaultDoctor(this, 'Direct URL ingest is ready. No external configuration is required.');
    },
  });

  registry.register({
    id: 'bookmark',
    displayName: 'Bookmarks Import',
    version: '1',
    description: 'Parse bookmark exports or bookmark-like JSON into bookmark seeds.',
    sourceType: 'bookmark',
    capabilities: ['bookmark-export', 'netscape-html', 'bookmark-json'],
    inputSchema: {
      type: 'string',
      description: 'Bookmark export content such as Netscape bookmark HTML or bookmark-like JSON.',
    },
    examples: [
      '<!DOCTYPE NETSCAPE-Bookmark-file-1>...',
    ],
    metadata: {
      accepts: ['inline-content', 'file-content'],
      preferredContentType: 'text/html',
      transportHints: ['content', 'path'],
    },
    setup: {
      version: '1',
      summary: 'Imports bookmark export files or bookmark-like JSON payloads.',
      steps: [
        'Export bookmarks from a browser as Netscape-style HTML or supply bookmark-like JSON.',
        'Send the content directly or provide a file path to the ingest endpoint.',
      ],
      fields: [{
        key: 'content',
        label: 'Bookmark Content',
        kind: 'text',
      }],
      metadata: {
        auth: 'none',
      },
    },
    resolve(input) {
      if (typeof input !== 'string') {
        throw new Error('Bookmark connector expects file contents as a string.');
      }
      return {
        seeds: parseBookmarkSeeds(input),
      };
    },
    doctor(this: KnowledgeConnector) {
      return defaultDoctor(this, 'Bookmark import is ready. Exported bookmark HTML or JSON content can be ingested directly.');
    },
  });

  registry.register({
    id: 'url-list',
    displayName: 'URL List',
    version: '1',
    description: 'Parse plain URL lists into bookmark-list seeds.',
    sourceType: 'bookmark-list',
    capabilities: ['line-delimited-urls', 'bulk-url-ingest'],
    inputSchema: {
      type: 'string',
      description: 'Plain text content containing one URL per line.',
    },
    examples: [
      'https://goodvibes.sh/docs\nhttps://example.com/research',
    ],
    metadata: {
      accepts: ['inline-content', 'file-content'],
      preferredContentType: 'text/plain',
      transportHints: ['content', 'path'],
    },
    setup: {
      version: '1',
      summary: 'Accepts plain text content containing one URL per line.',
      steps: ['Provide inline content or a text file path.'],
      fields: [{
        key: 'content',
        label: 'URL List',
        kind: 'text',
      }],
      metadata: {
        auth: 'none',
      },
    },
    resolve(input) {
      if (typeof input !== 'string') {
        throw new Error('URL list connector expects file contents as a string.');
      }
      return {
        sourceType: 'bookmark-list',
        seeds: parseBookmarkSeeds(input).map((seed) => ({
          ...cloneSeed(seed),
          folderPath: undefined,
        })),
      };
    },
    doctor(this: KnowledgeConnector) {
      return defaultDoctor(this, 'URL list import is ready. No external configuration is required.');
    },
  });

  return registry;
}
