import { describe, test, expect } from 'bun:test';
import {
  bindHooksModal,
  hooksModalGoldenSurface,
  type HooksModalActivityTracker,
  type HooksModalDispatcher,
  type HooksModalWorkbench,
} from '../../../panels/modals/hooks-modal.ts';
import { EMPTY_VIEW } from '../../../panels/modals/modal-surface.ts';
import type { ModalConfig } from '../../../renderer/modal-factory.ts';
import type { HookActivityRecord, HookAuthoringAction, HookChain, HookDefinition } from '@pellux/goodvibes-sdk/platform/hooks';

/** Flatten a ModalConfig's text/list/title content into one searchable string. */
function configText(config: ModalConfig): string {
  const parts: string[] = [config.title];
  if (config.search !== undefined) parts.push(config.search);
  for (const section of config.sections) {
    if (section.content) parts.push(section.content);
    for (const item of section.items ?? []) parts.push(item.label);
  }
  for (const hint of config.hints ?? []) parts.push(hint);
  if (config.footer) parts.push(config.footer);
  return parts.join('\n');
}

type HookEntry = { pattern: string; hook: HookDefinition };

function fixedDeps(overrides: {
  hooks?: HookEntry[];
  chains?: HookChain[];
  managedHooks?: HookEntry[];
  managedChains?: HookChain[];
  recentActions?: HookAuthoringAction[];
  activity?: readonly HookActivityRecord[];
} = {}): { hookDispatcher: HooksModalDispatcher; hookWorkbench: HooksModalWorkbench; hookActivityTracker: HooksModalActivityTracker } {
  const hooks = overrides.hooks ?? [];
  const managedHooks = overrides.managedHooks ?? hooks;
  return {
    hookDispatcher: {
      listHooks: () => hooks,
      getChains: () => overrides.chains ?? [],
    },
    hookWorkbench: {
      getHooksFilePath: () => '/fixture/hooks.json',
      listManagedHooks: () => managedHooks,
      listManagedChains: () => overrides.managedChains ?? [],
      listRecentActions: () => overrides.recentActions ?? [],
      getLastSimulation: () => null,
    },
    hookActivityTracker: {
      listRecent: (limit = 3) => (overrides.activity ?? []).slice(0, limit),
    },
  };
}

function makeEntry(name: string, pattern: string, enabled = true): HookEntry {
  return { pattern, hook: { match: pattern, type: 'command', command: 'echo x', name, enabled } };
}

describe('hooks modal builder', () => {
  test('empty registry renders next-step guidance and no rows', () => {
    const surface = bindHooksModal(fixedDeps());
    surface.refresh();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('No hooks are currently registered.');
    expect(text).toContain('/hooks');
    expect(text).toContain('/settings');
    expect(surface.rowIds(EMPTY_VIEW)).toHaveLength(0);
  });

  test('populated registry lists hooks with posture summary and selected detail', () => {
    const hooks = [makeEntry('pre-guard', 'Pre:tool:*', true), makeEntry('post-log', 'Post:file:write', false)];
    const surface = bindHooksModal(fixedDeps({ hooks }));
    surface.refresh();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('pre-guard');
    expect(text).toContain('post-log');
    expect(text).toContain('hooks 2');
    expect(text).toContain('ENABLED');
    expect(text).toContain('DISABLED');
    expect(surface.rowIds(EMPTY_VIEW)).toEqual(['Pre:tool:*#pre-guard', 'Post:file:write#post-log']);
  });

  test('toggle/remove/simulate route to the /hooks command path (no modal-ized confirm)', () => {
    const hooks = [makeEntry('pre-guard', 'Pre:tool:*', true)];
    const surface = bindHooksModal(fixedDeps({ hooks }));
    surface.refresh();
    expect(surface.actions.toggle!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/hooks disable pre-guard' });
    expect(surface.actions.remove!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/hooks remove pre-guard' });
    expect(surface.actions.simulate!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/hooks simulate Pre:tool:*' });
  });

  test('toggle on a disabled hook routes to enable', () => {
    const hooks = [makeEntry('post-log', 'Post:file:write', false)];
    const surface = bindHooksModal(fixedDeps({ hooks }));
    surface.refresh();
    expect(surface.actions.toggle!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/hooks enable post-log' });
  });

  test('unnamed hook cannot be toggled/removed via command (prints instead)', () => {
    const hooks: HookEntry[] = [{ pattern: 'Pre:tool:*', hook: { match: 'Pre:tool:*', type: 'command', command: 'echo x' } }];
    const surface = bindHooksModal(fixedDeps({ hooks }));
    surface.refresh();
    expect(surface.actions.toggle!(EMPTY_VIEW)).toEqual({ kind: 'print', text: 'This hook has no managed name to toggle.' });
    expect(surface.actions.remove!(EMPTY_VIEW)).toEqual({ kind: 'print', text: 'This hook has no managed name to remove.' });
  });

  test('activity expand toggle stays in-modal and widens the rendered activity window', () => {
    const activity: HookActivityRecord[] = Array.from({ length: 5 }, (_, i) => ({
      timestamp: i,
      path: `Pre:tool:tool-${i}`,
      specific: `tool-${i}`,
      pattern: 'Pre:tool:*',
      hookName: 'pre-guard',
      hookType: 'command',
      ok: true,
      decision: 'allow',
      durationMs: 1,
      async: false,
    }));
    const hooks = [makeEntry('pre-guard', 'Pre:tool:*', true)];
    const surface = bindHooksModal(fixedDeps({ hooks, activity }));
    surface.refresh();
    const collapsed = configText(surface.buildConfig(EMPTY_VIEW));
    expect(collapsed).toContain('tool-2'); // within default window of 3
    expect(collapsed).not.toContain('tool-4'); // beyond default window
    expect(surface.actions.toggleActivity!(EMPTY_VIEW)).toEqual({ kind: 'none' });
    const expanded = configText(surface.buildConfig(EMPTY_VIEW));
    expect(expanded).toContain('tool-4');
    expect(expanded).toContain('collapse activity');
  });

  test('refresh action requests a re-render (refresh() itself is a no-op over live reads)', () => {
    const surface = bindHooksModal(fixedDeps({ hooks: [makeEntry('pre-guard', 'Pre:tool:*')] }));
    surface.refresh();
    expect(surface.actions.refresh!(EMPTY_VIEW)).toEqual({ kind: 'refresh' });
  });

  test('golden surface renders deterministically with both enabled and disabled hooks', () => {
    const surface = hooksModalGoldenSurface();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('pre-tool-guard');
    expect(text).toContain('post-write-log');
    expect(surface.rowIds(EMPTY_VIEW)).toHaveLength(2);
  });
});
