import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { createSettingsSyncModalSurface } from '../../panels/modals/settings-sync-modal.ts';
import { createProviderHealthModalSurface, type ProviderRuntimeInspect } from '../../panels/modals/provider-health-modal.ts';
import type { ProviderRuntimeSnapshot } from '@pellux/goodvibes-sdk/platform/providers';
import type { ConfigModalActionContext, ConfigModalRow } from '../../input/config-modal-types.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function ctx(row: ConfigModalRow | null, extra: Partial<ConfigModalActionContext> = {}): ConfigModalActionContext {
  return { row, tabId: 't', print: () => {}, requestRender: () => {}, setStatus: () => {}, close: () => {}, ...extra };
}

function makeConfig(): ConfigManager {
  const root = makeProjectTempDir('gv-ss-modal');
  return new ConfigManager({ surfaceRoot: 'tui', configDir: join(root, '.goodvibes', 'tui'), workingDir: root });
}

describe('settings-sync modal surface', () => {
  test('buildView exposes the six browse tabs with a fixed-height posture header', () => {
    const surface = createSettingsSyncModalSurface(makeConfig());
    surface.onOpen?.(() => {});
    const view = surface.buildView();
    expect(view.tabs.map((t) => t.id)).toEqual(['keys', 'events', 'locks', 'failures', 'conflicts', 'rollback']);
    expect(view.tabs[0]!.header?.length).toBe(2); // constant header line count (liveness)
    surface.onClose?.();
  });

  test('managed review dispatches /managed review', () => {
    const calls: Array<[string, string[]]> = [];
    const surface = createSettingsSyncModalSurface(makeConfig());
    surface.onOpen?.(() => {});
    surface.onAction?.('managed-review', ctx(null, { executeCommand: async (n, a) => { calls.push([n, a]); return true; } }));
    expect(calls).toEqual([['managed', ['review']]]);
  });

  test('resolve actions are gated to an armed resolve prompt', () => {
    const surface = createSettingsSyncModalSurface(makeConfig());
    surface.onOpen?.(() => {});
    surface.buildView();
    const lAction = surface.actions?.find((a) => a.id === 'resolve-local');
    // No prompt armed yet -> l is not enabled.
    expect(lAction?.enabledFor?.(null, 'keys')).toBe(false);
  });
});

describe('provider-health modal surface', () => {
  const runtime: ProviderRuntimeInspect = {
    listProviderIds: () => ['anthropic', 'openai'],
    inspectAll: async () => ([
      { providerId: 'openai', active: true, modelCount: 5, runtime: {}, models: [] },
    ] as unknown as ProviderRuntimeSnapshot[]),
  };

  test('buildView lists providers with live active/model status across Health and Accounts tabs', async () => {
    const surface = createProviderHealthModalSurface(runtime);
    surface.onOpen?.(() => {});
    await flush();
    const view = surface.buildView();
    expect(view.tabs.map((t) => t.id)).toEqual(['health', 'accounts']);
    const text = view.tabs[0]!.rows.map((r) => r.label).join('\n');
    expect(text).toContain('openai');
    expect(text).toContain('ACTIVE');
    expect(text).toContain('models=5');
    expect(text).toContain('anthropic'); // present via listProviderIds even if not inspected
    surface.onClose?.();
  });

  test('repair dispatches /accounts repair for the selected provider', () => {
    const calls: Array<[string, string[]]> = [];
    const surface = createProviderHealthModalSurface(runtime);
    surface.onAction?.('repair', ctx({ id: 'provider:openai', label: '' }, { executeCommand: async (n, a) => { calls.push([n, a]); return true; } }));
    expect(calls).toEqual([['accounts', ['repair', 'openai']]]);
  });
});
