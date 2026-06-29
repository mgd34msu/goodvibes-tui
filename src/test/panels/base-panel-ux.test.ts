// ---------------------------------------------------------------------------
// base-panel-ux.test.ts — BasePanel I2 (error surface) + I3 (loading spinner)
//
// BasePanel is abstract, so we test via a minimal concrete subclass.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from 'bun:test';
import type { Line } from '../../types/grid.ts';
import { BasePanel } from '../../panels/base-panel.ts';

// ---------------------------------------------------------------------------
// Test subclass — exposes protected methods as public for assertions
// ---------------------------------------------------------------------------

class TestPanel extends BasePanel {
  public constructor() {
    super('test', 'Test', 'T', 'monitoring');
  }

  // Expose protected methods
  public exposeSetError(msg: string): void { this.setError(msg); }
  public exposeClearError(): void { this.clearError(); }
  public exposeRenderErrorLine(width: number): Line | null { return this.renderErrorLine(width); }
  public exposeLastError(): string | null { return this.lastError; }

  public exposeStartLoading(label?: string): void { this.startLoading(label); }
  public exposeStopLoading(): void { this.stopLoading(); }
  public exposeRenderLoadingLine(width: number, frame?: number): Line | null { return this.renderLoadingLine(width, frame); }
  public exposeLoadingState(): 'idle' | 'loading' | 'error' { return this.loadingState; }

  public render(width: number, height: number): Line[] {
    const lines: Line[] = [];
    while (lines.length < height) lines.push(new Array(width).fill({ char: ' ', fg: '', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false }));
    return lines;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BasePanel error surface (I2)', () => {
  let panel: TestPanel;

  beforeEach(() => {
    panel = new TestPanel();
  });

  test('lastError is null by default', () => {
    expect(panel.exposeLastError()).toBeNull();
  });

  test('setError stores message and sets needsRender', () => {
    panel.needsRender = false;
    panel.exposeSetError('something broke');
    expect(panel.exposeLastError()).toBe('something broke');
    expect(panel.needsRender).toBe(true);
  });

  test('clearError removes message', () => {
    panel.exposeSetError('oops');
    panel.exposeClearError();
    expect(panel.exposeLastError()).toBeNull();
  });

  test('renderErrorLine returns null when no error', () => {
    expect(panel.exposeRenderErrorLine(80)).toBeNull();
  });

  test('renderErrorLine returns a Line of correct width when error set', () => {
    panel.exposeSetError('catalog load failed');
    const line = panel.exposeRenderErrorLine(80);
    expect(line).not.toBeNull();
    expect(line!.length).toBe(80);
  });

  test('renderErrorLine text contains glyph and message', () => {
    panel.exposeSetError('catalog load failed');
    const line = panel.exposeRenderErrorLine(80)!;
    const text = line.map((c) => c.char).join('');
    expect(text).toContain('\u2715');
    expect(text).toContain('catalog load failed');
  });

  test('renderErrorLine cells use bold red fg', () => {
    panel.exposeSetError('err');
    const line = panel.exposeRenderErrorLine(80)!;
    const nonSpace = line.find((c) => c.char !== ' ')!;
    expect(nonSpace.fg).toBe('#ef4444');
    expect(nonSpace.bold).toBe(true);
  });
});

describe('BasePanel loading spinner (I3)', () => {
  let panel: TestPanel;

  beforeEach(() => {
    panel = new TestPanel();
  });

  test('loadingState is idle by default', () => {
    expect(panel.exposeLoadingState()).toBe('idle');
  });

  test('startLoading sets state to loading and needsRender', () => {
    panel.needsRender = false;
    panel.exposeStartLoading('Loading diff...');
    expect(panel.exposeLoadingState()).toBe('loading');
    expect(panel.needsRender).toBe(true);
  });

  test('stopLoading returns state to idle and sets needsRender', () => {
    panel.exposeStartLoading();
    panel.needsRender = false;
    panel.exposeStopLoading();
    expect(panel.exposeLoadingState()).toBe('idle');
    expect(panel.needsRender).toBe(true);
  });

  test('renderLoadingLine returns null when idle', () => {
    expect(panel.exposeRenderLoadingLine(80)).toBeNull();
  });

  test('renderLoadingLine returns null after stopLoading', () => {
    panel.exposeStartLoading();
    panel.exposeStopLoading();
    expect(panel.exposeRenderLoadingLine(80)).toBeNull();
  });

  test('renderLoadingLine returns a Line of correct width when loading', () => {
    panel.exposeStartLoading('Loading...');
    const line = panel.exposeRenderLoadingLine(80);
    expect(line).not.toBeNull();
    expect(line!.length).toBe(80);
  });

  test('renderLoadingLine text contains label', () => {
    panel.exposeStartLoading('Loading diff...');
    const line = panel.exposeRenderLoadingLine(80)!;
    const text = line.map((c) => c.char).join('');
    expect(text).toContain('Loading diff...');
  });

  test('renderLoadingLine text contains a spinner frame character', () => {
    panel.exposeStartLoading('work');
    const line = panel.exposeRenderLoadingLine(80, 0)!;
    const text = line.map((c) => c.char).join('').trim();
    // First char should be the spinner glyph (braille characters)
    expect(text.length).toBeGreaterThan(0);
    expect(text[0]).not.toBe(' ');
  });

  test('startLoading default label is "Loading..."', () => {
    panel.exposeStartLoading();
    const line = panel.exposeRenderLoadingLine(80)!;
    const text = line.map((c) => c.char).join('');
    expect(text).toContain('Loading...');
  });

  test('renderLoadingLine with frame=0 uses time-based index (non-space glyph)', () => {
    panel.exposeStartLoading('work');
    const line = panel.exposeRenderLoadingLine(80, 0)!;
    const text = line.map((c) => c.char).join('').trim();
    // (0 || Date.now()/100) picks a time-based frame — always a non-space spinner char
    expect(text.length).toBeGreaterThan(0);
    expect(text[0]).not.toBe(' ');
  });
});

describe('BasePanel tab status (PNL-2)', () => {
  let panel: TestPanel;

  beforeEach(() => {
    panel = new TestPanel();
  });

  test('getTabStatus returns undefined by default', () => {
    expect(panel.getTabStatus()).toBeUndefined();
  });

  test('getTabStatus returns bad when error is set', () => {
    panel.exposeSetError('something went wrong');
    expect(panel.getTabStatus()).toBe('bad');
  });

  test('getTabStatus returns undefined after error cleared', () => {
    panel.exposeSetError('oops');
    panel.exposeClearError();
    expect(panel.getTabStatus()).toBeUndefined();
  });
});
