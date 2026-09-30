import { describe, it, expect } from 'bun:test';
import { renderStatusLine } from '../../renderer/status-line.ts';
import { renderThrobberLine, resolveThrobberActivity } from '../../renderer/throbber.ts';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { getDisplayWidth } from '../../utils/terminal-width.ts';

// ---------------------------------------------------------------------------
// Config diff tests
// ---------------------------------------------------------------------------

/** The throbber's text for a running turn (the row above the input area). */
function throbberRowText(turn: { phrase?: string; elapsedMs?: number; ttftMs?: number; tokenSpeed?: number; approvalPending?: boolean }): string {
  const now = 1_800_000_000_000;
  const activity = resolveThrobberActivity({
    turnActive: true, compacting: false, now,
    modelPhrase: turn.phrase ?? 'Thinking...',
    turnStartMs: turn.elapsedMs !== undefined ? now - turn.elapsedMs : undefined,
    ttftMs: turn.ttftMs, tokenSpeed: turn.tokenSpeed,
    pendingApproval: turn.approvalPending ? { name: 'exec', args: { command: 'ls' } } : null,
  })!;
  return renderThrobberLine(120, { spinner: '-', frame: 0, activity }).map((c) => c.char).join('');
}

// ---------------------------------------------------------------------------
// Tool preview tests
// ---------------------------------------------------------------------------

describe('tool preview truncation', () => {

  it('the tool preview row names the tool', () => {
    const line = UIFactory.createToolPreviewRow(80, 'read_file({"path":"/home/user/test.ts"})');
    expect(line.map((c) => c.char).join('')).toContain('read_file');
  });

  it('tool preview display width does not exceed terminal width', () => {
    const width = 40;
    const line = UIFactory.createToolPreviewRow(width, 'some_tool(' + 'a'.repeat(100) + ')');
    expect(line).toHaveLength(width);
    expect(getDisplayWidth(line.map((c) => c.char).join('').trimEnd())).toBeLessThanOrEqual(width);
  });

  it('the throbber shows the elapsed time of a running turn', () => {
    expect(throbberRowText({ elapsedMs: 12_000 })).toContain('12s');
  });

  it('the throbber shows time to first token once known', () => {
    expect(throbberRowText({ ttftMs: 350 })).toContain('first token 0.3s');
  });

  it('the throbber shows both elapsed and first-token time', () => {
    const text = throbberRowText({ elapsedMs: 5000, ttftMs: 280 });
    expect(text).toContain('5s');
    expect(text).toContain('first token 0.2s');
  });

  it('no elapsed time is shown when none is known', () => {
    expect(throbberRowText({})).not.toMatch(/ \d+(\.\d)?s\b/);
  });

  it('the status line offers esc to interrupt a running turn', () => {
    expect(renderStatusLine({ width: 120, busy: {} }).map((c) => c.char).join('')).toMatch(/esc +interrupt/);
  });

  // -------------------------------------------------------------------------
  // Stall-honesty indicator: frozen phrase rotation + stalled/
  // reconnecting label once real silence has gone on long enough.
  // -------------------------------------------------------------------------

  it('shows a rotating whimsical phrase when no stallInfo is provided (unchanged baseline)', () => {
    expect(UIFactory.busyPhrase(0)).toContain('Thinking...');
  });

  it('keeps the whimsical phrase when msSinceLastDelta is under the freeze threshold', () => {
    const text = UIFactory.busyPhrase(0, undefined, { msSinceLastDelta: 500 });
    expect(text).toContain('Thinking...');
    expect(text).not.toContain('Stalled');
  });

  it('freezes the phrase rotation and shows "Stalled Ns" once msSinceLastDelta crosses the freeze threshold (mid-stream)', () => {
    // frame=1000 would normally rotate past "Thinking..."; with a stall in
    // effect the rotated phrase must NOT appear. outputTokens > 0: "Stalled"
    // is the MID-STREAM label (pre-first-token silence says "Waiting for model").
    const text = UIFactory.busyPhrase(1000, 200, { msSinceLastDelta: 12_000 });
    expect(text).toContain('Stalled 12s');
    for (const p of ['Thinking...', 'Vibing...', 'Manifesting...']) {
      expect(text).not.toContain(p);
    }
  });

  it('pre-first-token silence renders "Waiting for model", never "Stalled"', () => {
    const text = UIFactory.busyPhrase(1000, 0, { msSinceLastDelta: 12_000 });
    expect(text).toContain('Waiting for model 12s');
    expect(text).not.toContain('Stalled');
  });

  it('shows "Reconnecting (attempt k/n)" instead of "Stalled Ns" when reconnect info is present', () => {
    const text = UIFactory.busyPhrase(0, undefined, { msSinceLastDelta: 5_000, reconnect: { attempt: 2, maxAttempts: 4 } });
    expect(text).toContain('Reconnecting (attempt 2/4)');
    expect(text).not.toContain('Stalled');
  });

  it('reconnect label takes precedence even before the freeze threshold is crossed', () => {
    const text = UIFactory.busyPhrase(0, undefined, { msSinceLastDelta: 100, reconnect: { attempt: 1, maxAttempts: 3 } });
    expect(text).toContain('Reconnecting (attempt 1/3)');
  });

  it('shows "Waiting for your approval" (no stall/provider framing) when an approval is pending', () => {
    // The stream is silent because we asked the user a question, not because
    // the model stalled: the honest label wins, and no token-rate or
    // first-token readout implies the model is still working.
    const phrase = UIFactory.busyPhrase(1000, undefined, { msSinceLastDelta: 45_000 }, true);
    expect(phrase).toContain('Waiting for your approval');
    expect(phrase).not.toContain('Stalled');
    const text = throbberRowText({ phrase, approvalPending: true, ttftMs: 280, tokenSpeed: 40 });
    expect(text).not.toContain('tok/s');
    expect(text).not.toContain('first token');
  });

  it('approval label takes precedence over a reconnect label', () => {
    const text = UIFactory.busyPhrase(0, undefined, { msSinceLastDelta: 5_000, reconnect: { attempt: 2, maxAttempts: 4 } }, true);
    expect(text).toContain('Waiting for your approval');
    expect(text).not.toContain('Reconnecting');
  });

  it('a genuine mid-stream stall is unchanged when no approval is pending', () => {
    const text = UIFactory.busyPhrase(1000, 200, { msSinceLastDelta: 12_000 }, false);
    expect(text).toContain('Stalled 12s');
    expect(text).not.toContain('Waiting for your approval');
  });
});
