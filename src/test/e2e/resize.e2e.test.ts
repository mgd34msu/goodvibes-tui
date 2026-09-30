/**
 * (f) Resizing the terminal from 80 to 120 to 200 columns redraws the whole
 * screen at the new width and keeps the transcript: the prompt and the reply
 * from before the resizes are still on screen after each one.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { inputAreaVisible, lastUserText, launchTui, makeHome, screenText, startStubModel, type TuiSession } from './harness.ts';

const PROMPT = 'describe the lighthouse keeper routine';
const REPLY = 'The keeper trims the wick at dusk.';

const model = startStubModel((request) => (
  lastUserText(request).includes('lighthouse keeper') ? { text: REPLY } : { text: 'E2E side request' }
));
let tui: TuiSession | null = null;
afterAll(() => { tui?.stop(); model.stop(); });

/** Width of the composer's top bar (the ▄ run), which spans the screen minus its gutters. */
function composerBarWidth(screen: string): number {
  const bar = screen.split('\n').find((line) => /▄{20,}/.test(line)) ?? '';
  return (bar.match(/▄+/)?.[0] ?? '').length;
}

describe('resize', () => {
  test('80 -> 120 -> 200 columns redraws at each width without losing the transcript', async () => {
    const home = await makeHome(model);
    tui = launchTui(home, { cols: 80, rows: 30 });
    await tui.waitForScreen('the input area', inputAreaVisible, 45_000);
    tui.type(PROMPT);
    tui.key('Enter');
    const at80 = await tui.waitForScreen('the scripted reply', (s) => screenText(s).includes(REPLY), 45_000);
    const bars = [composerBarWidth(at80)];
    expect(bars[0]).toBeGreaterThan(40);

    for (const cols of [120, 200]) {
      tui.resize(cols, 30);
      const screen = await tui.waitForScreen(`a redraw at ${cols} columns`, (s) => {
        const width = composerBarWidth(s);
        return width > bars[bars.length - 1]! && screenText(s).includes(REPLY);
      }, 20_000);
      bars.push(composerBarWidth(screen));
      const text = screenText(screen);
      expect(text).toContain(PROMPT);
      expect(text).toContain(REPLY);
      // The bar grew by the columns added: the redraw used the new width, not a stretch of the old frame.
      expect(bars[bars.length - 1]! - bars[bars.length - 2]!).toBe(cols - (bars.length === 2 ? 80 : 120));
      expect(screen.split('\n').every((line) => [...line].length <= cols)).toBe(true);
    }
    expect(tui.alive()).toBe(true);
  }, 120_000);
});
