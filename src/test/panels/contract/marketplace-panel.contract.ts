import { describe, test, expect } from 'bun:test';
import { MarketplacePanel } from '../../../panels/marketplace-panel.ts';
import { runBasePanelContractSuite, W, H } from './_shared.ts';

runBasePanelContractSuite({
  label: 'MarketplacePanel (no paths)',
  factory: () => new MarketplacePanel(),
});

// ---------------------------------------------------------------------------
// MarketplacePanel — populated readModel contract
// ---------------------------------------------------------------------------

describe('MarketplacePanel — populated readModel', () => {
  const makeReadModel = () => ({
    getSnapshot: () => ({
      plugins: [
        { id: 'test-plugin', name: 'Test Plugin', description: 'A test plugin', version: '1.0.0', author: 'test', installed: true, kind: 'plugin' },
      ],
      agents: [],
      skills: [],
      tools: [],
      loading: false,
      error: null,
    }),
    subscribe: (_cb: () => void) => () => {},
  } as unknown as import('../../../runtime/ui-read-models.ts').UiReadModel<import('../../../runtime/ui-read-models.ts').UiMarketplaceSnapshot>);

  test('render() returns exactly H lines with populated readModel', () => {
    const panel = new MarketplacePanel(makeReadModel());
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
  });

  test('every rendered line has exactly W cells with populated readModel', () => {
    const panel = new MarketplacePanel(makeReadModel());
    const lines = panel.render(W, H);
    for (const line of lines) {
      expect(line).toHaveLength(W);
    }
  });

  test('clampSelection: selectedIndex stays in bounds after render', () => {
    const panel = new MarketplacePanel(makeReadModel());
    panel.render(W, H);
    const idx = (panel as unknown as { selectedIndex: number }).selectedIndex;
    expect(idx).toBeGreaterThanOrEqual(0);
  });
});
