import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ModeManager,
  HITL_QUIET,
  HITL_BALANCED,
  HITL_OPERATOR,
} from '@pellux/goodvibes-sdk/platform/state';
import type { HITLMode } from '@pellux/goodvibes-sdk/platform/state';
import { getTestModeManager, resetTestRuntimeServices } from '../helpers/runtime-services.ts';

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
