import { describe, expect, test } from 'bun:test';
import { deriveComposerState } from '../../core/composer-state.ts';

describe('composer state', () => {
  test('an approval wait owns a single honest status tag (no duplicate spellings)', () => {
    const state = deriveComposerState({
      text: '/review current branch',
      commandMode: true,
      pendingApproval: true,
      turnState: 'preflight',
    });
    expect(state.modeLabel).toBe('review');
    // approval-wait is the dominant state: it is NOT duplicated as a flag, and
    // it suppresses the competing turn-status tag ('idle' → footer hides it).
    expect(state.pendingRisk).toBe('approval-wait');
    expect(state.flags).not.toContain('approval');
    expect(state.statusLabel).toBe('idle');
  });

  test('without an approval wait, statusLabel reflects the live turn state', () => {
    const state = deriveComposerState({ text: 'hello', turnState: 'streaming' });
    expect(state.statusLabel).toBe('streaming');
    expect(state.pendingRisk).toBe('none');
  });

  test('marks shell submissions as risky without approval wait', () => {
    const state = deriveComposerState({
      text: '!rm -rf build',
      turnState: 'idle',
    });
    expect(state.modeLabel).toBe('shell');
    expect(state.pendingRisk).toBe('shell');
  });
});

