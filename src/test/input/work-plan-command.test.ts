import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerWorkPlanRuntimeCommands } from '../../input/commands/work-plan-runtime.ts';
import { WorkPlanStore } from '../../work-plans/work-plan-store.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeContext(out: string[], opened: string[], store: WorkPlanStore): CommandContext {
  return {
    session: {
      conversationManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-work-plan',
      },
    },
    provider: {
      providerRegistry: {} as never,
    },
    workspace: {
      workPlanStore: store,
    },
    platform: {
      config: {} as never,
      configManager: {} as never,
    },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
    },
    renderRequest: () => {},
    print: (text: string) => { out.push(text); },
    exit: () => {},
    showPanel: (panelId) => { opened.push(panelId); },
    // /work-plan open now routes to the 'work-plan' modal via ctx.openModal.
    openModal: (name: string) => { opened.push(name); },
  };
}

describe('workplan command', () => {
  test('adds, lists, and updates persistent work plan items', async () => {
    const registry = new CommandRegistry();
    registerWorkPlanRuntimeCommands(registry);
    const command = registry.get('workplan');
    expect(command).toBeDefined();
    const store = new WorkPlanStore({
      homeDirectory: makeProjectTempDir('gv-work-plan-command'),
      projectId: 'project:command',
      projectRoot: '/tmp/command',
    });
    const out: string[] = [];
    const opened: string[] = [];
    const ctx = makeContext(out, opened, store);

    await command!.handler(['add', 'Ship', 'persistent', 'plan', '--owner', 'tui'], ctx);
    expect(opened).toContain('work-plan-modal');
    const item = store.listItems()[0]!;
    expect(item.title).toBe('Ship persistent plan');
    expect(item.owner).toBe('tui');

    await command!.handler(['done', item.id.slice(0, 8)], ctx);
    expect(store.listItems()[0]?.status).toBe('done');

    out.length = 0;
    await command!.handler(['list'], ctx);
    expect(out.join('\n')).toContain('Ship persistent plan');
    expect(out.join('\n')).toContain('done');
  });

  // W6 command-path parity: the work-plan modal's edit/export actions route to
  // these verbs (thin wrappers over WorkPlanStore.updateItem / exportMarkdown).
  test('edit patches an item and export writes the plan markdown to disk', async () => {
    const registry = new CommandRegistry();
    registerWorkPlanRuntimeCommands(registry);
    const command = registry.get('workplan')!;
    const store = new WorkPlanStore({
      homeDirectory: makeProjectTempDir('gv-work-plan-edit'),
      projectId: 'project:edit',
      projectRoot: '/tmp/edit',
    });
    const out: string[] = [];
    const ctx = makeContext(out, [], store);

    await command.handler(['add', 'Original title'], ctx);
    const id = store.listItems()[0]!.id.slice(0, 8);

    // edit: bare words are the new title (parseAddArgs convention), flags patch fields.
    out.length = 0;
    await command.handler(['edit', id, 'Renamed task', '--owner', 'mike'], ctx);
    const edited = store.listItems()[0]!;
    expect(edited.title).toBe('Renamed task');
    expect(edited.owner).toBe('mike');
    expect(out.join('\n')).toContain('Updated work plan item');

    // edit with no patch fields prints usage (no silent no-op).
    out.length = 0;
    await command.handler(['edit', id], ctx);
    expect(out.join('\n')).toContain('Usage: /work-plan edit');

    // export: writes a sibling .md and reports the path.
    out.length = 0;
    await command.handler(['export'], ctx);
    const printed = out.join('\n');
    expect(printed).toContain('Exported work plan markdown to');
    expect(printed).toContain('.md');
  });
});
