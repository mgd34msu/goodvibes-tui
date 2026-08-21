/**
 * Tests for the embedding-provider Enter-commit branch added to
 * handleModelPickerToken, the model picker's 'embeddingProvider' mode
 * commits through commandContext.completeEmbeddingProviderSelection, never
 * through completeModelSelection (which is ModelDefinition-shaped and would
 * require fabricating a fake model object for an embedding provider).
 */
import { describe, expect, test } from 'bun:test';
import { handleModelPickerToken } from '../../input/handler-picker-routes.ts';
import { ModelPickerModal } from '../../input/model-picker.ts';

function makePicker(): ModelPickerModal {
  return new ModelPickerModal(
    { getRecentModels: async () => [] },
    { getBenchmarks: () => undefined },
    { getSyntheticModelInfoFromCatalog: () => null, getSyntheticCanonicalModels: () => [] },
  );
}

const ENTER = { type: 'key' as const, name: 'return', logicalName: 'enter', ctrl: false, shift: false, meta: false };

describe('handleModelPickerToken: embeddingProvider mode', () => {
  test('Enter commits the selected embedding provider via completeEmbeddingProviderSelection', () => {
    const picker = makePicker();
    picker.openEmbeddingProviders([
      { id: 'hashed-local', label: 'Hashed Local Embeddings', dimensions: 384, configured: true },
      { id: 'openai', label: 'OpenAI Embeddings', dimensions: 1536, configured: false, detail: 'Set OPENAI_API_KEY.' },
    ], 'hashed-local');
    picker.focusItems();
    picker.selectedIndex = 1; // openai

    const committed: string[] = [];
    const state = {
      modelPicker: picker,
      modalStack: ['modelPicker'],
      commandContext: {
        completeEmbeddingProviderSelection: (id: string) => { committed.push(id); },
      } as never,
      getViewportHeight: () => 30,
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleModelPickerToken(state, ENTER);

    expect(committed).toEqual(['openai']);
    expect(picker.active).toBe(false); // picker closes after commit
    expect(state.modalStack).toHaveLength(0);
  });

  test('Enter never calls completeModelSelection for an embedding-provider commit', () => {
    const picker = makePicker();
    picker.openEmbeddingProviders([
      { id: 'hashed-local', label: 'Hashed Local Embeddings', dimensions: 384, configured: true },
    ], 'hashed-local');
    picker.focusItems();

    let modelSelectionCalls = 0;
    const state = {
      modelPicker: picker,
      modalStack: ['modelPicker'],
      commandContext: {
        completeModelSelection: () => { modelSelectionCalls += 1; },
        completeEmbeddingProviderSelection: () => {},
      } as never,
      getViewportHeight: () => 30,
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleModelPickerToken(state, ENTER);

    expect(modelSelectionCalls).toBe(0);
  });

  test('Enter on an empty embedding-provider list is a no-op commit but still closes the picker', () => {
    const picker = makePicker();
    picker.openEmbeddingProviders([], 'hashed-local');
    picker.focusItems();

    const committed: string[] = [];
    const state = {
      modelPicker: picker,
      modalStack: ['modelPicker'],
      commandContext: {
        completeEmbeddingProviderSelection: (id: string) => { committed.push(id); },
      } as never,
      getViewportHeight: () => 30,
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleModelPickerToken(state, ENTER);

    expect(committed).toEqual([]);
    expect(picker.active).toBe(false);
  });
});
