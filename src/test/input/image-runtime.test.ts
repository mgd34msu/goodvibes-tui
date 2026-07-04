// ---------------------------------------------------------------------------
// image-runtime.test.ts — /imagine
//
// Pure command-layer test: fake MediaProviderRegistry + ArtifactStore on
// ctx.platform (no real network calls, no real filesystem writes),
// following the project's existing runtime-command test pattern (see
// workstream-runtime-command.test.ts's makeCtx()). Exercises: the
// providers/store-absent guard, empty-prompt usage message, honest
// unconfigured-provider status rendering, the inline-bytes persistence path,
// the remote-reference (no eager download) path, and honest failure
// rendering when generate() throws.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { registerImageRuntimeCommands } from '../../input/commands/image-runtime.ts';

interface FakeGenerateResult {
  providerId: string;
  artifacts: Array<{ mimeType: string; dataBase64?: string; uri?: string; filename?: string; metadata: Record<string, unknown> }>;
  metadata: Record<string, unknown>;
}

function makeFakeProvider(options: {
  label?: string;
  generateResult?: FakeGenerateResult;
  throwError?: Error;
} = {}) {
  const calls: unknown[] = [];
  return {
    id: 'fake-gen',
    label: options.label ?? 'Fake Generator',
    capabilities: ['generate'] as const,
    generate: async (request: unknown) => {
      calls.push(request);
      if (options.throwError) throw options.throwError;
      return options.generateResult ?? {
        providerId: 'fake-gen',
        artifacts: [{ mimeType: 'image/png', dataBase64: 'ZmFrZS1ieXRlcw==', filename: 'out.png', metadata: {} }],
        metadata: {},
      };
    },
    calls,
  };
}

function makeFakeMediaProviders(provider: ReturnType<typeof makeFakeProvider> | null, statuses: Array<{ id: string; label: string; state: string; capabilities: string[]; configured: boolean; detail?: string }> = []) {
  return {
    findProvider: (_capability: string) => provider,
    status: async () => statuses,
  };
}

function makeFakeArtifactStore() {
  const created: Array<Record<string, unknown>> = [];
  let nextId = 1;
  return {
    created,
    create: async (input: Record<string, unknown>) => {
      created.push(input);
      const id = `artifact-${nextId++}`;
      return {
        id,
        kind: 'file',
        mimeType: input['mimeType'] as string,
        filename: input['filename'] as string | undefined,
        sizeBytes: typeof input['dataBase64'] === 'string' ? Buffer.from(input['dataBase64'] as string, 'base64').length : (input['text'] as string | undefined)?.length ?? 0,
        sha256: 'fake-sha',
        createdAt: Date.now(),
        acquisitionMode: 'inline-data',
        fetchMode: 'not-applicable',
        metadata: input['metadata'] ?? {},
      };
    },
  };
}

function makeCtx(mediaProviders?: ReturnType<typeof makeFakeMediaProviders>, artifactStore?: ReturnType<typeof makeFakeArtifactStore>) {
  const printed: string[] = [];
  const ctx = {
    print: (text: string) => { printed.push(text); },
    session: {},
    workspace: {},
    provider: {},
    platform: { mediaProviders, artifactStore },
    ops: {},
    extensions: {},
  } as unknown as CommandContext;
  return { ctx, printed };
}

describe('/imagine command registration', () => {
  test('registers /imagine', () => {
    const registry = new CommandRegistry();
    registerImageRuntimeCommands(registry);
    expect(registry.get('imagine')).toBeDefined();
  });
});

