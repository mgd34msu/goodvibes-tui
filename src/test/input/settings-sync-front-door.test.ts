/**
 * item 3 (report-vs-modal front doors), /settings-sync has a full
 * modal surface (settings-sync-modal), so the bare command now opens it; the
 * old bare/`review` transcript report moved to an explicit `report`
 * subcommand so scripts calling bare `/settings-sync` for text output keep
 * working via `/settings-sync report`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { registerSettingsSyncRuntimeCommands } from '../../input/commands/settings-sync-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('/settings-sync front door (item 3)', () => {
  let root = '';
  let configManager: ConfigManager;

  beforeEach(() => {
    root = makeProjectTempDir('gv-settings-sync-front-door');
    configManager = new ConfigManager({ surfaceRoot: 'tui', configDir: join(root, '.goodvibes', 'tui') });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function getCommand() {
    const registry = new CommandRegistry();
    registerSettingsSyncRuntimeCommands(registry);
    return registry.get('settings-sync')!;
  }

  function makeContext(): { ctx: CommandContext; printed: string[]; opened: string[] } {
    const printed: string[] = [];
    const opened: string[] = [];
    const ctx = {
      platform: { configManager, config: {} as never },
      workspace: { shellPaths: {} as never },
      openModal: (name: string) => opened.push(name),
      print: (message: string) => printed.push(message),
    } as unknown as CommandContext;
    return { ctx, printed, opened };
  }

  test('bare /settings-sync opens the modal, prints nothing', async () => {
    const cmd = getCommand();
    const { ctx, printed, opened } = makeContext();
    await cmd.handler([], ctx);
    expect(opened).toEqual(['settings-sync-modal']);
    expect(printed).toEqual([]);
  });

  test('/settings-sync report prints the legacy transcript review (scriptability preserved), does not open the modal', async () => {
    const cmd = getCommand();
    const { ctx, printed, opened } = makeContext();
    await cmd.handler(['report'], ctx);
    expect(opened).toEqual([]);
    expect(printed.length).toBe(1);
    expect(printed[0]).toContain('Settings Sync Review');
  });

  test('/settings-sync review is the same explicit synonym it always was (still a report, still no modal)', async () => {
    const cmd = getCommand();
    const { ctx, printed, opened } = makeContext();
    await cmd.handler(['review'], ctx);
    expect(opened).toEqual([]);
    expect(printed[0]).toContain('Settings Sync Review');
  });

  test('/settings-sync panel still opens the modal directly (unchanged explicit subcommand)', async () => {
    const cmd = getCommand();
    const { ctx, opened } = makeContext();
    await cmd.handler(['panel'], ctx);
    expect(opened).toEqual(['settings-sync-modal']);
  });

  test('an unrecognized subcommand still falls back to the report (unchanged lenient fallback)', async () => {
    const cmd = getCommand();
    const { ctx, printed, opened } = makeContext();
    await cmd.handler(['not-a-real-subcommand'], ctx);
    expect(opened).toEqual([]);
    expect(printed[0]).toContain('Settings Sync Review');
  });

  test('/settings-sync staged still dispatches normally, not affected by the front-door change', async () => {
    const cmd = getCommand();
    const { ctx, printed, opened } = makeContext();
    await cmd.handler(['staged'], ctx);
    expect(opened).toEqual([]);
    expect(printed[0]).toContain('No staged managed settings bundle is available.');
  });
});
