import { describe, expect, test } from 'bun:test';
import { createHookWorkbench } from '@pellux/goodvibes-sdk/platform/hooks';
import { HooksPanel } from '../../panels/hooks-panel.ts';
import type { Line } from '../../types/grid.ts';
import type { HookPointContract } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookActivityRecord } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookAuthoringAction, HookSimulationResult } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookChain, HookDefinition } from '@pellux/goodvibes-sdk/platform/hooks';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

function createPanel(params: {
  hooks?: Array<{ pattern: string; hook: HookDefinition }>;
  chains?: HookChain[];
  contracts?: HookPointContract[];
  activity?: readonly HookActivityRecord[];
  managedHooks?: Array<{ pattern: string; hook: HookDefinition }>;
  managedChains?: HookChain[];
  authoring?: HookAuthoringAction[];
  simulation?: HookSimulationResult | null;
  hooksFilePath?: string;
  toggleManagedHook?: (name: string, enabled: boolean) => boolean;
  removeManagedEntry?: (name: string) => boolean;
  simulateFn?: (eventPath: string) => HookSimulationResult;
} = {}): HooksPanel {
  const hookWorkbench = createHookWorkbench({
    hookDispatcher: {
      clear: () => {},
      loadFromFile: () => {},
    },
    configManager: {
      get: () => undefined as never,
      getWorkingDirectory: () => '/tmp',
    },
    hooksFilePathResolver: () => params.hooksFilePath ?? '/tmp/hooks.json',
  });
  return new HooksPanel(
    {
      listHooks: () => params.hooks ?? [],
      getChains: () => params.chains ?? [],
    },
    hookWorkbench,
    {
      listRecent: (limit = 3) => (params.activity ?? []).slice(0, limit),
    },
    {
      listContracts: () => params.contracts ?? [],
      listHooks: () => params.hooks ?? [],
      listChains: () => params.chains ?? [],
      listRecentActivity: (limit = 3) => (params.activity ?? []).slice(0, limit),
      getWorkbench: () => ({
        listManagedHooks: () => params.managedHooks ?? [],
        listManagedChains: () => params.managedChains ?? [],
        listRecentActions: (limit = 8) => (params.authoring ?? []).slice(0, limit),
        getLastSimulation: () => params.simulation ?? null,
        getHooksFilePath: () => params.hooksFilePath ?? '/tmp/hooks.json',
        toggleManagedHook: params.toggleManagedHook ?? (() => false),
        removeManagedEntry: params.removeManagedEntry ?? (() => false),
        simulate: params.simulateFn ?? ((eventPath: string) => ({
          eventPath,
          matchedHooks: [],
          matchedChains: [],
          capturedAt: Date.now(),
        })),
      }),
    },
  );
}

