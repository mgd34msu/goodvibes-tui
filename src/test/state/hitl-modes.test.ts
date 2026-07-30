import { describe, it, expect, beforeEach } from 'bun:test';
import { join } from 'node:path';
import {
  ModeManager,
  HITL_QUIET,
  HITL_BALANCED,
  HITL_OPERATOR,
} from '@pellux/goodvibes-sdk/platform/state';
import type { HITLMode } from '@pellux/goodvibes-sdk/platform/state';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { createFeatureFlagManager, deriveFeatureStates } from '@/runtime/index.ts';
import { getTestModeManager, resetTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

beforeEach(() => {
  resetTestRuntimeServices();
});

describe('ModeManager — HITL UX modes', () => {
  // ── setHITLMode / getHITLMode ──────────────────────────────────────────────

  it('defaults to balanced mode', () => {
    const mgr = getTestModeManager();
    expect(mgr.getHITLMode()).toBe('balanced');
  });

  it('setHITLMode updates the active mode', () => {
    const mgr = getTestModeManager();
    mgr.setHITLMode('quiet');
    expect(mgr.getHITLMode()).toBe('quiet');

    mgr.setHITLMode('operator');
    expect(mgr.getHITLMode()).toBe('operator');

    mgr.setHITLMode('balanced');
    expect(mgr.getHITLMode()).toBe('balanced');
  });

  // ── getHITLPreset ──────────────────────────────────────────────────────────

  it('getHITLPreset returns the correct preset for each mode', () => {
    const mgr = getTestModeManager();

    mgr.setHITLMode('quiet');
    expect(mgr.getHITLPreset()).toEqual(HITL_QUIET);

    mgr.setHITLMode('balanced');
    expect(mgr.getHITLPreset()).toEqual(HITL_BALANCED);

    mgr.setHITLMode('operator');
    expect(mgr.getHITLPreset()).toEqual(HITL_OPERATOR);
  });

  it('setHITLMode throws for unknown mode', () => {
    const mgr = getTestModeManager();
    expect(() => mgr.setHITLMode('unknown-mode' as HITLMode)).toThrow(
      /Unknown HITL mode: "unknown-mode"/,
    );
  });

  it('getHITLPreset falls back to HITL_BALANCED for unknown mode', () => {
    const mgr = getTestModeManager();
    // Force an invalid state via direct property mutation to test the fallback path
    (mgr as unknown as { hitlMode: string }).hitlMode = 'unknown-mode';
    expect(mgr.getHITLPreset()).toEqual(HITL_BALANCED);
  });

  // ── Preset constants ───────────────────────────────────────────────────────

  it('HITL_QUIET has expected fields', () => {
    expect(HITL_QUIET.name).toBe('quiet');
    expect(HITL_QUIET.defaultDomainVerbosity).toBe('minimal');
    expect(HITL_QUIET.quietWhileTyping).toBe(true);
    expect(HITL_QUIET.batchWindowMs).toBe(5_000);
  });

  it('HITL_BALANCED has expected fields', () => {
    expect(HITL_BALANCED.name).toBe('balanced');
    expect(HITL_BALANCED.defaultDomainVerbosity).toBe('normal');
    expect(HITL_BALANCED.quietWhileTyping).toBe(true);
    expect(HITL_BALANCED.batchWindowMs).toBe(2_000);
  });

  it('HITL_OPERATOR has expected fields', () => {
    expect(HITL_OPERATOR.name).toBe('operator');
    expect(HITL_OPERATOR.defaultDomainVerbosity).toBe('verbose');
    expect(HITL_OPERATOR.quietWhileTyping).toBe(false);
    expect(HITL_OPERATOR.batchWindowMs).toBe(500);
  });

  // ── Domain overrides ───────────────────────────────────────────────────────

  it('setDomainVerbosity stores a per-domain override', () => {
    const mgr = getTestModeManager();
    mgr.setDomainVerbosity('tools', 'verbose');
    expect(mgr.getDomainVerbosity('tools')).toBe('verbose');
  });

  it('getDomainVerbosity falls back to preset default when no override exists', () => {
    const mgr = getTestModeManager();
    mgr.setHITLMode('quiet');
    // No override for 'tasks' — should return HITL_QUIET.defaultDomainVerbosity
    expect(mgr.getDomainVerbosity('tasks')).toBe('minimal');
  });

  it('setHITLMode clears domain overrides', () => {
    const mgr = getTestModeManager();
    mgr.setDomainVerbosity('tools', 'verbose');
    mgr.setDomainVerbosity('agents', 'normal');

    mgr.setHITLMode('operator');

    expect(mgr.getDomainOverrides()).toEqual({});
    // After clearing, getDomainVerbosity falls back to the new preset
    expect(mgr.getDomainVerbosity('tools')).toBe('verbose');
  });

  // ── applyToRouter ──────────────────────────────────────────────────────────

  it('applyToRouter calls setQuietWhileTyping with preset value', () => {
    const mgr = getTestModeManager();
    mgr.setHITLMode('operator');

    let quietSet: boolean | undefined;
    const router = {
      setQuietWhileTyping: (v: boolean) => { quietSet = v; },
      setDomainVerbosity: (_d: string, _v: string) => {},
    };
    mgr.applyToRouter(router);
    expect(quietSet).toBe(false);
  });

  it('applyToRouter propagates domain overrides', () => {
    const mgr = getTestModeManager();
    mgr.setHITLMode('balanced');
    mgr.setDomainVerbosity('tools', 'verbose');

    const domainCalls: Array<[string, string]> = [];
    const router = {
      setQuietWhileTyping: (_v: boolean) => {},
      setDomainVerbosity: (d: string, v: string) => { domainCalls.push([d, v]); },
    };
    mgr.applyToRouter(router);
    expect(domainCalls).toEqual([['tools', 'verbose']]);
  });

  it('applyToRouter calls optional setBatchWindowMs and setDefaultDomainVerbosity', () => {
    const mgr = getTestModeManager();
    mgr.setHITLMode('quiet');

    let batchMs: number | undefined;
    let defaultVerbosity: string | undefined;
    const router = {
      setQuietWhileTyping: (_v: boolean) => {},
      setDomainVerbosity: (_d: string, _v: string) => {},
      setBatchWindowMs: (ms: number) => { batchMs = ms; },
      setDefaultDomainVerbosity: (v: string) => { defaultVerbosity = v; },
    };
    mgr.applyToRouter(router);
    expect(batchMs).toBe(5_000);
    expect(defaultVerbosity).toBe('minimal');
  });

  it('applyToRouter works when optional router methods are absent', () => {
    const mgr = getTestModeManager();
    mgr.setHITLMode('balanced');

    // Should not throw when optional methods are missing
    const router = {
      setQuietWhileTyping: (_v: boolean) => {},
      setDomainVerbosity: (_d: string, _v: string) => {},
    };
    expect(() => mgr.applyToRouter(router)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// behavior.hitlMode, driven to BOTH values through the real gate.
//
// This setting used to configure nothing: services.ts built its ModeManager
// with no arguments at all (no featureFlags), and isFeatureGateEnabled is
// permissive when no manager is wired, so a composition root that omitted
// featureFlags did not disable the HITL UX mode system when behavior.hitlMode
// was set to 'off' — setHITLMode kept accepting writes either way.
// services.ts now threads featureFlags, the same shape as the
// RouteBindingManager fix.
//
// The mutation check for this row: remove that argument and the "off" half
// of the first test below fails, because the manager falls back to
// permissive and accepts the mode change anyway.
// ---------------------------------------------------------------------------

describe('ModeManager — behavior.hitlMode feature gate', () => {
  function modeManagerWithGate(root: string, hitlMode: 'off' | 'balanced'): ModeManager {
    const configManager = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'tui') });
    configManager.set('behavior.hitlMode', hitlMode);
    const featureFlags = createFeatureFlagManager();
    featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
    // Constructed exactly as runtime/services.ts constructs it.
    return new ModeManager({ featureFlags });
  }

  it('behavior.hitlMode "off" turns HITL UX modes off, and the manager refuses a mode change', () => {
    const root = makeProjectTempDir('gv-hitl-gate');
    const mgr = modeManagerWithGate(root, 'off');
    // Askable: the mode reads as the baseline rather than throwing.
    expect(mgr.getHITLMode()).toBe('balanced');
    // A write REFUSES rather than silently doing nothing, and the refusal
    // names the setting so the reason is diagnosable from the message alone.
    let refusal = '';
    try {
      mgr.setHITLMode('quiet');
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain('behavior.hitlMode');
    expect(mgr.getHITLMode()).toBe('balanced');
  });

  it('behavior.hitlMode "balanced" allows mode changes, and is the shipped default', () => {
    const root = makeProjectTempDir('gv-hitl-gate');
    const mgr = modeManagerWithGate(root, 'balanced');
    mgr.setHITLMode('quiet');
    expect(mgr.getHITLMode()).toBe('quiet');

    // The default half: with the key never written, effective behaviour
    // matches 'balanced' (on). This is what makes threading featureFlags a
    // fix that changes only whether the switch WORKS, not what an existing
    // install does.
    const unsetRoot = makeProjectTempDir('gv-hitl-gate-unset');
    const unsetConfig = new ConfigManager({ surfaceRoot: 'tui', workingDir: unsetRoot, homeDir: unsetRoot, configDir: join(unsetRoot, '.goodvibes', 'unset') });
    expect(unsetConfig.get('behavior.hitlMode')).toBe('balanced');
    const flags = createFeatureFlagManager();
    flags.loadFromConfig({ flags: deriveFeatureStates(unsetConfig) });
    const unsetMgr = new ModeManager({ featureFlags: flags });
    unsetMgr.setHITLMode('operator');
    expect(unsetMgr.getHITLMode()).toBe('operator');
  });
});
