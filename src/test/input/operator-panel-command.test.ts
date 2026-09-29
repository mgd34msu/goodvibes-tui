import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerOperatorPanelCommand } from '../../input/commands/operator-panel-runtime.ts';
import { resolveViewName, type ViewTarget } from '../../input/views.ts';

/** A context whose openView resolves names the way the shell does (no config modals registered). */
function makeCtx(out: string[], opened: Array<{ name: string; target?: ViewTarget }>): CommandContext {
  return {
    print: (message: string) => out.push(message),
    renderRequest: () => {},
    openView: (name: string, target?: ViewTarget) => {
      if (!resolveViewName(name, () => undefined)) return false;
      opened.push({ name, target });
      return true;
    },
  } as unknown as CommandContext;
}

async function run(args: string[]): Promise<{ out: string[]; opened: Array<{ name: string; target?: ViewTarget }> }> {
  const registry = new CommandRegistry();
  registerOperatorPanelCommand(registry);
  const out: string[] = [];
  const opened: Array<{ name: string; target?: ViewTarget }> = [];
  await registry.execute('panel', args, makeCtx(out, opened));
  return { out, opened };
}

describe('/panel: a thin alias onto the modal views', () => {
  test('/panel <old name> opens the modal that holds it', async () => {
    const { opened } = await run(['fleet']);
    expect(opened).toEqual([{ name: 'fleet', target: undefined }]);
  });

  test('/panel open fleet --target <id>:<kind> carries the deep link to the Agents modal', async () => {
    const { opened } = await run(['open', 'fleet', '--target', 'agent-7:agent']);
    expect(opened).toEqual([{ name: 'fleet', target: { id: 'agent-7', kind: 'agent' } }]);
  });

  test('an unknown name says so and points at /panel list', async () => {
    const { out, opened } = await run(['open', 'debug']);
    expect(opened).toEqual([]);
    expect(out.join('\n')).toContain('Nothing holds "debug"');
  });

  test('/panel list says where each old name went', async () => {
    const { out } = await run(['list']);
    const text = out.join('\n');
    expect(text).toContain('Agents (/agents, F2)');
    expect(text).toContain('cockpit');
    expect(text).toContain('Usage (/usage): tokens, context, cost');
    expect(text).toContain('Changes (/changes): git, diff, review');
  });

  test('the pane-only verbs say there are no panes', async () => {
    for (const verb of ['close', 'move', 'focus', 'split', 'width', 'height']) {
      const { out } = await run([verb]);
      expect(out.join('\n')).toContain('There are no panes');
    }
  });
});
