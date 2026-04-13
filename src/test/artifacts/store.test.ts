import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../../artifacts/index.ts';

describe('ArtifactStore', () => {
  const roots: string[] = [];

  afterEach(() => {
        while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  test('creates, lists, reloads, and reads stored artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-artifacts-'));
    roots.push(root);
    const sourcePath = join(root, 'report.md');
    writeFileSync(sourcePath, '# hello\n', 'utf-8');

    const store = new ArtifactStore({ rootDir: root });
    const created = await store.create({
      path: sourcePath,
      metadata: { purpose: 'test' },
    });

    expect(created.filename).toBe('report.md');
    expect(created.mimeType).toBe('text/markdown');
    expect(created.kind).toBe('document');
    expect(store.list()).toHaveLength(1);

    const attachment = await store.toAttachment({ artifactId: created.id }, { includeBase64IfSmallerThan: 1024 });
    expect(attachment.dataBase64).toBe(Buffer.from('# hello\n').toString('base64'));
    expect(attachment.contentPath).toBe(`/api/artifacts/${encodeURIComponent(created.id)}/content`);

        const reloaded = new ArtifactStore({ rootDir: root });
    const fetched = reloaded.get(created.id);
    expect(fetched?.sha256).toBe(created.sha256);

    const content = await reloaded.readContent(created.id);
    expect(content.buffer.toString('utf-8')).toBe('# hello\n');
  });

  test('stores inline text artifacts with inferred text metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-artifacts-'));
    roots.push(root);
    const store = new ArtifactStore({ rootDir: root });

    const created = await store.create({
      filename: 'notes.txt',
      text: 'plain text body',
    });

    expect(created.mimeType).toBe('text/plain');
    expect(created.kind).toBe('document');
    const { buffer } = await store.readContent(created.id);
    expect(buffer.toString('utf-8')).toBe('plain text body');
  });

  test('stores remote URI artifacts with SSRF-aware host policy and retention metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-artifacts-'));
    roots.push(root);
    const originalFetch = globalThis.fetch;
    const mockFetch = async (input: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe('https://example.com/artifact.md');
      expect(init?.method).toBe('GET');
      return new Response('# remote body\n', {
        headers: {
          'content-type': 'text/markdown',
          'content-disposition': 'attachment; filename="remote.md"',
        },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: originalFetch.preconnect.bind(originalFetch),
    }) as typeof fetch;

    try {
      const store = new ArtifactStore({ rootDir: root });

      const created = await store.create({
        uri: 'https://example.com/artifact.md',
        retentionMs: 1_000,
      });

      expect(created.filename).toBe('remote.md');
      expect(created.mimeType).toBe('text/markdown');
      expect(created.sourceUri).toContain('/artifact.md');
      expect(created.expiresAt).toBeGreaterThan(created.createdAt);
      const { buffer } = await store.readContent(created.id);
      expect(buffer.toString('utf-8')).toBe('# remote body\n');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('blocks remote URI artifacts that match SSRF policy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-artifacts-'));
    roots.push(root);
    const store = new ArtifactStore({ rootDir: root });
    await expect(store.create({
      uri: 'http://127.0.0.1:12345/private',
    })).rejects.toThrow('Artifact URI blocked by SSRF policy');
  });

  test('requires config opt-in before allowing private-host remote fetches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-artifacts-'));
    roots.push(root);
    const store = new ArtifactStore({
      rootDir: root,
      configManager: {
        get(key: string): unknown {
          return key === 'network.remoteFetch.allowPrivateHosts' ? false : undefined;
        },
      },
    });
    await expect(store.create({
      uri: 'http://127.0.0.1:12345/private',
      allowPrivateHosts: true,
    })).rejects.toThrow('Private-host remote artifact fetches are disabled by config.');
  });

  test('allows explicit private-host remote fetches when config enables them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-artifacts-'));
    roots.push(root);
    const originalFetch = globalThis.fetch;
    const mockFetch = async (input: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe('http://127.0.0.1:12345/private');
      expect(init?.method).toBe('GET');
      return new Response('private data', {
        headers: {
          'content-type': 'text/plain',
          'content-disposition': 'attachment; filename="private.txt"',
        },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: originalFetch.preconnect.bind(originalFetch),
    }) as typeof fetch;

    try {
      const store = new ArtifactStore({
        rootDir: root,
        configManager: {
          get(key: string): unknown {
            return key === 'network.remoteFetch.allowPrivateHosts' ? true : undefined;
          },
        },
      });
      const artifact = await store.create({
        uri: 'http://127.0.0.1:12345/private',
        allowPrivateHosts: true,
      });
      const { buffer } = await store.readContent(artifact.id);
      expect(artifact.filename).toBe('private.txt');
      expect(buffer.toString('utf-8')).toBe('private data');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('requires an explicit storage root or config directory owner', () => {
    expect(() => new ArtifactStore({})).toThrow(
      'ArtifactStore requires an explicit rootDir or configManager.getControlPlaneConfigDir().',
    );
  });
});
