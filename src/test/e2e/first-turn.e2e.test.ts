/**
 * (c) A first turn through the built binary: typing a prompt and pressing
 * Enter reaches the model with that prompt, and the model's reply is drawn in
 * the transcript.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { inputAreaVisible, lastUserText, launchTui, makeHome, screenText, startStubModel, type TuiSession } from './harness.ts';

const PROMPT = 'please answer the e2e marmot question';
const REPLY = 'The marmot answer is forty-two.';

const model = startStubModel((request) => (
  lastUserText(request).includes('marmot question') ? { text: REPLY } : { text: 'E2E side request' }
));
let tui: TuiSession | null = null;
afterAll(() => { tui?.stop(); model.stop(); });

describe('first turn', () => {
  test('a typed prompt reaches the model and its reply is drawn', async () => {
    const home = await makeHome(model);
    tui = launchTui(home, { cols: 100, rows: 30 });
    await tui.waitForScreen('the input area', inputAreaVisible, 45_000);

    tui.type(PROMPT);
    tui.key('Enter');

    const screen = await tui.waitForScreen('the scripted reply', (s) => screenText(s).includes(REPLY), 45_000);
    expect(model.requests.some((request) => lastUserText(request).includes(PROMPT))).toBe(true);
    expect(screenText(screen)).toContain(PROMPT);
    expect(tui.alive()).toBe(true);
  }, 100_000);
});
