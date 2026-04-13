import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../../config/manager.ts';
import { SandboxPanel } from '../../panels/sandbox-panel.ts';
import { SandboxSessionRegistry } from '../../runtime/sandbox/session-registry.ts';

describe('SandboxPanel', () => {
  let sessions: SandboxSessionRegistry;
  let config: ConfigManager;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'gv-sandbox-panel-'));
    sessions = new SandboxSessionRegistry(root);
    config = new ConfigManager({
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
    const text = panel.render(100, 36).flat().map((cell) => cell.char).join('');
    expect(text).toContain('Sandbox Control Room');
    expect(text).toContain('Sandbox posture');
    expect(text).toContain('shared-vm');
    expect(text).toContain('guest host');
    expect(text).toContain('127.0.0.1');
    expect(text).toContain('/sandbox wrapper-test <profile>');
    expect(text).toContain('Sessions');
    expect(text).toContain('eval-py');
  });

  test('supports selection between profiles and sessions', async () => {
    await sessions.start('eval-py', 'Python eval', config);
    const panel = new SandboxPanel(config, sessions);
    expect(panel.handleInput('end')).toBe(true);
    const text = panel.render(100, 36).flat().map((cell) => cell.char).join('');
    expect(text).toContain('Sandbox posture');
    expect(text).toContain('Sessions');
    expect(text).toContain('eval-py');
  });
});
