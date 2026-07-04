import { describe, test, expect } from 'bun:test';
import { createHooksModalSurface, type HooksModalActivityTracker, type HooksModalDispatcher, type HooksModalWorkbench } from '../../../panels/modals/hooks-modal.ts';
import type { HookActivityRecord, HookAuthoringAction, HookChain, HookDefinition } from '@pellux/goodvibes-sdk/platform/hooks';
import { actionCtx, captureCommands, open, tabText } from './modal-surface-test-helpers.ts';

type HookEntry = { pattern: string; hook: HookDefinition };

function fixedDeps(overrides: { hooks?: HookEntry[]; chains?: HookChain[]; recentActions?: HookAuthoringAction[]; activity?: readonly HookActivityRecord[] } = {}): { hookDispatcher: HooksModalDispatcher; hookWorkbench: HooksModalWorkbench; hookActivityTracker: HooksModalActivityTracker } {
  const hooks = overrides.hooks ?? [];
  return {
    hookDispatcher: { listHooks: () => hooks, getChains: () => overrides.chains ?? [] },
    hookWorkbench: { getHooksFilePath: () => '/fixture/hooks.json', listManagedHooks: () => hooks, listManagedChains: () => [], listRecentActions: () => overrides.recentActions ?? [], getLastSimulation: () => null },
    hookActivityTracker: { listRecent: (limit = 3) => (overrides.activity ?? []).slice(0, limit) },
  };
}
function makeEntry(name: string, pattern: string, enabled = true): HookEntry {
  return { pattern, hook: { match: pattern, type: 'command', command: 'echo x', name, enabled } };
}

describe('hooks modal surface', () => {
  test('surface identity', () => { expect(createHooksModalSurface(fixedDeps()).name).toBe('hooks-modal'); });

  test('empty registry renders next-step guidance', () => {
    const text = tabText(open(createHooksModalSurface(fixedDeps())), 'hooks');
    expect(text).toContain('No hooks are currently registered.');
    expect(text).toContain('/hooks');
    expect(text).toContain('/settings');
  });

  test('populated registry: posture header + folded contract detail; Activity is a second tab', () => {
    const view = open(createHooksModalSurface(fixedDeps({ hooks: [makeEntry('pre-guard', 'Pre:tool:*', true), makeEntry('post-log', 'Post:file:write', false)] })));
    expect(view.tabs.map((t) => t.id)).toEqual(['hooks', 'activity']);
    const text = tabText(view, 'hooks');
    expect(text).toContain('hooks 2');
    expect(text).toContain('pre-guard');
    expect(text).toContain('ENABLED');
    expect(text).toContain('DISABLED');
    expect(view.tabs[0]!.rows.map((r) => r.id)).toEqual(['Pre:tool:*#pre-guard', 'Post:file:write#post-log']);
  });

  test('toggle/remove/simulate route to /hooks; toggle on a disabled hook enables it', () => {
    const surface = createHooksModalSurface(fixedDeps({ hooks: [makeEntry('post-log', 'Post:file:write', false)] }));
    open(surface);
    const row = { id: 'Post:file:write#post-log', label: '' };
    const toggle = captureCommands();
    surface.onAction?.('toggle', actionCtx(row, toggle.extra));
    expect(toggle.calls).toEqual([['hooks', ['enable', 'post-log']]]);
    const sim = captureCommands();
    surface.onAction?.('simulate', actionCtx(row, sim.extra));
    expect(sim.calls).toEqual([['hooks', ['simulate', 'Post:file:write']]]);
  });

  test('unnamed hook prints instead of dispatching a toggle/remove command', () => {
    const surface = createHooksModalSurface(fixedDeps({ hooks: [{ pattern: 'Pre:tool:*', hook: { match: 'Pre:tool:*', type: 'command', command: 'echo x' } }] }));
    open(surface);
    const printed: string[] = [];
    const cap = captureCommands();
    surface.onAction?.('toggle', actionCtx({ id: 'Pre:tool:*#0', label: '' }, { ...cap.extra, print: (m) => printed.push(m) }));
    expect(cap.calls).toEqual([]);
    expect(printed).toEqual(['This hook has no managed name to toggle.']);
  });

  test('Activity tab shows the wider activity window', () => {
    const activity: HookActivityRecord[] = Array.from({ length: 5 }, (_, i) => ({ timestamp: i, path: `Pre:tool:tool-${i}`, specific: `tool-${i}`, pattern: 'Pre:tool:*', hookName: 'pre-guard', hookType: 'command', ok: true, decision: 'allow', durationMs: 1, async: false }));
    const view = open(createHooksModalSurface(fixedDeps({ hooks: [makeEntry('pre-guard', 'Pre:tool:*', true)], activity })));
    const text = tabText(view, 'activity');
    expect(text).toContain('tool-0');
    expect(text).toContain('tool-4'); // full window, not clipped at 3
  });
});
