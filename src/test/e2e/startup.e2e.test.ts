/**
 * (a) The built binary starts in a real terminal on a fresh home and reaches
 * the input area, with no error on screen and nothing on stderr.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inputAreaVisible, launchTui, makeHome, startStubModel, type TuiSession } from './harness.ts';

const model = startStubModel(() => ({ text: 'unused' }));
let tui: TuiSession | null = null;
afterAll(() => { tui?.stop(); model.stop(); });

describe('startup', () => {
  test('a fresh home reaches the input area with no error', async () => {
    const home = await makeHome(model);
    tui = launchTui(home, { cols: 100, rows: 30 });
    const screen = await tui.waitForScreen('the input area', inputAreaVisible, 45_000);

    expect(tui.alive()).toBe(true);
    expect(screen).toContain('e2e-stub');
    expect(screen).not.toMatch(/\b(Error|error:|failed to start|Unhandled|TypeError|ReferenceError)\b/);
    const stderrFile = readdirSync(home.root).find((name) => name.endsWith('.stderr'))!;
    const stderr = readFileSync(join(home.root, stderrFile), 'utf8');
    expect(stderr).not.toMatch(/Error|panic|Unhandled/);
  }, 60_000);
});
