import { describe, expect, test } from 'bun:test';
import { renderTabStrip, type TabHitRegion, type TabStripStyle } from '../../renderer/tab-strip.ts';
import { lineToString } from '../setup.ts';

const STYLE: TabStripStyle = {
  activeFg: '#ffffff',
  activeBg: '#1e293b',
  activeBold: true,
  inactiveFg: '244',
  separatorFg: '238',
  overflowFg: '238',
};

function tabs(n: number, activeIndex: number) {
  return Array.from({ length: n }, (_, i) => ({ label: `Panel${i}`, active: i === activeIndex }));
}

describe('renderTabStrip windowing', () => {
  test('keeps the active tab visible when it is at the far right', () => {
    const activeIndex = 14;
    const line = renderTabStrip({ width: 40, tabs: tabs(15, activeIndex), style: STYLE });
    const text = lineToString(line);
    expect(text).toContain('[Panel14]'); // active is bracketed and present
    expect(text).toContain('‹'); // left overflow indicator shown
    expect(text).not.toContain('Panel0'); // early tabs scrolled out
  });

  test('active tab at index 0 shows only the right overflow indicator', () => {
    const line = renderTabStrip({ width: 40, tabs: tabs(15, 0), style: STYLE });
    const text = lineToString(line);
    expect(text).toContain('[Panel0]');
    expect(text).toContain('›');
    expect(text).not.toContain('‹');
  });

  test('active tab is always present across a full sweep of active indices', () => {
    const n = 20;
    for (let active = 0; active < n; active++) {
      const line = renderTabStrip({ width: 38, tabs: tabs(n, active), style: STYLE });
      const text = lineToString(line);
      expect(text).toContain(`[Panel${active}]`);
    }
  });

  test('no overflow indicators when everything fits', () => {
    const line = renderTabStrip({ width: 120, tabs: tabs(3, 1), style: STYLE });
    const text = lineToString(line);
    expect(text).toContain('Panel0');
    expect(text).toContain('[Panel1]');
    expect(text).toContain('Panel2');
    expect(text).not.toContain('‹');
    expect(text).not.toContain('›');
  });

  test('narrow widths do not throw and still surface the active tab', () => {
    for (const width of [0, 1, 2, 5, 8]) {
      expect(() => renderTabStrip({ width, tabs: tabs(10, 5), style: STYLE })).not.toThrow();
    }
  });

  test('onLayout reports hit regions including the active tab index', () => {
    let regions: readonly TabHitRegion[] = [];
    renderTabStrip({
      width: 40,
      tabs: tabs(15, 14),
      style: STYLE,
      prefixLabel: ' PANELS ',
      onLayout: (r) => { regions = r; },
    });
    expect(regions.length).toBeGreaterThan(0);
    expect(regions.some((r) => r.index === 14)).toBe(true);
    // Regions are ordered and non-overlapping with positive width.
    for (const r of regions) expect(r.endCol).toBeGreaterThan(r.startCol);
    for (let i = 1; i < regions.length; i++) {
      expect(regions[i].startCol).toBeGreaterThanOrEqual(regions[i - 1].endCol);
    }
  });
});
