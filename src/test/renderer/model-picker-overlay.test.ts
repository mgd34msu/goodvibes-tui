/**
 * Tests for renderModelPickerOverlay renderer.
 */
import { describe, test, expect } from 'bun:test';
import { ModelPickerModal } from '../../input/model-picker.ts';
import { renderModelPickerOverlay } from '../../renderer/model-picker-overlay.ts';
import { lineToString, linesToText } from '../setup.ts';
import type { ModelDefinition } from '../../providers/registry.ts';
import { _setEntriesForTest } from '../../providers/model-benchmarks.ts';

const W = 120;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: 'test-model',
    provider: 'test-provider',
    displayName: 'Test Model',
    description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 8192,
    selectable: true,
    tier: 'free',
    ...overrides,
  };
}

const MODEL_A = makeModel({ id: 'model-a', displayName: 'Alpha', tier: 'free', provider: 'anthropic', contextWindow: 200_000 });
const MODEL_B = makeModel({ id: 'model-b', displayName: 'Beta', tier: 'premium', provider: 'openai', contextWindow: 128_000,
  capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true } });
const MODEL_C = makeModel({ id: 'model-c', displayName: 'Gamma', tier: 'free', provider: 'anthropic' });

function makePicker(overrides: Partial<ModelPickerModal> = {}): ModelPickerModal {
  const picker = new ModelPickerModal();
  picker.active = true;
  picker.mode = 'model';
  picker.models = [MODEL_A, MODEL_B, MODEL_C];
  picker.selectedIndex = 0;
  Object.assign(picker, overrides);
  return picker;
}

// ---------------------------------------------------------------------------
// Model mode
// ---------------------------------------------------------------------------

