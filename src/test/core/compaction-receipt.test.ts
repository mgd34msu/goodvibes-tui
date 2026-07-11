import { describe, expect, test } from 'bun:test';
import { buildCompactionReceiptBlock, type CompactionReceiptInput } from '../../core/compaction-receipt.ts';

function baseReceipt(overrides: Partial<CompactionReceiptInput> = {}): CompactionReceiptInput {
  return {
    trigger: 'auto',
    strategy: 'structured-handoff',
    tokensBefore: 120_000,
    tokensAfter: 40_000,
    messagesBefore: 200,
    messagesAfter: 12,
    qualityScore: 87,
    qualityGrade: 'B+',
    lowQuality: false,
    instructionsReinjected: true,
    validationPassed: true,
    sectionsIncluded: ['standing-instructions', 'recent-turns'],
    outcome: 'applied',
    ...overrides,
  };
}

describe('compaction-receipt', () => {
  test('applied receipt is a distinct [Compaction] block with size delta and savings', () => {
    const block = buildCompactionReceiptBlock(baseReceipt());
    const lines = block.split('\n');
    expect(lines[0]).toContain('[Compaction] Receipt');
    expect(lines[0]).toContain('automatic');
    expect(lines[0]).toContain('applied');
    expect(block).toContain('200 → 12 messages');
    expect(block).toContain('saved ~80,000');
    expect(block).toContain('67%'); // 80k / 120k
    expect(block).toContain('B+');
    expect(block).toContain('87/100');
    expect(block).toContain('standing instructions re-injected');
    expect(block).toContain('validation passed');
    expect(block).toContain('Sections included: standing-instructions, recent-turns');
  });

  test('applied receipt with no recorded sections says so plainly rather than hiding it', () => {
    const block = buildCompactionReceiptBlock(baseReceipt({ sectionsIncluded: [] }));
    expect(block).toContain('Sections included: none recorded');
  });

  test('kept-original receipt reports retention, not a misleading savings figure', () => {
    const block = buildCompactionReceiptBlock(baseReceipt({ outcome: 'kept-original', lowQuality: true, qualityGrade: 'D' }));
    expect(block).toContain('kept original');
    expect(block).toContain('Context retained at ~120,000 tokens');
    expect(block).not.toContain('saved ~');
    expect(block).toContain('below the quality bar');
  });

  test('failed receipt is honest and includes optional detail', () => {
    const block = buildCompactionReceiptBlock(baseReceipt({ outcome: 'failed', detail: 'summarizer timed out' }));
    expect(block).toContain('failed');
    expect(block).toContain('summarizer timed out');
  });

  test('manual trigger and missing re-injection / failed validation are narrated honestly', () => {
    const block = buildCompactionReceiptBlock(baseReceipt({ trigger: 'manual', instructionsReinjected: false, validationPassed: false }));
    expect(block).toContain('manual');
    expect(block).toContain('no standing instructions to re-inject');
    expect(block).toContain('validation did NOT pass');
  });

  test('distiller→structured fallback names the requested strategy and the reason', () => {
    const block = buildCompactionReceiptBlock(baseReceipt({
      strategy: 'structured',
      requestedStrategy: 'distiller',
      strategyFallbackReason: 'distillation quality 0.41 (D) below floor 0.55; fell back to structured',
    }));
    expect(block).toContain('Requested strategy "distiller" fell back to "structured"');
    expect(block).toContain('distillation quality 0.41 (D) below floor 0.55');
  });

  test('no fallback line when requestedStrategy matches the strategy that ran', () => {
    const block = buildCompactionReceiptBlock(baseReceipt({ strategy: 'structured', requestedStrategy: 'structured' }));
    expect(block).not.toContain('Requested strategy');
  });
});
