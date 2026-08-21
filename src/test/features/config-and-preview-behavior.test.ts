import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { getDisplayWidth } from '../../utils/terminal-width.ts';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-config-preview-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Config diff tests
// ---------------------------------------------------------------------------

describe('config diff logic', () => {
  let tmpDir: string;
  let cm: ConfigManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    cm = new ConfigManager({ surfaceRoot: 'tui',  workingDir: tmpDir, configDir: join(tmpDir, '.config-override') });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shows empty diff when all settings are at defaults', () => {
    // Reset all settings to defaults first, global ~/.goodvibes/tui/settings.json
    // may override some values on the dev machine, so we reset explicitly.
    cm.reset();
    const schema = cm.getSchema();
    const diffs: string[] = [];
    for (const setting of schema) {
      const currentVal = cm.get(setting.key);
      const defaultVal = setting.default;
      if (JSON.stringify(currentVal) !== JSON.stringify(defaultVal)) {
        diffs.push(setting.key);
      }
    }
    expect(diffs).toHaveLength(0);
  });

  it('shows changed setting in diff after set()', () => {
    // Reset to defaults first to ensure clean baseline
    cm.reset();
    // Change a setting from its default
    cm.set('display.lineNumbers', 'all');
    const schema = cm.getSchema();
    const diffs: string[] = [];
    for (const setting of schema) {
      const currentVal = cm.get(setting.key);
      const defaultVal = setting.default;
      if (JSON.stringify(currentVal) !== JSON.stringify(defaultVal)) {
        diffs.push(setting.key);
      }
    }
    expect(diffs).toContain('display.lineNumbers');
  });

  it('diff output includes the key and both values', () => {
    // Reset to defaults first, then change one setting
    cm.reset();
    cm.set('display.collapseThreshold', 50);
    const schema = cm.getSchema();
    const diffLines: string[] = [];
    for (const setting of schema) {
      const currentVal = cm.get(setting.key);
      const defaultVal = setting.default;
      if (JSON.stringify(currentVal) !== JSON.stringify(defaultVal)) {
        diffLines.push(`  ${setting.key.padEnd(36)} ${String(defaultVal)} \u2192 ${String(currentVal)}`);
      }
    }
    expect(diffLines.length).toBeGreaterThan(0);
    const line = diffLines.find(l => l.includes('display.collapseThreshold'));
    expect(line).toBeDefined();
    // Should contain the default (30) and new value (50)
    expect(line).toContain('30');
    expect(line).toContain('50');
  });
});

// ---------------------------------------------------------------------------
// Token speed calculation tests
// ---------------------------------------------------------------------------

describe('token speed calculation', () => {
  it('speed is deltaCount / elapsed when elapsed > 0', () => {
    const deltaCount = 120;
    const elapsed = 2; // seconds
    const speed = elapsed > 0 ? deltaCount / elapsed : 0;
    expect(speed).toBe(60);
    expect(speed).toBeGreaterThan(0);
  });

  it('speed is 0 when elapsed is 0', () => {
    const deltaCount = 50;
    const elapsed = 0;
    const speed = elapsed > 0 ? deltaCount / elapsed : 0;
    expect(speed).toBe(0);
  });

  it('speed increases as more deltas arrive', () => {
    const elapsed = 1;
    const speedA = 10 / elapsed;
    const speedB = 100 / elapsed;
    expect(speedB).toBeGreaterThan(speedA);
  });
});

// ---------------------------------------------------------------------------
// Tool preview tests
// ---------------------------------------------------------------------------

