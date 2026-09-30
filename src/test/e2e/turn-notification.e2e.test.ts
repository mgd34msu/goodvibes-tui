/**
 * (e) A finished turn sends an OSC 9 terminal notification that names the
 * turn. The payload is read from the raw bytes the binary wrote to its
 * terminal, where the escape sequence survives; the rendered screen never
 * shows it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { inputAreaVisible, lastUserText, launchTui, makeHome, screenText, startStubModel, waitFor, type TuiSession } from './harness.ts';

const PROMPT = 'summarize the heron migration notes';
const REPLY = 'Herons migrate south in autumn.';

const model = startStubModel((request) => (
  lastUserText(request).includes('heron migration') ? { text: REPLY } : { text: 'E2E side request' }
));
let tui: TuiSession | null = null;
afterAll(() => { tui?.stop(); model.stop(); });

/** Every OSC 9 payload in a raw terminal stream. */
function osc9Payloads(raw: string): string[] {
  return [...raw.matchAll(/\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)].map((match) => match[1]!);
}

describe('turn-end notification', () => {
  test('the OSC 9 payload for a finished turn names the turn', async () => {
    const home = await makeHome(model);
    home.setTuiSetting('behavior.terminalNotifyTurnEnd', true);
    tui = launchTui(home, { cols: 100, rows: 30 });
    await tui.waitForScreen('the input area', inputAreaVisible, 45_000);

    tui.type(PROMPT);
    tui.key('Enter');
    await tui.waitForScreen('the scripted reply', (s) => screenText(s).includes(REPLY), 45_000);

    const payloads = await waitFor('an OSC 9 turn-end notification', () => {
      const found = osc9Payloads(tui!.rawOutput());
      return found.length > 0 ? found : false;
    }, 15_000);
    const turnEnd = payloads.find((payload) => /heron migration/i.test(payload));
    expect(turnEnd, `OSC 9 payloads: ${JSON.stringify(payloads)}`).toBeDefined();
    expect(turnEnd!).not.toMatch(/[0-9a-f]{12}/); // no internal ids in outward text
  }, 100_000);
});