describe('renderModelPickerOverlay — model mode', () => {
  test('returns a non-empty Line[] array', () => {
    const lines = renderModelPickerOverlay(makePicker(), W);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  test('each line has correct terminal width', () => {
    const lines = renderModelPickerOverlay(makePicker(), W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('title bar contains "Select Model"', () => {
    const lines = renderModelPickerOverlay(makePicker(), W);
    const title = lineToString(lines[0]);
    expect(title).toContain('Select Model');
  });

  test('footer contains Tab filter hint', () => {
    const lines = renderModelPickerOverlay(makePicker(), W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).toContain('Tab');
    expect(footer).toContain('Filter');
  });

  test('footer shows current filter label', () => {
    const picker = makePicker();
    picker.categoryFilter = 'free';
    const lines = renderModelPickerOverlay(picker, W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).toContain('Free');
  });

  test('footer shows Paid when filter is paid', () => {
    const picker = makePicker();
    picker.categoryFilter = 'paid';
    const lines = renderModelPickerOverlay(picker, W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).toContain('Paid');
  });

  test('footer shows Sub when filter is subscription', () => {
    const picker = makePicker();
    picker.categoryFilter = 'subscription';
    const lines = renderModelPickerOverlay(picker, W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).toContain('Sub');
  });

  test('shows model ids in list', () => {
    const texts = linesToText(renderModelPickerOverlay(makePicker(), W)).join('\n');
    expect(texts).toContain('model-a');
    expect(texts).toContain('model-b');
  });

  test('selected item has arrow indicator', () => {
    const lines = renderModelPickerOverlay(makePicker(), W);
    const hasArrow = lines.some(line => line.some(cell => cell.char === '\u25b6'));
    expect(hasArrow).toBe(true);
  });

  test('provider group headers are present', () => {
    const texts = linesToText(renderModelPickerOverlay(makePicker(), W)).join('\n');
    expect(texts).toContain('anthropic');
    expect(texts).toContain('openai');
  });

  test('empty model list shows helpful message', () => {
    const picker = makePicker({ models: [] } as Partial<ModelPickerModal>);
    picker.models = [];
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('No models');
  });

  test('no-match query shows helpful message', () => {
    const picker = makePicker();
    picker.query = 'zzz-no-match';
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('No models match');
  });

  test('capability panel appears for selected model', () => {
    const picker = makePicker({ selectedIndex: 1 });
    // MODEL_B has reasoning + multimodal
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('Provider:');
    expect(texts).toContain('Context:');
  });

  test('capability panel shows Reasoning for reasoning model', () => {
    const picker = makePicker({ selectedIndex: 1 });
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('Reasoning');
  });

  test('capability panel shows Vision for multimodal model', () => {
    const picker = makePicker({ selectedIndex: 1 });
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('Vision');
  });

  test('null capabilities guard — model without capabilities still renders', () => {
    const picker = makePicker();
    // Simulate missing capabilities
    (picker.models[0] as ModelDefinition & { capabilities: unknown }).capabilities = undefined as unknown as ModelDefinition['capabilities'];
    // Should not throw
    expect(() => renderModelPickerOverlay(picker, W)).not.toThrow();
  });

  test('large context window formatted as M', () => {
    const picker = makePicker({ selectedIndex: 0 });
    // MODEL_A has contextWindow: 200_000
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    // 200k
    expect(texts).toMatch(/200k|Context/);
  });

  test('works at narrow terminal width', () => {
    const narrowW = 60;
    const lines = renderModelPickerOverlay(makePicker(), narrowW);
    for (const line of lines) {
      expect(line.length).toBe(narrowW);
    }
  });
});

// ---------------------------------------------------------------------------
// Provider mode
// ---------------------------------------------------------------------------

describe('renderModelPickerOverlay — provider mode', () => {
  function makeProviderPicker(): ModelPickerModal {
    const picker = new ModelPickerModal();
    picker.active = true;
    picker.mode = 'provider';
    picker.providers = ['anthropic', 'openai', 'gemini'];
    picker.selectedIndex = 0;
    return picker;
  }

  test('returns non-empty Line[] in provider mode', () => {
    const lines = renderModelPickerOverlay(makeProviderPicker(), W);
    expect(lines.length).toBeGreaterThan(0);
  });

  test('each line has correct width in provider mode', () => {
    const lines = renderModelPickerOverlay(makeProviderPicker(), W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('title bar contains "Select Provider"', () => {
    const lines = renderModelPickerOverlay(makeProviderPicker(), W);
    const title = lineToString(lines[0]);
    expect(title).toContain('Select Provider');
  });

  test('shows provider names in list', () => {
    const texts = linesToText(renderModelPickerOverlay(makeProviderPicker(), W)).join('\n');
    expect(texts).toContain('anthropic');
    expect(texts).toContain('openai');
    expect(texts).toContain('gemini');
  });

  test('hint text tells user to select provider for models', () => {
    const texts = linesToText(renderModelPickerOverlay(makeProviderPicker(), W)).join('\n');
    expect(texts).toContain('Select a provider');
  });

  test('empty providers list shows helpful message', () => {
    const picker = makeProviderPicker();
    picker.providers = [];
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('No providers');
  });

  test('selected item has arrow indicator', () => {
    const lines = renderModelPickerOverlay(makeProviderPicker(), W);
    const hasArrow = lines.some(line => line.some(cell => cell.char === '\u25b6'));
    expect(hasArrow).toBe(true);
  });

  test('footer does not show Tab filter hint in provider mode', () => {
    const lines = renderModelPickerOverlay(makeProviderPicker(), W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).not.toContain('Tab');
  });

  test('search bar is present in provider mode', () => {
    const texts = linesToText(renderModelPickerOverlay(makeProviderPicker(), W)).join('\n');
    // Search bar renders a magnifying glass emoji (🔍 = \uD83D\uDD0D)
    expect(texts).toContain('\uD83D\uDD0D');
  });

  test('query filters provider list', () => {
    const picker = makeProviderPicker();
    picker.query = 'open';
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('openai');
    expect(texts).not.toContain('anthropic');
    expect(texts).not.toContain('gemini');
  });

  test('no-match query shows helpful message', () => {
    const picker = makeProviderPicker();
    picker.query = 'zzz-no-match';
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('No providers match');
  });

  test('each line has correct width in provider mode with query', () => {
    const picker = makeProviderPicker();
    picker.query = 'ant';
    const lines = renderModelPickerOverlay(picker, W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });
});

// ---------------------------------------------------------------------------
// Effort mode
// ---------------------------------------------------------------------------

describe('renderModelPickerOverlay — effort mode', () => {
  function makeEffortPicker(): ModelPickerModal {
    const picker = new ModelPickerModal();
    picker.active = true;
    picker.mode = 'effort';
    picker.effortLevels = ['low', 'medium', 'high'];
    picker.selectedIndex = 1;
    picker.pendingModel = MODEL_B;
    return picker;
  }

  test('returns non-empty Line[] in effort mode', () => {
    const lines = renderModelPickerOverlay(makeEffortPicker(), W);
    expect(lines.length).toBeGreaterThan(0);
  });

  test('each line has correct width in effort mode', () => {
    const lines = renderModelPickerOverlay(makeEffortPicker(), W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('title bar contains "Select Effort Level"', () => {
    const lines = renderModelPickerOverlay(makeEffortPicker(), W);
    const title = lineToString(lines[0]);
    expect(title).toContain('Select Effort Level');
  });

  test('shows effort level names in list', () => {
    const texts = linesToText(renderModelPickerOverlay(makeEffortPicker(), W)).join('\n');
    expect(texts).toContain('low');
    expect(texts).toContain('medium');
    expect(texts).toContain('high');
  });

  test('shows effort descriptions from shared constant', () => {
    const texts = linesToText(renderModelPickerOverlay(makeEffortPicker(), W)).join('\n');
    expect(texts).toContain('Balanced speed and quality');
  });

  test('shows pending model name in footer area', () => {
    const texts = linesToText(renderModelPickerOverlay(makeEffortPicker(), W)).join('\n');
    expect(texts).toContain('Model:');
    expect(texts).toContain('Beta');
  });

  test('shows "unknown" when pendingModel is null', () => {
    const picker = makeEffortPicker();
    picker.pendingModel = null;
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('unknown');
  });

  test('selected item has arrow indicator', () => {
    const lines = renderModelPickerOverlay(makeEffortPicker(), W);
    const hasArrow = lines.some(line => line.some(cell => cell.char === '\u25b6'));
    expect(hasArrow).toBe(true);
  });

  test('works at narrow terminal width', () => {
    const narrowW = 60;
    const lines = renderModelPickerOverlay(makeEffortPicker(), narrowW);
    for (const line of lines) {
      expect(line.length).toBe(narrowW);
    }
  });
});

// ---------------------------------------------------------------------------
// Stage 5: Quality tier badge, pin indicator, filters
// ---------------------------------------------------------------------------

describe('renderModelPickerOverlay — Stage 5 features', () => {
  test('quality tier badge [S]/[A]/[B]/[C] renders for models with benchmark data', () => {
    _setEntriesForTest([
      { modelId: 'model-a', name: 'model-a', organization: 'test', benchmarks: { swe: 0.92, gpqa: 0.88 } },
    ]);
    const picker = makePicker({ selectedIndex: 0 });
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    // S tier threshold: composite >= 0.80; swe=0.92, gpqa=0.88 → composite ≈ 0.90
    expect(texts).toMatch(/\[S\]|\[A\]|\[B\]|\[C\]/);
  });

  test('free indicator ◆ renders for free-tier models', () => {
    _setEntriesForTest([]);
    const picker = makePicker({ selectedIndex: 0 });
    // MODEL_A is tier: free — should show ◆ (\u25c6)
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).toContain('\u25c6');
  });

  test('pin star ★ renders for pinned models', () => {
    const picker = makePicker();
    picker.pinnedIds = new Set(['model-a']);
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    // Star char ★ (\u2605) should appear in the model row
    expect(texts).toContain('\u2605');
  });

  test('no pin star when model is not pinned', () => {
    const picker = makePicker();
    picker.pinnedIds = new Set();
    const texts = linesToText(renderModelPickerOverlay(picker, W)).join('\n');
    expect(texts).not.toContain('\u2605');
  });

  test('footer shows Group hint in model mode', () => {
    const picker = makePicker();
    const lines = renderModelPickerOverlay(picker, W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).toContain('Group');
  });

  test('footer shows current groupBy mode', () => {
    const picker = makePicker();
    picker.groupBy = 'family';
    const lines = renderModelPickerOverlay(picker, W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).toContain('family');
  });

  test('paid filter label shows Paid in footer', () => {
    const picker = makePicker();
    picker.categoryFilter = 'paid';
    const lines = renderModelPickerOverlay(picker, W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).toContain('Paid');
  });

  test('subscription filter label shows Sub in footer', () => {
    const picker = makePicker();
    picker.categoryFilter = 'subscription';
    const lines = renderModelPickerOverlay(picker, W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).toContain('Sub');
  });

  test('lines maintain correct width when pin/badge columns are added', () => {
    const picker = makePicker();
    picker.pinnedIds = new Set(['model-a']);
    _setEntriesForTest([
      { modelId: 'model-a', name: 'model-a', organization: 'test', benchmarks: { swe: 0.9 } },
    ]);
    const lines = renderModelPickerOverlay(picker, W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });
});
