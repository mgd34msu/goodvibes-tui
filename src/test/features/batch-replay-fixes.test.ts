/**
 * Regression tests for the batch live-replay findings: honest
 * pre-first-token wording, a real /config set verb, attach-and-steer from the
 * fleet tree, and the Ctrl+C chord decoupled from live TTS.
 */
import { describe, test, expect } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { handleCtrlC } from '../../input/handler-content-actions.ts';

function fragmentText(lines: ReturnType<typeof UIFactory.createThinkingFragment>): string {
  return lines.map((line) => line.map((cell) => cell.char ?? '').join('')).join('\n');
}

describe('pre-first-token silence is not "Stalled"', () => {
  const stallInfo = { msSinceLastDelta: 6_000 };

  test('out=0 renders waiting-for-model wording', () => {
    const text = fragmentText(UIFactory.createThinkingFragment(
      120, '⠇', 0, undefined, undefined, 61, 0, 6_000, undefined, stallInfo,
    ));
    expect(text).toContain('Waiting for model 6s');
    expect(text).not.toContain('Stalled');
  });

  test('mid-stream silence (out>0) keeps the honest Stalled label', () => {
    const text = fragmentText(UIFactory.createThinkingFragment(
      120, '⠇', 0, undefined, undefined, 61, 400, 30_000, 900, stallInfo,
    ));
    expect(text).toContain('Stalled 6s');
  });

  test('approval wait still wins over both', () => {
    const text = fragmentText(UIFactory.createThinkingFragment(
      120, '⠇', 0, undefined, undefined, 61, 0, 6_000, undefined, stallInfo, true,
    ));
    expect(text).toContain('Waiting for your approval');
  });
});

describe('Ctrl+C chord vs live TTS', () => {
  function pressCtrlC(cancelGeneration: (() => boolean | void) | undefined, lastTime = 0) {
    let armed = false;
    let exited = false;
    let recordedTime = -1;
    handleCtrlC(
      '', () => {}, () => {}, () => {},
      cancelGeneration,
      () => { exited = true; },
      () => {},
      lastTime,
      (v: number) => { recordedTime = v; },
      (v: boolean) => { armed = armed || v; },
      null,
      () => {},
    );
    return { armed, exited, recordedTime };
  }

  test('a press that stopped live speech is consumed — no arm, no quit-count', () => {
    const r = pressCtrlC(() => true);
    expect(r.armed).toBe(false);
    expect(r.recordedTime).toBe(-1);
  });

  test('a quiet-state press arms the quit window', () => {
    const r = pressCtrlC(() => false);
    expect(r.armed).toBe(true);
    expect(r.recordedTime).toBeGreaterThan(0);
  });

  test('a void cancelGeneration (no TTS wired) still arms', () => {
    const r = pressCtrlC(() => undefined);
    expect(r.armed).toBe(true);
  });
});
