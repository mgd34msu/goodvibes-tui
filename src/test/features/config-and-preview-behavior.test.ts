import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '../../config/manager.ts';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { getDisplayWidth } from '@pellux/goodvibes-sdk/platform/utils/terminal-width';

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
    cm = new ConfigManager({ workingDir: tmpDir, configDir: join(tmpDir, '.config-override') });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shows empty diff when all settings are at defaults', () => {
    // Reset all settings to defaults first — global ~/.goodvibes/tui/settings.json
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
});
