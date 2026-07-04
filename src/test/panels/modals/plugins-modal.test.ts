import { describe, test, expect } from 'bun:test';
import { createPluginsModalSurface, type PluginsModalManager } from '../../../panels/modals/plugins-modal.ts';
import type { PluginStatus } from '@pellux/goodvibes-sdk/platform/plugins';
import { actionCtx, captureCommands, findAction, open, tabText } from './modal-surface-test-helpers.ts';

function manager(plugins: PluginStatus[], overrides: Partial<PluginsModalManager> = {}): PluginsModalManager {
  return {
    list: () => plugins,
    capabilities: () => null,
    getTrustRecord: () => undefined,
    getQuarantineRecord: (n) => (plugins.find((p) => p.name === n)?.quarantined ? { pluginName: n, quarantinedAt: 0, reason: 'bad sig', revokedCapabilities: [], lifted: false } : undefined),
    verify: () => ({ ok: true, valid: true, fingerprint: 'fp-1' }),
    ...overrides,
  };
}
const trusted: PluginStatus = { name: 'formatter', version: '1.0.0', description: 'fmt', enabled: true, active: true, trustTier: 'trusted', quarantined: false };
const quarantined: PluginStatus = { name: 'risky', version: '0.2.0', description: 'risky', enabled: false, active: false, trustTier: 'untrusted', quarantined: true };

describe('plugins modal surface', () => {
  test('surface identity', () => { expect(createPluginsModalSurface({ pluginManager: manager([]) }).name).toBe('plugins-modal'); });

  test('empty roster shows honest next-steps copy', () => {
    const text = tabText(open(createPluginsModalSurface({ pluginManager: manager([]) })), 'plugins');
    expect(text).toContain('No plugins discovered.');
    expect(text).toContain('/plugin list');
    expect(text).toContain('/marketplace');
  });

  test('populated roster: posture header + folded quarantine detail', () => {
    const text = tabText(open(createPluginsModalSurface({ pluginManager: manager([trusted, quarantined]) })), 'plugins');
    expect(text).toContain('plugins 2  active 1  untrusted 1  quarantined 1');
    expect(text).toContain('formatter');
    expect(text).toContain('quarantine: bad sig'); // folded selection-detail
  });

  test('enable routes to /plugin, gated by enabledFor; lift-quarantine only for quarantined rows', () => {
    const surface = createPluginsModalSurface({ pluginManager: manager([trusted, quarantined]) });
    open(surface);
    expect(findAction(surface, 'enable')?.enabledFor?.({ id: 'formatter', label: '' }, 'plugins')).toBe(false); // already active
    expect(findAction(surface, 'enable')?.enabledFor?.({ id: 'risky', label: '' }, 'plugins')).toBe(true);
    const cap = captureCommands();
    surface.onAction?.('enable', actionCtx({ id: 'risky', label: '' }, cap.extra));
    expect(cap.calls).toEqual([['plugin', ['enable', 'risky']]]);
    expect(findAction(surface, 'liftQuarantine')?.enabledFor?.({ id: 'formatter', label: '' }, 'plugins')).toBe(false);
    expect(findAction(surface, 'captureToMemory')?.enabledFor?.({ id: 'risky', label: '' }, 'plugins')).toBe(true);
    const cap2 = captureCommands();
    surface.onAction?.('liftQuarantine', actionCtx({ id: 'risky', label: '' }, cap2.extra));
    expect(cap2.calls).toEqual([['plugin', ['quarantine', 'risky', 'lift']]]);
  });

  test('verify is an in-modal read (no command dispatch) and its result folds into the row', () => {
    const surface = createPluginsModalSurface({ pluginManager: manager([trusted], { verify: (n) => ({ ok: true, valid: false, reason: `${n} signature mismatch` }) }) });
    open(surface);
    const cap = captureCommands();
    surface.onAction?.('verify', actionCtx({ id: 'formatter', label: '' }, cap.extra));
    expect(cap.calls).toEqual([]);
    const text = tabText(surface.buildView(), 'plugins');
    expect(text).toContain('verify INVALID');
    expect(text).toContain('formatter signature mismatch');
  });
});
