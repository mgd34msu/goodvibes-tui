import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerOperatorPanelCommand } from '../../input/commands/operator-panel-runtime.ts';
import { PanelManager } from '../../panels/panel-manager.ts';

// Minimal CommandContext for the /panel command. showPanel mirrors production:
// it opens the id (which fires a redirect for MIGRATE-TO-MODAL ids); the
// workspace-reveal side effect is irrelevant to these assertions.
function makeCtx(pm: PanelManager, out: string[]): CommandContext {
  return {
    print: (message: string) => out.push(message),
    showPanel: (id: string) => { pm.open(id); },
    focusPanels: () => {},
    renderRequest: () => {},
    workspace: { panelManager: pm },
  } as unknown as CommandContext;
}

describe('/panel open — front-door honesty (W6 review)', () => {
  // Finding 3: `/panel open sessions` must open the session-picker modal and
  // say so honestly, rather than claiming a panel opened (or, before the
  // openModal fix, printing "not available yet").
  test("open on a MIGRATE-TO-MODAL id ('sessions') fires the redirect and prints the moved-to line, not 'Panel opened'", async () => {
    const registry = new CommandRegistry();
    registerOperatorPanelCommand(registry);
    const pm = new PanelManager();
    pm.registerModalRedirect('sessions', 'sessionPicker');
    const opened: string[] = [];
    pm.setOpenModalCallback((name) => opened.push(name));
    const out: string[] = [];

    await registry.execute('panel', ['open', 'sessions'], makeCtx(pm, out));

    expect(opened).toEqual(['sessionPicker']); // the redirect actually fired
    expect(out.join('\n')).toContain('"sessions" moved to the sessionPicker modal');
    expect(out.join('\n')).not.toContain('Panel opened: sessions'); // no lie
  });

  // Finding 6: a deleted/unknown panel id throws "No panel type registered
  // with id: <id>"; the open path must surface the same friendly line the
  // bare-/panel path uses, not the raw error.
  test('open on a deleted/unknown panel id prints the friendly unknown-panel line, not the raw registry error', async () => {
    const registry = new CommandRegistry();
    registerOperatorPanelCommand(registry);
    const pm = new PanelManager(); // 'debug' is neither registered nor a redirect
    const out: string[] = [];

    await registry.execute('panel', ['open', 'debug'], makeCtx(pm, out));

    expect(out.join('\n')).toContain('Unknown panel "debug". Use /panel list to see available panels.');
    expect(out.join('\n')).not.toContain('No panel type registered with id');
  });

  // A genuine registered panel still reports "Panel opened: <id>" (the moved-to
  // line is redirect-only) — guards against the redirect branch swallowing the
  // normal success path.
  test('open on a genuine registered panel still reports "Panel opened"', async () => {
    const registry = new CommandRegistry();
    registerOperatorPanelCommand(registry);
    const pm = new PanelManager();
    pm.registerType({
      id: 'git', name: 'Git', icon: 'G', category: 'development', description: '',
      factory: () => ({
        id: 'git', name: 'Git', icon: 'G', category: 'development',
        onActivate: () => {}, onDeactivate: () => {}, onDestroy: () => {}, render: () => [],
        isTransient: false, isPinned: false, needsRender: false,
        invalidate: () => {}, markRendered: () => {},
      }),
    });
    const out: string[] = [];

    await registry.execute('panel', ['open', 'git'], makeCtx(pm, out));

    expect(out.join('\n')).toContain('Panel opened: git');
  });
});
