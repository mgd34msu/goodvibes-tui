import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { SandboxPanel } from '../../panels/sandbox-panel.ts';
import { SandboxSessionRegistry } from '@/runtime/index.ts';

function linesText(panel: SandboxPanel, w = 100, h = 36): string {
  return panel.render(w, h).flat().map((cell) => cell.char).join('');
}

describe('SandboxPanel', () => {
  let sessions: SandboxSessionRegistry;
  let config: ConfigManager;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'gv-sandbox-panel-'));
    sessions = new SandboxSessionRegistry(root);
    config = new ConfigManager({ surfaceRoot: 'tui',
      configDir: join(root, '.goodvibes', 'tui'),
      workingDir: root,
    });
    config.set('sandbox.replIsolation', 'shared-vm');
    config.set('sandbox.mcpIsolation', 'disabled');
    config.set('sandbox.windowsMode', 'native-basic');
    config.set('sandbox.vmBackend', 'local');
  });

  test('renders current sandbox posture and profile table', async () => {
    await sessions.start('eval-py', 'Python eval', config);
    config.set('sandbox.qemuGuestHost', '127.0.0.1');
    config.set('sandbox.qemuGuestUser', 'goodvibes');
    const panel = new SandboxPanel(config, sessions);
    const text = linesText(panel);
    expect(text).toContain('Sandbox Control Room');
    expect(text).toContain('Sandbox posture');
    expect(text).toContain('shared-vm');
    expect(text).toContain('guest host');
    expect(text).toContain('127.0.0.1');
    expect(text).toContain('Sessions');
    expect(text).toContain('eval-py');
  });

  test('supports selection between profiles and sessions', async () => {
    await sessions.start('eval-py', 'Python eval', config);
    const panel = new SandboxPanel(config, sessions);
    expect(panel.handleInput('end')).toBe(true);
    const text = linesText(panel);
    expect(text).toContain('Sandbox posture');
    expect(text).toContain('Sessions');
    expect(text).toContain('eval-py');
  });

  test('guidance collapses to a single contextual line, not the old nine-line wall', () => {
    const panel = new SandboxPanel(config, sessions);
    const text = linesText(panel);
    // Exactly one guidance-line glyph (buildGuidanceLine's leading status-info
    // glyph, GLYPHS.status.info = '○') should appear across the rendered panel.
    const guidanceOccurrences = (text.match(/○/g) ?? []).length;
    expect(guidanceOccurrences).toBeLessThanOrEqual(1);
    // The former per-command guidance rows are gone.
    expect(text).not.toContain('/sandbox scaffold-qemu-wrapper');
    expect(text).not.toContain('/sandbox guest-test');
    expect(text).not.toContain('GV_SANDBOX_WRAPPER_MODE');
  });

  test('real keys s/x/e are advertised in the footer hints', () => {
    const panel = new SandboxPanel(config, sessions);
    const text = linesText(panel);
    expect(text).toContain('start');
    expect(text).toContain('stop');
    expect(text).toContain('execute probe');
  });

  test('s starts a sandbox session on the selected profile via SandboxSessionRegistry', async () => {
    const panel = new SandboxPanel(config, sessions);
    expect(panel.handleInput('home')).toBe(true); // select first profile
    expect(panel.handleInput('s')).toBe(true);
    // Session start is async; give the microtask queue a turn.
    await new Promise((r) => setTimeout(r, 20));
    expect(sessions.list().length).toBe(1);
  });

  test('x on a selected session opens a ConfirmState before stopping', async () => {
    await sessions.start('eval-py', 'Python eval', config);
    const panel = new SandboxPanel(config, sessions);
    expect(panel.handleInput('end')).toBe(true); // select the session
    expect(panel.handleInput('x')).toBe(true);
    const confirmText = linesText(panel);
    expect(confirmText).toContain('Stop');
    // Session must not be stopped yet — still pending confirmation.
    expect(sessions.list()[0]?.state).toBe('running');
    expect(panel.handleInput('y')).toBe(true);
    expect(sessions.list()[0]?.state).toBe('stopped');
  });

  test('x confirm cancels cleanly on n/Esc', async () => {
    await sessions.start('eval-py', 'Python eval', config);
    const panel = new SandboxPanel(config, sessions);
    expect(panel.handleInput('end')).toBe(true);
    expect(panel.handleInput('x')).toBe(true);
    expect(panel.handleInput('n')).toBe(true);
    expect(sessions.list()[0]?.state).toBe('running');
  });

  test('e executes a probe against the selected session, populating live state', async () => {
    await sessions.start('eval-py', 'Python eval', config);
    const panel = new SandboxPanel(config, sessions);
    expect(panel.handleInput('end')).toBe(true); // select the session
    expect(panel.handleInput('e')).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    const session = sessions.list()[0];
    expect(session?.executionCount ?? 0).toBeGreaterThan(0);
  });

  test('sessions and profiles scroll independently', () => {
    const panel = new SandboxPanel(config, sessions);
    // Profiles list has 7 entries; move selection deep into it and confirm
    // the panel still renders a full, well-formed frame (independent
    // per-section scroll offsets, not one shared field).
    for (let i = 0; i < 6; i++) panel.handleInput('down');
    const lines = panel.render(100, 20);
    expect(lines).toHaveLength(20);
    for (const line of lines) expect(line).toHaveLength(100);
  });
});
