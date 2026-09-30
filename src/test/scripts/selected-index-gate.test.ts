import { describe, expect, test } from 'bun:test';
import {
  checkSelectedIndexReads,
  countSelectedIndexReads,
  isSelectedIndexRuleTarget,
  SELECTED_INDEX_EXEMPT,
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
  test('targets src/views files', () => {
    expect(isSelectedIndexRuleTarget('src/views/git-view.ts')).toBe(true);
    expect(isSelectedIndexRuleTarget('src/views/marketplace-view.ts')).toBe(true);
  });

  test('exempts every file in the exempt list, and the list is empty today', () => {
    expect(SELECTED_INDEX_EXEMPT.size).toBe(0);
    for (const exempt of SELECTED_INDEX_EXEMPT) {
      expect(isSelectedIndexRuleTarget(exempt)).toBe(false);
    }
  });

  test('does not target files outside src/views', () => {
    expect(isSelectedIndexRuleTarget('src/runtime/bootstrap.ts')).toBe(false);
    expect(isSelectedIndexRuleTarget('src/renderer/ui-factory.ts')).toBe(false);
  });
});

describe('checkSelectedIndexReads', () => {
  test('passes a view file that reads through getSelectedItem()', () => {
    const violations = checkSelectedIndexReads([
      { relPath: 'src/views/example-view.ts', text: 'const s = this.getSelectedItem();' },
    ]);
    expect(violations).toEqual([]);
  });

  test('fails a view file that indexes a raw array by the cursor', () => {
    const violations = checkSelectedIndexReads([
      { relPath: 'src/views/example-view.ts', text: 'const s = this.rows[this.selectedIndex];' },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('src/views/example-view.ts');
    expect(violations[0]).toContain('no-raw-selectedindex-read');
    expect(violations[0]).toContain('getSelectedItem()');
  });

  test('reports the occurrence count', () => {
    const violations = checkSelectedIndexReads([
      {
        relPath: 'src/views/example-view.ts',
        text: 'const a = items[this.selectedIndex]; const b = items[this.selectedIndex];',
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('(2)');
  });

  test('ignores files outside src/views', () => {
    const violations = checkSelectedIndexReads([
      { relPath: 'src/runtime/bootstrap.ts', text: 'const s = rows[this.selectedIndex];' },
    ]);
    expect(violations).toEqual([]);
  });
});
