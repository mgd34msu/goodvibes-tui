import { describe, test, expect, mock } from 'bun:test';
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

/** A minimal stateful ConfigManager mock: getRaw() reflects the most recent set(). */
function createMutableConfig(): import('../../config/index.ts').ConfigManager & { setCalls: ReturnType<typeof mock> } {
  const state = { ui: { systemMessages: 'panel', operationalMessages: 'panel', wrfcMessages: 'panel' } };
  const setCalls = mock((key: string, value: string) => {
    (state.ui as Record<string, string>)[key.replace('ui.', '')] = value;
  });
  return {
    getRaw: () => state,
    set: setCalls,
    setCalls,
  } as unknown as import('../../config/index.ts').ConfigManager & { setCalls: ReturnType<typeof mock> };
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

  // WO-137 ---------------------------------------------------------------

  function selectedDetail(text: string): string {
    const marker = 'Selected Message';
    const idx = text.indexOf(marker);
    return idx === -1 ? '' : text.slice(idx + marker.length);
  }

  test('follow-mode: auto-jump only when selection is already at the tail', () => {
    const p = makePanel(); // 3 messages; selection defaults to the tail.
    p.render(80, 24);
    p.handleInput('up'); // move off the tail
    p.push('new message while scrolled up', 'low');
    const scrolledUp = linesToText(p.render(80, 24)).join('\n');
    const detailAfterScroll = selectedDetail(scrolledUp);
    expect(detailAfterScroll).toContain('provider scan completed');
    expect(detailAfterScroll).not.toContain('new message while scrolled up');

    // Return to the tail, then push again — this time it should follow.
    p.handleInput('down');
    p.handleInput('down');
    p.push('second new message', 'low');
    const followed = linesToText(p.render(80, 24)).join('\n');
    expect(selectedDetail(followed)).toContain('second new message');
  });

  test('p cycles the priority filter: all -> high -> low -> all', () => {
    const p = makePanel(); // 1 high, 2 low
    let text = linesToText(p.render(80, 24)).join('\n');
    expect(text).toContain('model switched to opus');
    expect(text).toContain('provider scan completed');

    p.handleInput('p'); // -> high only
    text = linesToText(p.render(80, 24)).join('\n');
    expect(text).toContain('model switched to opus');
    expect(text).not.toContain('provider scan completed');
    expect(text).not.toContain('sandbox verified ok');

    p.handleInput('p'); // -> low only
    text = linesToText(p.render(80, 24)).join('\n');
    expect(text).not.toContain('model switched to opus');
    expect(text).toContain('provider scan completed');
    expect(text).toContain('sandbox verified ok');

    p.handleInput('p'); // -> all
    text = linesToText(p.render(80, 24)).join('\n');
    expect(text).toContain('model switched to opus');
    expect(text).toContain('provider scan completed');
  });

  test('s/o/w cycle routing targets in-panel and persist via configManager.set', () => {
    const config = createMutableConfig();
    const p = new SystemMessagesPanel(config);
    p.push('hello', 'low');

    p.handleInput('s');
    expect(config.setCalls).toHaveBeenCalledWith('ui.systemMessages', 'conversation');
    p.handleInput('o');
    expect(config.setCalls).toHaveBeenCalledWith('ui.operationalMessages', 'conversation');
    p.handleInput('w');
    expect(config.setCalls).toHaveBeenCalledWith('ui.wrfcMessages', 'conversation');

    const text = linesToText(p.render(80, 24)).join('\n');
    expect(text).toContain('conversation');

    p.handleInput('s'); // cycle again: conversation -> both
    expect(config.setCalls).toHaveBeenCalledWith('ui.systemMessages', 'both');
  });

  test('c clears the backlog after ConfirmState confirmation (y confirms, n cancels)', () => {
    const p = makePanel();
    expect(linesToText(p.render(80, 24)).join('\n')).toContain('model switched');

    p.handleInput('c');
    let text = linesToText(p.render(80, 24)).join('\n');
    expect(text).toContain('Clear');
    expect(text).toContain('confirm');

    p.handleInput('n');
    text = linesToText(p.render(80, 24)).join('\n');
    expect(text).toContain('model switched');

    p.handleInput('c');
    p.handleInput('y');
    text = linesToText(p.render(80, 24)).join('\n');
    expect(text).toContain('No system messages yet');
  });
});