describe('tool preview truncation', () => {
  it('renders tool preview with tool name and args', () => {
    const name = 'read';
    const args = '{"path":"/home/user/file.ts"}';
    const preview = args.length > 60 ? args.slice(0, 57) + '...' : args;
    const toolPreview = `${name}(${preview})`;
    expect(toolPreview).toContain('read');
    expect(toolPreview).toContain('/home/user/file.ts');
  });

  it('truncates args at 60 chars with ellipsis', () => {
    const name = 'exec';
    const longArgs = '{"command":"' + 'x'.repeat(80) + '"}';
    const preview = longArgs.length > 60 ? longArgs.slice(0, 57) + '...' : longArgs;
    expect(longArgs.length).toBeGreaterThan(60);
    expect(preview).toHaveLength(60);
    expect(preview.endsWith('...')).toBe(true);
  });

  it('does not truncate short args', () => {
    const name = 'read';
    const shortArgs = '{"path":"/tmp"}';
    const preview = shortArgs.length > 60 ? shortArgs.slice(0, 57) + '...' : shortArgs;
    expect(preview).toBe(shortArgs);
  });

  it('UIFactory.createThinkingFragment includes tool preview line when provided', () => {
    const width = 80;
    const toolPreview = 'read_file({"path":"/home/user/test.ts"})';
    const lines = UIFactory.createThinkingFragment(width, '-', 0, undefined, toolPreview);
    // Should have 4 lines: blank + spinner + preview + blank
    expect(lines).toHaveLength(4);
    // The preview line chars should include the tool name
    const previewLine = lines[2];
    const text = previewLine.map(c => c.char).join('');
    expect(text).toContain('read_file');
  });

  it('UIFactory.createThinkingFragment without tool preview has 3 lines', () => {
    const width = 80;
    const lines = UIFactory.createThinkingFragment(width, '-', 0, undefined, undefined);
    // blank + spinner + blank (no preview line)
    expect(lines).toHaveLength(3);
  });

  it('tool preview display width does not exceed terminal width', () => {
    const width = 40;
    const longPreview = 'some_tool(' + 'a'.repeat(100) + ')';
    const lines = UIFactory.createThinkingFragment(width, '-', 0, undefined, longPreview);
    // The preview line should not exceed width cells
    const previewLine = lines[2];
    expect(previewLine).toHaveLength(width);
    // Compute display width of non-space content
    const text = previewLine.map(c => c.char).join('');
    const displayW = getDisplayWidth(text.trimEnd());
    expect(displayW).toBeLessThanOrEqual(width);
  });

  it('UIFactory.createThinkingFragment includes elapsed suffix when elapsedMs provided', () => {
    const width = 80;
    const elapsedMs = 12_000; // 12 seconds
    const lines = UIFactory.createThinkingFragment(width, '-', 0, undefined, undefined, undefined, undefined, elapsedMs);
    // blank + spinner + blank (no preview line)
    expect(lines).toHaveLength(3);
    const spinnerLine = lines[1];
    const text = spinnerLine.map(c => c.char).join('');
    // Should include the elapsed time suffix e.g. '(12s)'
    expect(text).toContain('(12s)');
  });

  it('UIFactory.createThinkingFragment includes TTFT suffix when ttftMs provided', () => {
    const width = 80;
    const ttftMs = 350;
    const lines = UIFactory.createThinkingFragment(width, '-', 0, undefined, undefined, undefined, undefined, undefined, ttftMs);
    expect(lines).toHaveLength(3);
    const spinnerLine = lines[1];
    const text = spinnerLine.map(c => c.char).join('');
    // Human phrasing, e.g. '(first token 0.3s)', not the raw 'ttft:350ms' form.
    expect(text).toContain('(first token 0.3s)');
  });

  it('UIFactory.createThinkingFragment includes both elapsed and TTFT when both provided', () => {
    const width = 80;
    const lines = UIFactory.createThinkingFragment(width, '-', 0, undefined, undefined, undefined, undefined, 5000, 280);
    expect(lines).toHaveLength(3);
    const spinnerLine = lines[1];
    const text = spinnerLine.map(c => c.char).join('');
    expect(text).toContain('(5s)');
    expect(text).toContain('(first token 0.2s)');
  });

  it('UIFactory.createThinkingFragment elapsed suffix omitted when elapsedMs is undefined', () => {
    const width = 80;
    const lines = UIFactory.createThinkingFragment(width, '-', 0, undefined, undefined);
    const spinnerLine = lines[1];
    const text = spinnerLine.map(c => c.char).join('');
    expect(text).not.toMatch(/\(\d+/);
  });

  // -------------------------------------------------------------------------
  // Stall-honesty indicator: frozen phrase rotation + stalled/
  // reconnecting label once real silence has gone on long enough.
  // -------------------------------------------------------------------------

  it('shows a rotating whimsical phrase when no stallInfo is provided (unchanged baseline)', () => {
    const width = 80;
    const lines = UIFactory.createThinkingFragment(width, '-', 0);
    const text = lines[1].map(c => c.char).join('');
    expect(text).toContain('Thinking...');
  });

  it('keeps the whimsical phrase when msSinceLastDelta is under the freeze threshold', () => {
    const width = 80;
    const lines = UIFactory.createThinkingFragment(
      width, '-', 0, undefined, undefined, undefined, undefined, undefined, undefined,
      { msSinceLastDelta: 500 },
    );
    const text = lines[1].map(c => c.char).join('');
    expect(text).toContain('Thinking...');
    expect(text).not.toContain('Stalled');
  });

  it('freezes the phrase rotation and shows "Stalled Ns" once msSinceLastDelta crosses the freeze threshold (mid-stream)', () => {
    const width = 80;
    // frame=1000 would normally rotate past "Thinking..." (PHRASE_ROTATION_FRAMES=375);
    // with a stall in effect, the rotated phrase must NOT appear at all.
    // outputTokens > 0: "Stalled" is the MID-STREAM label, pre-first-token
    // silence renders "Waiting for model" instead (an earlier replay fix).
    const lines = UIFactory.createThinkingFragment(
      width, '-', 1000, undefined, undefined, 40, 200, undefined, undefined,
      { msSinceLastDelta: 12_000 },
    );
    const text = lines[1].map(c => c.char).join('');
    expect(text).toContain('Stalled 12s');
    for (const p of ['Thinking...', 'Vibing...', 'Manifesting...']) {
      expect(text).not.toContain(p);
    }
  });

  it('pre-first-token silence renders "Waiting for model", never "Stalled"', () => {
    const width = 80;
    const lines = UIFactory.createThinkingFragment(
      width, '-', 1000, undefined, undefined, 40, 0, undefined, undefined,
      { msSinceLastDelta: 12_000 },
    );
    const text = lines[1].map(c => c.char).join('');
    expect(text).toContain('Waiting for model 12s');
    expect(text).not.toContain('Stalled');
  });

  it('shows "Reconnecting (attempt k/n)" instead of "Stalled Ns" when reconnect info is present', () => {
    const width = 80;
    const lines = UIFactory.createThinkingFragment(
      width, '-', 0, undefined, undefined, undefined, undefined, undefined, undefined,
      { msSinceLastDelta: 5_000, reconnect: { attempt: 2, maxAttempts: 4 } },
    );
    const text = lines[1].map(c => c.char).join('');
    expect(text).toContain('Reconnecting (attempt 2/4)');
    expect(text).not.toContain('Stalled');
  });

  it('reconnect label takes precedence even before the freeze threshold is crossed', () => {
    // A reconnect attempt is itself proof the stream is not "thinking",
    // show it immediately, do not wait for THINKING_STALL_FREEZE_MS.
    const width = 80;
    const lines = UIFactory.createThinkingFragment(
      width, '-', 0, undefined, undefined, undefined, undefined, undefined, undefined,
      { msSinceLastDelta: 100, reconnect: { attempt: 1, maxAttempts: 3 } },
    );
    const text = lines[1].map(c => c.char).join('');
    expect(text).toContain('Reconnecting (attempt 1/3)');
  });

  it('shows "Waiting for your approval" (no stall/provider framing) when an approval is pending', () => {
    // An approval card is waiting on the USER: the stream is silent because we asked a question,
    // not because the model stalled. Even with a stall clock long past the freeze threshold, the
    // honest label wins, never "Stalled Ns...".
    const width = 80;
    const lines = UIFactory.createThinkingFragment(
      width, '-', 1000, undefined, undefined, undefined, undefined, undefined, 280,
      { msSinceLastDelta: 45_000 }, true,
    );
    const text = lines[1].map(c => c.char).join('');
    expect(text).toContain('Waiting for your approval');
    expect(text).not.toContain('Stalled');
    // No token-rate / ttft readouts that would imply the model is still working.
    expect(text).not.toContain('tok/s');
    expect(text).not.toContain('ttft');
  });

  it('approval label takes precedence over a reconnect label', () => {
    const width = 80;
    const lines = UIFactory.createThinkingFragment(
      width, '-', 0, undefined, undefined, undefined, undefined, undefined, undefined,
      { msSinceLastDelta: 5_000, reconnect: { attempt: 2, maxAttempts: 4 } }, true,
    );
    const text = lines[1].map(c => c.char).join('');
    expect(text).toContain('Waiting for your approval');
    expect(text).not.toContain('Reconnecting');
  });

  it('a genuine mid-stream stall is unchanged when no approval is pending', () => {
    // Regression guard: the honest stall label must still appear for a real
    // provider silence AFTER tokens started flowing (out>0; pre-first-token
    // silence is "Waiting for model" per an earlier replay fix).
    const width = 80;
    const lines = UIFactory.createThinkingFragment(
      width, '-', 1000, undefined, undefined, 40, 200, undefined, undefined,
      { msSinceLastDelta: 12_000 }, false,
    );
    const text = lines[1].map(c => c.char).join('');
    expect(text).toContain('Stalled 12s');
    expect(text).not.toContain('Waiting for your approval');
  });
});
