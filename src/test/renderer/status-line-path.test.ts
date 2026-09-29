import { describe, expect, test } from 'bun:test';
import { renderStatusLine } from '../../renderer/status-line.ts';

const text = (line: ReturnType<typeof renderStatusLine>): string => line.map((c) => c.char || ' ').join('');
const context = { usedTokens: 340_000, windowTokens: 1_000_000, compactFraction: 0.8 };

describe('status line with a long directory', () => {
  test('a directory that fits is shown whole', () => {
    expect(text(renderStatusLine({ width: 160, directory: '~/Projects/demo-proj', branch: 'main', cost: '~$0.25', context }))).toContain('~/Projects/demo-proj · main');
  });

  test('a long directory is shortened with a middle ellipsis before the cost or the context bar give up room', () => {
    const dir = '~/Projects/clients/acme/monorepo/packages/demo-proj';
    const row = text(renderStatusLine({ width: 120, directory: dir, branch: 'main', cost: '~$0.25', context }));
    expect(row).toMatch(/~\/…\/(?:[\w-]+\/)*demo-proj · main/);
    expect(row).toContain('~$0.25');
    expect(row).toContain('340.0k / 1.0M');
  });

  test('the longest form that fits wins: trailing segments are kept while they fit', () => {
    const dir = '~/Projects/clients/acme/monorepo/packages/demo-proj';
    const row = text(renderStatusLine({ width: 130, directory: dir, branch: 'main', cost: '~$0.25', context }));
    expect(row).toContain('demo-proj');
    expect(row).not.toContain(dir);
  });

  test('when even ~/…/last does not fit, the directory is dropped and the rest keeps its room', () => {
    const row = text(renderStatusLine({ width: 100, directory: '~/Projects/clients/acme/an-extremely-long-project-directory-name-here', branch: 'main', cost: '~$0.25', context }));
    expect(row).not.toContain('…/');
    expect(row).toContain('340.0k / 1.0M');
  });
});