describe('HooksPanel', () => {
  test('renders empty guidance when no hooks are registered', () => {
    const panel = createPanel({
      contracts: [{
        pattern: 'Pre:tool:*',
        description: 'Intercept a tool call before execution.',
        authority: 'intercept',
        executionMode: 'blocking',
        canDeny: true,
        canMutateInput: true,
        canInjectContext: true,
        timeoutMs: 30000,
        failurePolicy: 'fail_open',
      }],
    });
    const text = linesText(panel.render(100, 12));
    expect(text).toContain('No hooks are currently registered');
    expect(text).toContain('Contracts:');
  });

  test('renders registered hooks and contract details', () => {
    const hook: HookDefinition = {
      name: 'guard-edit',
      match: 'Pre:tool:*',
      type: 'command',
      matcher: 'edit',
      command: 'echo guard',
      enabled: true,
    };
    const chain: HookChain = {
      name: 'tool-review-loop',
      steps: [{ match: 'Post:tool:edit' }],
      action: {
        name: 'tool-review-loop-action',
        type: 'command',
        match: 'Post:tool:edit',
        command: 'echo chain',
      },
    };

    const panel = createPanel({
      hooks: [{ pattern: 'Pre:tool:*', hook }],
      chains: [chain],
      contracts: [{
        pattern: 'Pre:tool:*',
        description: 'Intercept a tool call before execution.',
        authority: 'intercept',
        executionMode: 'blocking',
        canDeny: true,
        canMutateInput: true,
        canInjectContext: true,
        timeoutMs: 30000,
        failurePolicy: 'fail_open',
      }],
    });
    const text = linesText(panel.render(120, 14));
    expect(text).toContain('Hooks Control Room');
    expect(text).toContain('guard-edit');
    expect(text).toContain('Pre:tool:*');
    expect(text).toContain('intercept / blocking');
    expect(text).toContain('hooks=1 chains=1');
  });

  test('renders recent hook activity', () => {
    const hook: HookDefinition = {
      name: 'guard-edit',
      match: 'Pre:tool:*',
      type: 'command',
      matcher: 'edit',
      command: 'echo guard',
      enabled: true,
    };
    const activity: HookActivityRecord = {
      timestamp: Date.now(),
      path: 'Pre:tool:edit',
      specific: 'edit',
      pattern: 'Pre:tool:*',
      hookName: 'guard-edit',
      hookType: 'command',
      ok: true,
      decision: 'deny',
      durationMs: 8,
      async: false,
    };

    const panel = createPanel({
      hooks: [{ pattern: 'Pre:tool:*', hook }],
      activity: [activity],
    });
    const text = linesText(panel.render(120, 16));
    expect(text).toContain('Recent Activity');
    expect(text).toContain('guard-edit');
    expect(text).toContain('deny');
    // Summary header surfaces activity signal (recent denials) up front.
    expect(text).toContain('recent denials');
  });

  test('renders managed authoring state and last simulation', () => {
    const panel = createPanel({
      managedHooks: [{
        pattern: 'Pre:tool:*',
        hook: {
          name: 'managed-edit',
          match: 'Pre:tool:*',
          type: 'command',
          command: 'echo implement-hook',
          enabled: false,
          description: 'Managed hook scaffold for Pre:tool:*',
        },
      }],
      authoring: [{
        kind: 'scaffold-hook',
        target: 'managed-edit',
        timestamp: Date.now(),
        detail: 'command Pre:tool:*',
      }],
      simulation: {
        eventPath: 'Pre:tool:edit',
        matchedHooks: [{
          pattern: 'Pre:tool:*',
          name: 'managed-edit',
          type: 'command',
          contract: 'Intercept a tool call before execution.',
        }],
        matchedChains: [],
        capturedAt: Date.now(),
      },
    });
    const text = linesText(panel.render(120, 18));
    expect(text).toContain('Authoring');
    expect(text).toContain('managed-edit');
    expect(text).toContain('Last Simulation');
    expect(text).toContain('Pre:tool:edit');
  });

  // WO-134: t=toggle, x=remove (ConfirmState), s=simulate, plus expandable
  // activity and dropped signposts.
  describe('WO-134 control-room actions', () => {
    const hook: HookDefinition = {
      name: 'guard-edit',
      match: 'Pre:tool:*',
      type: 'command',
      matcher: 'edit',
      command: 'echo guard',
      enabled: true,
    };

    test('t toggles the selected managed hook via workbench.toggleManagedHook', () => {
      const calls: Array<[string, boolean]> = [];
      const panel = createPanel({
        hooks: [{ pattern: 'Pre:tool:*', hook }],
        toggleManagedHook: (name, enabled) => {
          calls.push([name, enabled]);
          return true;
        },
      });
      panel.render(120, 16);
      const consumed = panel.handleInput('t');
      expect(consumed).toBe(true);
      expect(calls).toEqual([['guard-edit', false]]);
    });

    test('t surfaces an error when the hook has no managed entry', () => {
      const panel = createPanel({
        hooks: [{ pattern: 'Pre:tool:*', hook }],
        toggleManagedHook: () => false,
      });
      panel.render(120, 16);
      panel.handleInput('t');
      const text = linesText(panel.render(120, 16));
      expect(text).toContain("No managed hook named 'guard-edit'");
    });

    test('x requests confirmation, then removes on y', () => {
      const removed: string[] = [];
      const panel = createPanel({
        hooks: [{ pattern: 'Pre:tool:*', hook }],
        removeManagedEntry: (name) => { removed.push(name); return true; },
      });
      panel.render(120, 16);
      panel.handleInput('x');
      const confirmText = linesText(panel.render(120, 16));
      expect(confirmText).toContain('Remove');
      expect(confirmText).toContain('guard-edit');
      expect(removed).toEqual([]);

      panel.handleInput('y');
      expect(removed).toEqual(['guard-edit']);
    });

    test('x confirmation cancels on n without removing', () => {
      const removed: string[] = [];
      const panel = createPanel({
        hooks: [{ pattern: 'Pre:tool:*', hook }],
        removeManagedEntry: (name) => { removed.push(name); return true; },
      });
      panel.render(120, 16);
      panel.handleInput('x');
      panel.handleInput('n');
      expect(removed).toEqual([]);
    });

    test('s simulates the selected hook\'s own pattern', () => {
      const simulated: string[] = [];
      const panel = createPanel({
        hooks: [{ pattern: 'Pre:tool:edit', hook }],
        simulateFn: (eventPath) => {
          simulated.push(eventPath);
          return { eventPath, matchedHooks: [], matchedChains: [], capturedAt: Date.now() };
        },
      });
      panel.render(120, 16);
      panel.handleInput('s');
      expect(simulated).toEqual(['Pre:tool:edit']);
    });

    test('a expands the recent-activity window beyond the default 3-row glance', () => {
      const activity: HookActivityRecord[] = Array.from({ length: 6 }, (_, i) => ({
        timestamp: Date.now() - i * 1000,
        path: `Pre:tool:edit-${i}`,
        specific: 'edit',
        pattern: 'Pre:tool:*',
        hookName: `hook-${i}`,
        hookType: 'command',
        ok: true,
        decision: 'allow',
        durationMs: 1,
        async: false,
      }));
      const panel = createPanel({ hooks: [{ pattern: 'Pre:tool:*', hook }], activity });
      const collapsedText = linesText(panel.render(120, 30));
      expect(collapsedText).not.toContain('hook-4');

      panel.handleInput('a');
      const expandedText = linesText(panel.render(120, 30));
      expect(expandedText).toContain('hook-4');
    });

    test('zero signposts — no "/hooks full listing" hint in the footer', () => {
      const panel = createPanel({ hooks: [{ pattern: 'Pre:tool:*', hook }] });
      const text = linesText(panel.render(120, 16));
      expect(text).not.toContain('full listing');
    });
  });
});
