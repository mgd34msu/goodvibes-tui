import { describe, expect, test } from 'bun:test';
import { checkNoInternalIdentifiers } from '../../../scripts/internal-identifier-rule.ts';

// Fixture ids below are built via concatenation rather than written as literal
// substrings, so this test file's own source text never contains a real
// internal identifier that this repo's architecture check would flag.
const wave = 'W' + '9.9';
const workOrderNumeric = 'wo' + '999';
const workOrderLettered = 'WO-' + 'Z';
const workOrderNumbered = 'WO-' + '999';
const debtId = 'DEBT-' + '9';
const uxId = 'UX-' + 'Z';
const waveWord = 'Wave' + ' 9';
const waveRound = 'W9-' + 'R2';

describe('checkNoInternalIdentifiers', () => {
  test('passes plain-language text with no internal identifiers', () => {
    const violations = checkNoInternalIdentifiers([
      { relPath: 'src/panels/example-panel.ts', text: '// removed in a prior panel-consolidation cleanup' },
    ]);
    expect(violations).toEqual([]);
  });

  test('fails on a wave.item id', () => {
    const violations = checkNoInternalIdentifiers([
      { relPath: 'src/panels/example-panel.ts', text: `// panel delivery removed in ${wave}` },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('src/panels/example-panel.ts:1');
    expect(violations[0]).toContain(wave);
    expect(violations[0]).toContain('never put wave/work-order/register ids in outward-facing or in-code text');
    expect(violations[0]).toContain('[internal-identifier]');
  });

  test('fails on a numeric work-order id', () => {
    const violations = checkNoInternalIdentifiers([
      { relPath: 'src/runtime/example.ts', text: `// landed on SDK main as ${workOrderNumeric}` },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(workOrderNumeric);
  });

  test('fails on a lettered and a numbered work-order id', () => {
    const lettered = checkNoInternalIdentifiers([
      { relPath: 'src/panels/example.ts', text: `// Group A (${workOrderLettered}) providers subset` },
    ]);
    expect(lettered).toHaveLength(1);
    expect(lettered[0]).toContain(workOrderLettered);

    const numbered = checkNoInternalIdentifiers([
      { relPath: 'scripts/example-rule.ts', text: `// ${workOrderNumbered} architecture-gate rule` },
    ]);
    expect(numbered).toHaveLength(1);
    expect(numbered[0]).toContain(workOrderNumbered);
  });

  test('fails on a debt-register id and a UX-workstream id', () => {
    const debt = checkNoInternalIdentifiers([
      { relPath: 'src/input/example.ts', text: `// this is ${debtId}'s design` },
    ]);
    expect(debt).toHaveLength(1);
    expect(debt[0]).toContain(debtId);

    const ux = checkNoInternalIdentifiers([
      { relPath: 'src/input/example.ts', text: `// this is ${uxId}'s design` },
    ]);
    expect(ux).toHaveLength(1);
    expect(ux[0]).toContain(uxId);
  });

  test('fails on wave word-forms and wave-round ids', () => {
    const waveWordViolations = checkNoInternalIdentifiers([
      { relPath: 'scripts/example.ts', text: `// consolidated by ${waveWord} tooling` },
    ]);
    expect(waveWordViolations).toHaveLength(1);
    expect(waveWordViolations[0]).toContain(waveWord);

    const waveRoundViolations = checkNoInternalIdentifiers([
      { relPath: 'docs/decisions/example.md', text: `Scope: ${waveRound} (scheduled removal)` },
    ]);
    expect(waveRoundViolations).toHaveLength(1);
    expect(waveRoundViolations[0]).toContain(waveRound);
  });

  test('reports one violation per offending line, not per file', () => {
    const violations = checkNoInternalIdentifiers([
      {
        relPath: 'src/panels/example.ts',
        text: `// first line mentions ${wave}\n// second line is clean\n// third line mentions ${debtId}`,
      },
    ]);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain(':1:');
    expect(violations[1]).toContain(':3:');
  });

  test('exempts docs/releases/** as dated historical records', () => {
    const violations = checkNoInternalIdentifiers([
      { relPath: 'docs/releases/0.18.18.md', text: `### R1 — Render coalescing, landed in ${waveWord}` },
    ]);
    expect(violations).toEqual([]);
  });

  test('exempts the memory-modal golden-frame fixture, which is pinned byte-for-byte against a recorded snapshot', () => {
    const violations = checkNoInternalIdentifiers([
      { relPath: 'src/panels/modals/memory-modal.ts', text: `summary: '${wave} batches panel retirements.'` },
    ]);
    expect(violations).toEqual([]);
  });

  test('does not flag the F2 keyboard key or unrelated short tokens', () => {
    const violations = checkNoInternalIdentifiers([
      { relPath: 'src/input/handler-shortcuts.ts', text: "if (token.logicalName === 'f2') { openFleetPanel(); }" },
    ]);
    expect(violations).toEqual([]);
  });
});
