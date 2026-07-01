import { describe, test, expect } from 'bun:test';
import { SystemMessagesPanel } from '../../../panels/system-messages-panel.ts';
import { runBasePanelContractSuite, EMPTY_CONFIG_MANAGER, W, H } from './_shared.ts';

runBasePanelContractSuite({
  label: 'SystemMessagesPanel (no messages)',
  factory: () => new SystemMessagesPanel(EMPTY_CONFIG_MANAGER),
});

// ---------------------------------------------------------------------------
// SystemMessagesPanel — populated records contract
// ---------------------------------------------------------------------------

const POPULATED_SYSTEM_MSG_CONFIG = {
  ...EMPTY_CONFIG_MANAGER,
  getRaw: () => ({
    ui: {
      systemMessages: 'panel' as const,
      operationalMessages: 'panel' as const,
      wrfcMessages: 'panel' as const,
    },
  }),
} as unknown as import('../../../config/index.ts').ConfigManager;

describe('SystemMessagesPanel — populated messages', () => {
  const makePanel = () => {
    const panel = new SystemMessagesPanel(POPULATED_SYSTEM_MSG_CONFIG);
    panel.push('Provider mercury-2 switched to fallback route due to quota', 'high');
    panel.push('Session context compacted 12k tokens', 'low');
    return panel;
  };

  test('render() returns exactly H lines with messages', () => {
    const panel = makePanel();
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
  });

  test('every rendered line has exactly W cells with messages', () => {
    const panel = makePanel();
    const lines = panel.render(W, H);
    for (const line of lines) {
      expect(line).toHaveLength(W);
    }
  });

  test('renderItem: high-priority message contains HIGH label', () => {
    const panel = makePanel();
    const lines = panel.render(W, H);
    const rendered = lines.map((l) => l.map((c) => c.char).join('')).join('\n');
    expect(rendered).toContain('HIGH');
  });

  test('renderItem: message text appears in rendered output', () => {
    const panel = makePanel();
    const lines = panel.render(W, H);
    const rendered = lines.map((l) => l.map((c) => c.char).join('')).join('\n');
    expect(rendered).toContain('mercury-2');
  });

  test('clampSelection: selectedIndex stays in bounds after render', () => {
    const panel = makePanel();
    panel.render(W, H);
    const idx = (panel as unknown as { selectedIndex: number }).selectedIndex;
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(2);
  });
});
