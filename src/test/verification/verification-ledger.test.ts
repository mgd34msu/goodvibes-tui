import { describe, expect, test } from 'bun:test';
import {
  buildVerificationLedger,
  renderVerificationLedgerMarkdown,
} from '../../verification/verification-ledger.ts';
import { join, resolve } from 'node:path';

const projectRoot = resolve(join(import.meta.dir, '..', '..', '..'));

describe('verification ledger', () => {
  test('builds a repeatable local verification coverage summary', () => {
    const ledger = buildVerificationLedger(projectRoot);

    expect(ledger.totals.total).toBeGreaterThan(400);
    expect(ledger.totals.localSignalPercent).toBeGreaterThanOrEqual(90);
    expect(ledger.totals.localBehaviorPercent).toBeGreaterThan(70);
    expect(ledger.areas.map((area) => area.area)).toEqual(expect.arrayContaining([
      'Settings schema and persistence',
      'Slash commands',
      'Built-in panels',
      'Top-level CLI commands',
    ]));
  });

  test('renders a markdown ledger for reports', () => {
    const markdown = renderVerificationLedgerMarkdown(buildVerificationLedger(projectRoot));

    expect(markdown).toContain('# GoodVibes Verification Ledger');
    expect(markdown).toContain('Local verification signal');
    expect(markdown).toContain('External outcome required');
  });
});
