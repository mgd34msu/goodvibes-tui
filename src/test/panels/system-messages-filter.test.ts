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
});