describe('/imagine — honest degradation', () => {
  test('prints an honest message when mediaProviders/artifactStore are not available', async () => {
    const registry = new CommandRegistry();
    registerImageRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(undefined, undefined);

    await registry.execute('imagine', ['a', 'cat'], ctx);

    expect(printed).toEqual(['Image generation is not available in this session.']);
  });

  test('prints usage when no prompt is given', async () => {
    const registry = new CommandRegistry();
    registerImageRuntimeCommands(registry);
    const mediaProviders = makeFakeMediaProviders(makeFakeProvider());
    const artifactStore = makeFakeArtifactStore();
    const { ctx, printed } = makeCtx(mediaProviders, artifactStore);

    await registry.execute('imagine', [], ctx);

    expect(printed).toEqual(['Usage: /imagine <prompt>']);
  });

  test('prints the registry\'s own per-provider status when no generate-capable provider is found', async () => {
    const registry = new CommandRegistry();
    registerImageRuntimeCommands(registry);
    const mediaProviders = makeFakeMediaProviders(null, [
      { id: 'byteplus', label: 'BytePlus', state: 'unconfigured', capabilities: ['generate'], configured: false, detail: 'Set BYTEPLUS_API_KEY to enable BytePlus video generation.' },
      { id: 'fal', label: 'fal', state: 'unconfigured', capabilities: ['generate'], configured: false, detail: 'Set FAL_KEY or FAL_API_KEY to enable fal generation.' },
    ]);
    const artifactStore = makeFakeArtifactStore();
    const { ctx, printed } = makeCtx(mediaProviders, artifactStore);

    await registry.execute('imagine', ['a', 'cat'], ctx);

    const text = printed.join('\n');
    expect(text).toContain('No image-generation provider is configured.');
    expect(text).toContain('byteplus (BytePlus): unconfigured');
    expect(text).toContain('Set BYTEPLUS_API_KEY to enable BytePlus video generation.');
    expect(text).toContain('fal (fal): unconfigured');
    expect(text).toContain('Set FAL_KEY or FAL_API_KEY to enable fal generation.');
  });

  test('states plainly when no media-generation providers are registered at all', async () => {
    const registry = new CommandRegistry();
    registerImageRuntimeCommands(registry);
    const mediaProviders = makeFakeMediaProviders(null, []);
    const artifactStore = makeFakeArtifactStore();
    const { ctx, printed } = makeCtx(mediaProviders, artifactStore);

    await registry.execute('imagine', ['a', 'cat'], ctx);

    expect(printed.join('\n')).toContain('No media-generation providers are registered in this build.');
  });

  test('renders a failure message from a thrown error', async () => {
    const registry = new CommandRegistry();
    registerImageRuntimeCommands(registry);
    const provider = makeFakeProvider({ throwError: new Error('provider API rejected the request') });
    const mediaProviders = makeFakeMediaProviders(provider);
    const artifactStore = makeFakeArtifactStore();
    const { ctx, printed } = makeCtx(mediaProviders, artifactStore);

    await registry.execute('imagine', ['a', 'cat'], ctx);

    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('Image generation failed:');
    expect(printed[0]).toContain('provider API rejected the request');
  });
});

describe('/imagine — success paths', () => {
  test('persists an inline-bytes artifact and renders its id', async () => {
    const registry = new CommandRegistry();
    registerImageRuntimeCommands(registry);
    const provider = makeFakeProvider();
    const mediaProviders = makeFakeMediaProviders(provider);
    const artifactStore = makeFakeArtifactStore();
    const { ctx, printed } = makeCtx(mediaProviders, artifactStore);

    await registry.execute('imagine', ['a', 'cat', 'wearing', 'a', 'hat'], ctx);

    expect(provider.calls).toHaveLength(1);
    expect((provider.calls[0] as { prompt: string }).prompt).toBe('a cat wearing a hat');
    expect(artifactStore.created).toHaveLength(1);
    expect(artifactStore.created[0]!['dataBase64']).toBe('ZmFrZS1ieXRlcw==');
    const text = printed.join('\n');
    expect(text).toContain('Generated 1 artifact(s) via Fake Generator (fake-gen)');
    expect(text).toContain('artifact: artifact-1');
  });

  test('stores a remote artifact as a reference without eager download', async () => {
    const registry = new CommandRegistry();
    registerImageRuntimeCommands(registry);
    const provider = makeFakeProvider({
      generateResult: {
        providerId: 'fake-gen',
        artifacts: [{ mimeType: 'image/png', uri: 'https://provider.example/out.png', filename: 'out.png', metadata: {} }],
        metadata: {},
      },
    });
    const mediaProviders = makeFakeMediaProviders(provider);
    const artifactStore = makeFakeArtifactStore();
    const { ctx, printed } = makeCtx(mediaProviders, artifactStore);

    await registry.execute('imagine', ['a', 'cat'], ctx);

    expect(artifactStore.created).toHaveLength(1);
    const stored = artifactStore.created[0]!;
    // Reference path uses `text` + `sourceUri`, never `uri` (which would trigger
    // ArtifactStore's own eager-fetch codepath for the referenced media itself).
    expect(stored['uri']).toBeUndefined();
    expect(stored['sourceUri']).toBe('https://provider.example/out.png');
    expect(typeof stored['text']).toBe('string');
    expect(JSON.parse(stored['text'] as string)).toMatchObject({ remoteUrl: 'https://provider.example/out.png' });

    const text = printed.join('\n');
    expect(text).toContain('remote reference — not downloaded');
    expect(text).toContain('url: https://provider.example/out.png');
  });

  test('notes honestly when the found provider produced a non-image artifact', async () => {
    const registry = new CommandRegistry();
    registerImageRuntimeCommands(registry);
    const provider = makeFakeProvider({
      label: 'BytePlus',
      generateResult: {
        providerId: 'byteplus',
        artifacts: [{ mimeType: 'video/mp4', dataBase64: 'ZmFrZQ==', filename: 'out.mp4', metadata: {} }],
        metadata: {},
      },
    });
    const mediaProviders = makeFakeMediaProviders(provider);
    const artifactStore = makeFakeArtifactStore();
    const { ctx, printed } = makeCtx(mediaProviders, artifactStore);

    await registry.execute('imagine', ['a', 'cat'], ctx);

    const text = printed.join('\n');
    expect(text).toContain('BytePlus produced video/mp4, not an image');
  });
});
