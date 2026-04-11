import { describe, expect, test } from 'bun:test';
import {
  createDefaultKnowledgeConnectorRegistry,
  KnowledgeConnectorRegistry,
} from '../../knowledge/index.ts';

describe('KnowledgeConnectorRegistry', () => {
  test('default connectors parse URL, bookmark export, and URL-list inputs', async () => {
    const registry = createDefaultKnowledgeConnectorRegistry();

    const single = await registry.resolve('url', {
      url: 'https://example.com/docs',
      title: 'Docs',
      tags: ['docs'],
    });
    expect(single.sourceType).toBe('url');
    expect(single.seeds).toHaveLength(1);
    expect(single.seeds[0]?.url).toBe('https://example.com/docs');

    const bookmarks = await registry.resolve('bookmark', `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3>Reading</H3>
  <DL><p>
    <DT><A HREF="https://example.com/typescript">TypeScript</A>
  </DL><p>
</DL><p>`);
    expect(bookmarks.sourceType).toBe('bookmark');
    expect(bookmarks.seeds[0]?.folderPath).toBe('Reading');

    const urlList = await registry.resolve('url-list', 'https://example.com/one\nhttps://example.com/two');
    expect(urlList.sourceType).toBe('bookmark-list');
    expect(urlList.seeds).toHaveLength(2);
    expect(urlList.seeds.every((seed) => !seed.folderPath)).toBe(true);
  });

  test('custom connectors can be registered without editing the core service', async () => {
    const registry = new KnowledgeConnectorRegistry();
    registry.register({
      id: 'bookmarks-jsonl',
      description: 'Parse bookmark lines from JSONL.',
      sourceType: 'bookmark',
      resolve(input) {
        const lines = String(input)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        return {
          seeds: lines.map((line) => {
            const record = JSON.parse(line) as { url: string; folder?: string };
            return {
              url: record.url,
              folderPath: record.folder,
            };
          }),
        };
      },
    });

    const resolved = await registry.resolve('bookmarks-jsonl', '{"url":"https://example.com/a","folder":"Reading"}');
    expect(resolved.sourceType).toBe('bookmark');
    expect(resolved.seeds).toEqual([{ url: 'https://example.com/a', folderPath: 'Reading' }]);
  });

  test('built-in connectors expose setup and doctor metadata', async () => {
    const registry = createDefaultKnowledgeConnectorRegistry();
    const connector = registry.get('bookmark');
    const report = await registry.doctor('bookmark');

    expect(connector?.setup?.summary).toContain('Imports bookmark export files');
    expect(connector?.capabilities).toContain('bookmark-export');
    expect(report?.ready).toBe(true);
    expect(report?.checks[0]?.status).toBe('pass');
  });
});
