import { describe, expect, test } from 'bun:test';
import {
  checkSelectedIndexReads,
  countSelectedIndexReads,
  isSelectedIndexRuleTarget,
  SELECTED_INDEX_TOKEN,
} from '../../../scripts/selected-index-rule.ts';

describe('countSelectedIndexReads', () => {
  test('counts raw [this.selectedIndex] tokens', () => {
    expect(
      countSelectedIndexReads('const a = this.rows[this.selectedIndex]; const b = items[this.selectedIndex];'),
    ).toBe(2);
  });

  test('returns 0 when there are none', () => {
    expect(countSelectedIndexReads('const a = this.getSelectedItem();')).toBe(0);
  });

  test('does not match .at(this.selectedIndex)', () => {
    expect(countSelectedIndexReads('const a = this.rows.at(this.selectedIndex);')).toBe(0);
  });

  test('the banned token is the literal bracket read', () => {
    expect(SELECTED_INDEX_TOKEN).toBe('[this.selectedIndex]');
  });
});

describe('isSelectedIndexRuleTarget', () => {
  test('targets src/panels files', () => {
    expect(isSelectedIndexRuleTarget('src/panels/git-panel.ts')).toBe(true);
    expect(isSelectedIndexRuleTarget('src/panels/marketplace-panel.ts')).toBe(true);
  });

  test('exempts the base-class files that own list navigation', () => {
    expect(isSelectedIndexRuleTarget('src/panels/scrollable-list-panel.ts')).toBe(false);
    expect(isSelectedIndexRuleTarget('src/panels/expandable-list-panel.ts')).toBe(false);
  });

  test('does not target files outside src/panels', () => {
    expect(isSelectedIndexRuleTarget('src/runtime/bootstrap.ts')).toBe(false);
    expect(isSelectedIndexRuleTarget('src/renderer/ui-factory.ts')).toBe(false);
  });
});

describe('checkSelectedIndexReads', () => {
  test('passes a panel file that reads through getSelectedItem()', () => {
    const violations = checkSelectedIndexReads([
      { relPath: 'src/panels/example-panel.ts', text: 'const s = this.getSelectedItem();' },
    ]);
    expect(violations).toEqual([]);
  });

  test('fails a panel file that indexes a raw array by the cursor', () => {
    const violations = checkSelectedIndexReads([
      { relPath: 'src/panels/example-panel.ts', text: 'const s = this.rows[this.selectedIndex];' },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('src/panels/example-panel.ts');
    expect(violations[0]).toContain('no-raw-selectedindex-read');
    expect(violations[0]).toContain('getSelectedItem()');
  });

  test('reports the occurrence count', () => {
    const violations = checkSelectedIndexReads([
      {
        relPath: 'src/panels/example-panel.ts',
        text: 'const a = items[this.selectedIndex]; const b = items[this.selectedIndex];',
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('(2)');
  });

  test('ignores the exempt base-class files even with raw reads', () => {
    const violations = checkSelectedIndexReads([
      { relPath: 'src/panels/scrollable-list-panel.ts', text: 'const item = items[this.selectedIndex];' },
      { relPath: 'src/panels/expandable-list-panel.ts', text: 'const item = items[this.selectedIndex];' },
    ]);
    expect(violations).toEqual([]);
  });

  test('ignores files outside src/panels', () => {
    const violations = checkSelectedIndexReads([
      { relPath: 'src/runtime/bootstrap.ts', text: 'const s = rows[this.selectedIndex];' },
    ]);
    expect(violations).toEqual([]);
  });
});
