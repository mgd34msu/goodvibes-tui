/**
 * The model picker opens at once on the cached catalog and fills in the slow
 * reads (credential sources, embedding providers, the live model re-check)
 * afterwards, with a muted "loading catalog…" row meanwhile. The open never
 * waits on those reads.
 */
import { describe, expect, test } from 'bun:test';
import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers';
import { ModelPickerModal, type EmbeddingProviderPickerEntry, type ModelPickerTargetInfo } from '../../input/model-picker.ts';
import { openModelPickerNow, type ModelPickerOpenDeps } from '../../input/model-picker-open.ts';
import { renderModelWorkspace } from '../../renderer/model-workspace.ts';
import { frameFromLayer } from '../helpers/surface-frame.ts';
import { linesToText } from '../setup.ts';

function model(id: string, provider: string, displayName: string): ModelDefinition {
  return {
    id, provider, displayName, registryKey: `${provider}:${id}`, description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 128_000, selectable: true, tier: 'premium',
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function makePicker(): ModelPickerModal {
  return new ModelPickerModal(
    { getRecentModels: async () => [] },
    { getBenchmarks: () => undefined },
    { getSyntheticModelInfoFromCatalog: () => null, getSyntheticCanonicalModels: () => [] },
  );
}

const target: ModelPickerTargetInfo = { target: 'main', label: 'Main Chat', description: '', provider: 'openai', model: 'openai:gpt-a', enabled: true, inherited: false };

function setup() {
  const picker = makePicker();
  const secrets = deferred<ReadonlySet<string>>();
  const embedding = deferred<EmbeddingProviderPickerEntry[]>();
  const live = deferred<boolean>();
  let catalog: ModelDefinition[] = [model('gpt-a', 'openai', 'GPT A'), model('claude-b', 'anthropic', 'Claude B')];
  const events: string[] = [];
  const deps: ModelPickerOpenDeps = {
    picker,
    modalOpened: () => events.push('opened'),
    render: () => events.push('render'),
    listModels: () => catalog,
    listProviders: () => [...new Set(catalog.map((m) => m.provider))],
    currentModelId: () => 'gpt-a',
    currentProviderId: () => 'openai',
    configuredProviderIds: () => new Set(['openai', 'anthropic', 'moonshot']),
    buildConfiguredVia: (ids, _configured, secretIds) => new Map(ids.map((id) => [id, secretIds.has(id) ? 'secrets' : 'env'] as const)),
    buildTargets: () => [target],
    resolveSecretProviderIds: () => secrets.promise,
    resolveEmbeddingProviders: () => embedding.promise,
    refreshLiveModels: () => live.promise,
    onError: (error) => events.push(`error:${String(error)}`),
  };
  return { picker, deps, secrets, embedding, live, events, setCatalog: (next: ModelDefinition[]) => { catalog = next; } };
}

const screen = (picker: ModelPickerModal): string => linesToText(frameFromLayer(renderModelWorkspace(picker, 132, 34), 132, 34)).join('\n');

describe('openModelPickerNow', () => {
  test('the modal is open and visible before any slow read resolves, with a loading row', () => {
    const { picker, deps, events } = setup();
    void openModelPickerNow(deps);
    // Synchronously after the call: opened, rendered, rows from the cached catalog.
    expect(picker.active).toBe(true);
    expect(events.slice(0, 2)).toEqual(['opened', 'render']);
    expect(picker.catalogLoading).toBe(true);
    const text = screen(picker);
    expect(text).toContain('GPT A');
    expect(text).toContain('Claude B');
    expect(text).toContain('loading catalog…');
  });

  test('rows fill in when the reads land, the selection stays put, and the loading row goes', async () => {
    const { picker, deps, secrets, embedding, live, setCatalog } = setup();
    const done = openModelPickerNow(deps);
    picker.selectedIndex = picker.getFilteredModels().findIndex((m) => m.id === 'claude-b');
    secrets.resolve(new Set(['anthropic']));
    embedding.resolve([{ id: 'local', label: 'Local embeddings', dimensions: 384, configured: true }]);
    setCatalog([model('gpt-a', 'openai', 'GPT A'), model('claude-b', 'anthropic', 'Claude B'), model('kimi-c', 'moonshot', 'Kimi C')]);
    live.resolve(true);
    await done;
    expect(picker.catalogLoading).toBe(false);
    expect(picker.configuredViaMap.get('anthropic')).toBe('secrets');
    expect(picker.embeddingProviders.map((p) => p.id)).toEqual(['local']);
    expect(picker.getFilteredModels()[picker.selectedIndex]!.id).toBe('claude-b');
    const text = screen(picker);
    expect(text).toContain('Kimi C');
    expect(text).not.toContain('loading catalog…');
  });

  test('closing the picker before the reads land drops them', async () => {
    const { picker, deps, secrets, embedding, live } = setup();
    const done = openModelPickerNow(deps);
    picker.close();
    secrets.resolve(new Set(['anthropic']));
    embedding.resolve([]);
    live.resolve(false);
    await done;
    expect(picker.active).toBe(false);
    expect(picker.configuredViaMap.get('anthropic')).not.toBe('secrets');
    expect(picker.catalogLoading).toBe(false);
  });

  test('a failed read reports once and clears the loading row; the picker stays usable', async () => {
    const { picker, deps, embedding, live, events } = setup();
    const done = openModelPickerNow({ ...deps, resolveSecretProviderIds: () => Promise.reject(new Error('keyring locked')) });
    embedding.resolve([]);
    live.resolve(false);
    await done;
    expect(picker.active).toBe(true);
    expect(picker.catalogLoading).toBe(false);
    expect(events.filter((e) => e.startsWith('error:'))).toEqual(['error:Error: keyring locked']);
    expect(screen(picker)).toContain('GPT A');
  });

  test('the provider list opens the same way', () => {
    const { picker, deps } = setup();
    void openModelPickerNow(deps, 'providers');
    expect(picker.mode).toBe('provider');
    expect(picker.catalogLoading).toBe(true);
    expect(screen(picker)).toContain('loading catalog…');
  });
});
