import { describe, test, expect } from 'bun:test';
import { SystemMessagesPanel } from '../../panels/system-messages-panel.ts';
import { linesToText } from '../setup.ts';

const CONFIG = {
  getRaw: () => ({ ui: { systemMessages: 'panel', operationalMessages: 'panel', wrfcMessages: 'panel' } }),
} as unknown as import('../../config/index.ts').ConfigManager;

function makePanel(): SystemMessagesPanel {
  const p = new SystemMessagesPanel(CONFIG);
  p.push('model switched to opus', 'high');
  p.push('provider scan completed', 'low');
  p.push('sandbox verified ok', 'low');
  return p;
}

describe('SystemMessagesPanel filter (end-to-end)', () => {
  test('shows all messages before filtering', () => {
    const text = linesToText(makePanel().render(80, 24)).join('\n');
    expect(text).toContain('model switched');
    expect(text).toContain('provider scan');
    expect(text).toContain('sandbox verified');
  });

  test('"/" + query narrows the visible messages', () => {
    const p = makePanel();
    p.handleInput('/');
    for (const ch of 'scan') p.handleInput(ch);
    const text = linesToText(p.render(80, 24)).join('\n');
    expect(text).toContain('provider scan');
    expect(text).not.toContain('model switched');
    expect(text).not.toContain('sandbox verified');
  });

  test('no-match query surfaces a clear message, Esc restores', () => {
    const p = makePanel();
    p.handleInput('/');
    for (const ch of 'zzz') p.handleInput(ch);
    expect(linesToText(p.render(80, 24)).join('\n')).toContain('No messages match');
    p.handleInput('escape');
    expect(linesToText(p.render(80, 24)).join('\n')).toContain('model switched');
  });

  test('posture surfaces severity badges (high/low counts)', () => {
    const text = linesToText(makePanel().render(80, 24)).join('\n');
    expect(text).toContain('high');
    expect(text).toContain('low');
    // Newest-message recency is surfaced in the posture.
    expect(text).toContain('newest');
  });

  test('footer hints become filter-aware once a filter is applied', () => {
    const p = makePanel();
    // Inactive: offers to open the filter.
    expect(linesToText(p.render(80, 24)).join('\n')).toContain('filter');
    p.handleInput('/');
    for (const ch of 'scan') p.handleInput(ch);
    p.handleInput('escape'); // commit clears? escape clears query; re-apply
    p.handleInput('/');
    for (const ch of 'scan') p.handleInput(ch);
    p.handleInput('return'); // commit, query stays applied
    const applied = linesToText(p.render(80, 24)).join('\n');
    expect(applied).toContain('clear filter');
  });
});
