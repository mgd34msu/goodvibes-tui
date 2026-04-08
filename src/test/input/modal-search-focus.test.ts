import { describe, expect, test } from 'bun:test';
import { handleSelectionModalToken } from '../../input/handler-modal-routes.ts';
import { handleModelPickerToken } from '../../input/handler-picker-routes.ts';
import { SelectionModal } from '../../input/selection-modal.ts';
import { ModelPickerModal } from '../../input/model-picker.ts';

describe('modal search focus routing', () => {
  test('selection modal keeps typable custom actions active until search is focused', () => {
    const modal = new SelectionModal();
    const customActions = new Map([['d', 'delete' as const]]);
    modal.open('Pick', [
      { id: 'one', label: 'One' },
      { id: 'two', label: 'Two' },
    ], { allowSearch: true, customActions });

    let result: { item: { id: string }; action: string } | null = null;
    const state = {
      selectionModal: modal,
      selectionCallback: (value: typeof result) => { result = value; },
      modalStack: [],
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleSelectionModalToken(state, { type: 'text', value: 'd' });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('delete');

    result = null;
    modal.open('Pick', [
      { id: 'one', label: 'One' },
      { id: 'two', label: 'Two' },
    ], { allowSearch: true, customActions });
    handleSelectionModalToken(state, { type: 'text', value: '/' });
    expect(modal.searchFocused).toBe(true);
    handleSelectionModalToken(state, { type: 'text', value: 'd' });
    expect(result).toBeNull();
    expect(modal.query).toBe('d');
  });

  test('selection modal moves into and out of search with up/down', () => {
    const modal = new SelectionModal();
    modal.open('Pick', [
      { id: 'one', label: 'One' },
      { id: 'two', label: 'Two' },
    ], { allowSearch: true });

    const state = {
      selectionModal: modal,
      selectionCallback: null,
      modalStack: [],
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleSelectionModalToken(state, { type: 'key', name: 'up', logicalName: 'up', ctrl: false, shift: false, meta: false });
    expect(modal.searchFocused).toBe(true);
    handleSelectionModalToken(state, { type: 'key', name: 'down', logicalName: 'down', ctrl: false, shift: false, meta: false });
    expect(modal.searchFocused).toBe(false);
    expect(modal.selectedIndex).toBe(0);
  });

  test('model picker keeps group hotkey active until search is focused', () => {
    const picker = new ModelPickerModal();
    picker.openAllModels([
      {
        id: 'gpt-1',
        provider: 'openai',
        registryKey: 'openai:gpt-1',
        displayName: 'GPT 1',
        description: '',
        capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
        contextWindow: 8192,
        selectable: true,
        tier: 'premium',
      },
    ], 'gpt-1');

    const state = {
      modelPicker: picker,
      modalStack: [],
      commandContext: undefined,
      getViewportHeight: () => 30,
      requestRender: () => {},
      handleEscape: () => {},
    };

    expect(picker.groupBy).toBe('provider');
    handleModelPickerToken(state, { type: 'text', value: 'g' });
    expect(picker.groupBy).toBe('family');

    handleModelPickerToken(state, { type: 'text', value: '/' });
    expect(picker.searchFocused).toBe(true);
    handleModelPickerToken(state, { type: 'text', value: 'g' });
    expect(picker.groupBy).toBe('family');
    expect(picker.query).toBe('g');
  });
});
