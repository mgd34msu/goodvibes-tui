import { describe, test, expect, beforeEach } from 'bun:test';
import { join } from 'node:path';
import {
  ApiTokenAuditor,
  DEFAULT_ROTATION_CADENCE_MS,
  DEFAULT_ROTATION_WARNING_THRESHOLD_MS,
} from '@pellux/goodvibes-sdk/platform/security';
import type { ApiTokenMetadata, TokenScopePolicy } from '@pellux/goodvibes-sdk/platform/security';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { createFeatureFlagManager, deriveFeatureStates, SecurityPanel } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const basePolicy: TokenScopePolicy = {
  id: 'openai',
  name: 'OpenAI API',
  allowedScopes: ['completions:write', 'models:read'],
  rotationCadenceMs: NINETY_DAYS_MS,
  rotationWarningThresholdMs: FOURTEEN_DAYS_MS,
};

function makeToken(
  overrides: Partial<ApiTokenMetadata> = {},
): ApiTokenMetadata {
  return {
    id: 'tok-001',
    label: 'OPENAI_API_KEY',
    issuedAt: Date.now() - THIRTY_DAYS_MS,
    grantedScopes: ['completions:write', 'models:read'],
    policyId: 'openai',
    ...overrides,
  };
}

function makeAuditor(managed = false): ApiTokenAuditor {
  const auditor = new ApiTokenAuditor({ managed });
  auditor.registerPolicy(basePolicy);
  return auditor;
}

// ---------------------------------------------------------------------------
// Policy registration
// ---------------------------------------------------------------------------

describe('registerPolicy', () => {
  test('registers a policy successfully', () => {
    const auditor = new ApiTokenAuditor({ managed: false });
    auditor.registerPolicy(basePolicy);
    expect(auditor.policyCount).toBe(1);
  });

  test('getPolicy returns registered policy', () => {
    const auditor = new ApiTokenAuditor({ managed: false });
    auditor.registerPolicy(basePolicy);
    const policy = auditor.getPolicy('openai');
    expect(policy).toBeDefined();
    expect(policy!.id).toBe('openai');
  });

  test('getPolicy returns undefined for unknown policy', () => {
    const auditor = new ApiTokenAuditor({ managed: false });
    expect(auditor.getPolicy('unknown')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Token registration
// ---------------------------------------------------------------------------

describe('registerToken', () => {
  test('registers a token successfully', () => {
    const auditor = makeAuditor();
    auditor.registerToken(makeToken());
    expect(auditor.tokenCount).toBe(1);
  });

  test('getTokenMetadata returns registered token metadata', () => {
    const auditor = makeAuditor();
    const token = makeToken();
    auditor.registerToken(token);
    const meta = auditor.getTokenMetadata('tok-001');
    expect(meta).toBeDefined();
    expect(meta!.label).toBe('OPENAI_API_KEY');
  });

  test('throws when registering token with unregistered policyId', () => {
    const auditor = new ApiTokenAuditor({ managed: false });
    expect(() =>
      auditor.registerToken(makeToken({ policyId: 'nonexistent' }))
    ).toThrow(/policyId 'nonexistent' not registered/);
  });

  test('deregisterToken removes the token', () => {
    const auditor = makeAuditor();
    auditor.registerToken(makeToken());
    expect(auditor.deregisterToken('tok-001')).toBe(true);
    expect(auditor.tokenCount).toBe(0);
  });

  test('deregisterToken returns false for unknown token', () => {
    const auditor = makeAuditor();
    expect(auditor.deregisterToken('nope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scope minimization tests
// ---------------------------------------------------------------------------

describe('auditScope — minimum scope principle', () => {
  test('returns ok when token scopes exactly match policy allowedScopes', () => {
    const auditor = makeAuditor();
    auditor.registerToken(makeToken({ grantedScopes: ['completions:write', 'models:read'] }));
    const result = auditor.auditScope('tok-001');
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe('ok');
    expect(result!.excessScopes).toHaveLength(0);
  });

  test('returns ok when token holds a strict subset of allowed scopes', () => {
    const auditor = makeAuditor();
    auditor.registerToken(makeToken({ grantedScopes: ['models:read'] }));
    const result = auditor.auditScope('tok-001');
    expect(result!.outcome).toBe('ok');
    expect(result!.excessScopes).toHaveLength(0);
  });

  test('returns violation when token holds a scope outside policy', () => {
    const auditor = makeAuditor();
    auditor.registerToken(makeToken({ grantedScopes: ['completions:write', 'admin:full'] }));
    const result = auditor.auditScope('tok-001');
    expect(result!.outcome).toBe('violation');
    expect(result!.excessScopes).toContain('admin:full');
  });

  test('reports all excess scopes, not just the first', () => {
    const auditor = makeAuditor();
    auditor.registerToken(
      makeToken({ grantedScopes: ['completions:write', 'admin:full', 'billing:read'] }),
    );
    const result = auditor.auditScope('tok-001');
    expect(result!.outcome).toBe('violation');
    expect(result!.excessScopes).toContain('admin:full');
    expect(result!.excessScopes).toContain('billing:read');
    expect(result!.excessScopes).toHaveLength(2);
  });

  test('returns null for unregistered token', () => {
    const auditor = makeAuditor();
    expect(auditor.auditScope('ghost')).toBeNull();
  });

  test('scope check is order-independent', () => {
    const auditor = makeAuditor();
    auditor.registerToken(makeToken({ grantedScopes: ['models:read', 'completions:write'] }));
    const result = auditor.auditScope('tok-001');
    expect(result!.outcome).toBe('ok');
  });

  test('empty grantedScopes is always ok (zero scopes is maximally minimal)', () => {
    const auditor = makeAuditor();
    auditor.registerToken(makeToken({ grantedScopes: [] }));
    const result = auditor.auditScope('tok-001');
    expect(result!.outcome).toBe('ok');
    expect(result!.excessScopes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rotation expiry warning tests
// ---------------------------------------------------------------------------

describe('auditRotation — rotation cadence', () => {
  test('returns ok for a recently issued token', () => {
    const auditor = makeAuditor();
    const now = Date.now();
    auditor.registerToken(makeToken({ issuedAt: now - ONE_DAY_MS }));
    const result = auditor.auditRotation('tok-001', now);
    expect(result!.outcome).toBe('ok');
    expect(result!.msUntilDue).toBeGreaterThan(0);
  });

  test('returns warning when within warning threshold', () => {
    const auditor = makeAuditor();
    const now = Date.now();
    // Issued 80 days ago: 10 days until 90-day cadence, within 14-day warning window
    const issuedAt = now - 80 * ONE_DAY_MS;
    auditor.registerToken(makeToken({ issuedAt }));
    const result = auditor.auditRotation('tok-001', now);
    expect(result!.outcome).toBe('warning');
    expect(result!.msUntilDue).toBeGreaterThan(0);
    expect(result!.msUntilDue).toBeLessThanOrEqual(FOURTEEN_DAYS_MS);
  });

  test('returns overdue for a token past the rotation deadline', () => {
    const auditor = makeAuditor();
    const now = Date.now();
    // Issued 100 days ago: 10 days overdue
    const issuedAt = now - 100 * ONE_DAY_MS;
    auditor.registerToken(makeToken({ issuedAt }));
    const result = auditor.auditRotation('tok-001', now);
    expect(result!.outcome).toBe('overdue');
    expect(result!.msUntilDue).toBeLessThan(0);
  });

  test('dueAt is issuedAt + cadenceMs', () => {
    const auditor = makeAuditor();
    const now = Date.now();
    const issuedAt = now - THIRTY_DAYS_MS;
    auditor.registerToken(makeToken({ issuedAt }));
    const result = auditor.auditRotation('tok-001', now);
    expect(result!.dueAt).toBe(issuedAt + NINETY_DAYS_MS);
  });

  test('ageMs is now - issuedAt', () => {
    const auditor = makeAuditor();
    const now = Date.now();
    const issuedAt = now - THIRTY_DAYS_MS;
    auditor.registerToken(makeToken({ issuedAt }));
    const result = auditor.auditRotation('tok-001', now);
    expect(result!.ageMs).toBe(THIRTY_DAYS_MS);
  });

  test('uses default cadence when policy omits rotationCadenceMs', () => {
    const auditor = new ApiTokenAuditor({ managed: false });
    auditor.registerPolicy({
      id: 'no-cadence',
      name: 'No Cadence Policy',
      allowedScopes: ['read'],
    });
    const now = Date.now();
    auditor.registerToken(makeToken({ policyId: 'no-cadence', issuedAt: now - ONE_DAY_MS }));
    const result = auditor.auditRotation('tok-001', now);
    expect(result!.cadenceMs).toBe(DEFAULT_ROTATION_CADENCE_MS);
    expect(result!.outcome).toBe('ok');
  });

  test('returns null for unregistered token', () => {
    const auditor = makeAuditor();
    expect(auditor.auditRotation('ghost')).toBeNull();
  });

  test('token exactly at the warning boundary is in warning state', () => {
    const auditor = makeAuditor();
    const now = Date.now();
    // Issued such that exactly FOURTEEN_DAYS_MS remains
    const issuedAt = now - (NINETY_DAYS_MS - FOURTEEN_DAYS_MS);
    auditor.registerToken(makeToken({ issuedAt }));
    const result = auditor.auditRotation('tok-001', now);
    // msUntilDue == FOURTEEN_DAYS_MS → within threshold → warning
    expect(result!.outcome).toBe('warning');
  });
});

// ---------------------------------------------------------------------------
// Full audit report
// ---------------------------------------------------------------------------

describe('auditAll', () => {
  test('returns empty report when no tokens are registered', () => {
    const auditor = makeAuditor();
    const report = auditor.auditAll();
    expect(report.results).toHaveLength(0);
    expect(report.blocked).toHaveLength(0);
    expect(report.scopeViolations).toHaveLength(0);
    expect(report.rotationWarnings).toHaveLength(0);
    expect(report.rotationOverdue).toHaveLength(0);
  });

  test('includes capturedAt in report', () => {
    const auditor = makeAuditor();
    const now = Date.now();
    const report = auditor.auditAll(now);
    expect(report.capturedAt).toBe(now);
  });

  test('healthy token appears in results with no violations', () => {
    const auditor = makeAuditor();
    const now = Date.now();
    auditor.registerToken(makeToken({ issuedAt: now - THIRTY_DAYS_MS }));
    const report = auditor.auditAll(now);
    expect(report.results).toHaveLength(1);
    expect(report.results[0].scope.outcome).toBe('ok');
    expect(report.results[0].rotation.outcome).toBe('ok');
    expect(report.results[0].blocked).toBe(false);
    expect(report.scopeViolations).toHaveLength(0);
    expect(report.rotationOverdue).toHaveLength(0);
  });

  test('scope violation reported in scopeViolations list', () => {
    const auditor = makeAuditor();
    const now = Date.now();
    auditor.registerToken(makeToken({ grantedScopes: ['completions:write', 'admin:full'] }));
    const report = auditor.auditAll(now);
    expect(report.scopeViolations).toContain('tok-001');
  });

  test('rotation warning reported in rotationWarnings list', () => {
    const auditor = makeAuditor();
    const now = Date.now();
    auditor.registerToken(makeToken({ issuedAt: now - 80 * ONE_DAY_MS }));
    const report = auditor.auditAll(now);
    expect(report.rotationWarnings).toContain('tok-001');
  });

  test('overdue rotation reported in rotationOverdue list', () => {
    const auditor = makeAuditor();
    const now = Date.now();
    auditor.registerToken(makeToken({ issuedAt: now - 100 * ONE_DAY_MS }));
    const report = auditor.auditAll(now);
    expect(report.rotationOverdue).toContain('tok-001');
  });

  test('multiple tokens each audited independently', () => {
    const auditor = makeAuditor();
    const now = Date.now();
    auditor.registerToken(makeToken({ id: 'tok-a', issuedAt: now - THIRTY_DAYS_MS }));
    auditor.registerToken(
      makeToken({
        id: 'tok-b',
        issuedAt: now - 100 * ONE_DAY_MS,
        grantedScopes: ['completions:write', 'admin:full'],
      }),
    );
    const report = auditor.auditAll(now);
    expect(report.results).toHaveLength(2);
    expect(report.scopeViolations).toContain('tok-b');
    expect(report.rotationOverdue).toContain('tok-b');
    expect(report.scopeViolations).not.toContain('tok-a');
    expect(report.rotationOverdue).not.toContain('tok-a');
  });
});

// ---------------------------------------------------------------------------
// Managed mode — out-of-policy tokens blocked
// ---------------------------------------------------------------------------

describe('managed mode blocking', () => {
  test('healthy token is NOT blocked in managed mode', () => {
    const auditor = makeAuditor(true);
    const now = Date.now();
    auditor.registerToken(makeToken({ issuedAt: now - THIRTY_DAYS_MS }));
    const report = auditor.auditAll(now);
    expect(report.blocked).not.toContain('tok-001');
    expect(report.results[0].blocked).toBe(false);
  });

  test('scope violation blocks token in managed mode', () => {
    const auditor = makeAuditor(true);
    const now = Date.now();
    auditor.registerToken(makeToken({ grantedScopes: ['completions:write', 'admin:full'] }));
    const report = auditor.auditAll(now);
    expect(report.blocked).toContain('tok-001');
    expect(report.results[0].blocked).toBe(true);
  });

  test('overdue rotation blocks token in managed mode', () => {
    const auditor = makeAuditor(true);
    const now = Date.now();
    auditor.registerToken(makeToken({ issuedAt: now - 100 * ONE_DAY_MS }));
    const report = auditor.auditAll(now);
    expect(report.blocked).toContain('tok-001');
    expect(report.results[0].blocked).toBe(true);
  });

  test('rotation warning alone does NOT block token in managed mode', () => {
    const auditor = makeAuditor(true);
    const now = Date.now();
    // 80 days old: warning but not overdue
    auditor.registerToken(makeToken({ issuedAt: now - 80 * ONE_DAY_MS }));
    const report = auditor.auditAll(now);
    expect(report.blocked).not.toContain('tok-001');
    expect(report.results[0].blocked).toBe(false);
  });

  test('scope violation does NOT block token in advisory (non-managed) mode', () => {
    const auditor = makeAuditor(false);
    const now = Date.now();
    auditor.registerToken(makeToken({ grantedScopes: ['completions:write', 'admin:full'] }));
    const report = auditor.auditAll(now);
    expect(report.blocked).not.toContain('tok-001');
    expect(report.results[0].blocked).toBe(false);
  });

  test('overdue rotation does NOT block token in advisory (non-managed) mode', () => {
    const auditor = makeAuditor(false);
    const now = Date.now();
    auditor.registerToken(makeToken({ issuedAt: now - 100 * ONE_DAY_MS }));
    const report = auditor.auditAll(now);
    expect(report.blocked).not.toContain('tok-001');
    expect(report.results[0].blocked).toBe(false);
  });

  test('isBlocked returns true for scope violation in managed mode', () => {
    const auditor = makeAuditor(true);
    const now = Date.now();
    auditor.registerToken(makeToken({ grantedScopes: ['completions:write', 'admin:full'] }));
    expect(auditor.isBlocked('tok-001', now)).toBe(true);
  });

  test('isBlocked returns true for overdue rotation in managed mode', () => {
    const auditor = makeAuditor(true);
    const now = Date.now();
    auditor.registerToken(makeToken({ issuedAt: now - 100 * ONE_DAY_MS }));
    expect(auditor.isBlocked('tok-001', now)).toBe(true);
  });

  test('isBlocked returns false in advisory mode regardless of violations', () => {
    const auditor = makeAuditor(false);
    const now = Date.now();
    auditor.registerToken(
      makeToken({ grantedScopes: ['completions:write', 'admin:full'], issuedAt: now - 100 * ONE_DAY_MS }),
    );
    expect(auditor.isBlocked('tok-001', now)).toBe(false);
  });

  test('isBlocked returns false for unregistered token', () => {
    const auditor = makeAuditor(true);
    expect(auditor.isBlocked('ghost')).toBe(false);
  });

  test('isManaged reflects constructor config', () => {
    expect(new ApiTokenAuditor({ managed: true }).isManaged).toBe(true);
    expect(new ApiTokenAuditor({ managed: false }).isManaged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// security.tokenAudit.enabled, driven to BOTH values through the real gate.
//
// This setting used to configure nothing in the TUI: services.ts built its
// ApiTokenAuditor without a featureFlags manager, and isFeatureGateEnabled is
// permissive when no manager is wired — a narrow embed with no flag manager
// gets the capability rather than a silent off — so a composition root that
// omitted featureFlags did not disable managed blocking when the key was
// turned off. It made the switch inert. services.ts now threads featureFlags
// into ApiTokenAuditor, the same shape as the RouteBindingManager fix.
//
// The mutation check for this row: remove that argument (or pass `undefined`)
// and the "off" half of the first test below fails, because the auditor falls
// back to permissive and blocks the token anyway.
// ---------------------------------------------------------------------------

describe('security.tokenAudit.enabled feature gate', () => {
  function auditorWithGate(root: string, enabled: boolean): ApiTokenAuditor {
    const configManager = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'tui') });
    configManager.set('security.tokenAudit.enabled', enabled);
    const featureFlags = createFeatureFlagManager();
    featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
    // Constructed exactly as runtime/services.ts constructs it: managed mode
    // is hardcoded true here (unlike services.ts's false) specifically so the
    // gate this test targets is reachable at all.
    const auditor = new ApiTokenAuditor({ managed: true, featureFlags });
    auditor.registerPolicy(basePolicy);
    return auditor;
  }

  test('security.tokenAudit.enabled false stops managed blocking even for an out-of-policy token', () => {
    const root = makeProjectTempDir('gv-token-audit-gate');
    const auditor = auditorWithGate(root, false);
    const now = Date.now();
    auditor.registerToken(makeToken({ grantedScopes: ['completions:write', 'admin:full'] }));
    const report = auditor.auditAll(now);
    // Still reported (advisory reporting is unaffected by this gate)...
    expect(report.scopeViolations).toContain('tok-001');
    // ...but NOT blocked, because the gate is off.
    expect(report.blocked).not.toContain('tok-001');
    expect(auditor.isBlocked('tok-001', now)).toBe(false);
  });

  test('security.tokenAudit.enabled true blocks an out-of-policy token in managed mode, and is the shipped default', () => {
    const root = makeProjectTempDir('gv-token-audit-gate');
    const auditor = auditorWithGate(root, true);
    const now = Date.now();
    auditor.registerToken(makeToken({ grantedScopes: ['completions:write', 'admin:full'] }));
    const report = auditor.auditAll(now);
    expect(report.blocked).toContain('tok-001');
    expect(auditor.isBlocked('tok-001', now)).toBe(true);

    // The default half: with the key never written, effective behaviour
    // matches true. This is what makes threading featureFlags a fix that
    // changes only whether the switch WORKS, not what an existing install does.
    const unsetRoot = makeProjectTempDir('gv-token-audit-gate-unset');
    const unsetConfig = new ConfigManager({ surfaceRoot: 'tui', workingDir: unsetRoot, homeDir: unsetRoot, configDir: join(unsetRoot, '.goodvibes', 'unset') });
    expect(unsetConfig.get('security.tokenAudit.enabled')).toBe(true);
    const flags = createFeatureFlagManager();
    flags.loadFromConfig({ flags: deriveFeatureStates(unsetConfig) });
    const unsetAuditor = new ApiTokenAuditor({ managed: true, featureFlags: flags });
    unsetAuditor.registerPolicy(basePolicy);
    unsetAuditor.registerToken(makeToken({ grantedScopes: ['completions:write', 'admin:full'] }));
    expect(unsetAuditor.isBlocked('tok-001', now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SecurityPanel
// ---------------------------------------------------------------------------

describe('SecurityPanel', () => {
  test('runAudit triggers subscribers', () => {
    const auditor = makeAuditor();
    auditor.registerToken(makeToken());
    const panel = new SecurityPanel(auditor);
    let callCount = 0;
    panel.subscribe(() => { callCount++; });
    panel.runAudit();
    expect(callCount).toBe(1);
    panel.runAudit();
    expect(callCount).toBe(2);
    panel.dispose();
  });

  test('getSnapshot returns correct shape before any audit', () => {
    const auditor = makeAuditor();
    const panel = new SecurityPanel(auditor);
    const snap = panel.getSnapshot();
    expect(snap.managed).toBe(false);
    expect(snap.totalTokens).toBe(0);
    expect(snap.results).toHaveLength(0);
    expect(snap.blocked).toHaveLength(0);
    expect(snap.scopeViolations).toHaveLength(0);
    expect(snap.rotationWarnings).toHaveLength(0);
    expect(snap.rotationOverdue).toHaveLength(0);
    expect(snap.lastAuditAt).toBeNull();
    expect(typeof snap.capturedAt).toBe('string');
    panel.dispose();
  });

  test('getSnapshot reflects audit results after runAudit', () => {
    const auditor = makeAuditor();
    const now = Date.now();
    auditor.registerToken(makeToken({ issuedAt: now - THIRTY_DAYS_MS }));
    const panel = new SecurityPanel(auditor);
    panel.runAudit(now);
    const snap = panel.getSnapshot();
    expect(snap.results).toHaveLength(1);
    expect(snap.lastAuditAt).toBe(now);
    expect(snap.scopeViolations).toHaveLength(0);
    expect(snap.rotationOverdue).toHaveLength(0);
    panel.dispose();
  });

  test('dispose clears all subscribers', () => {
    const auditor = makeAuditor();
    const panel = new SecurityPanel(auditor);
    let callCount = 0;
    panel.subscribe(() => { callCount++; });
    panel.subscribe(() => { callCount++; });
    panel.dispose();
    panel.runAudit();
    expect(callCount).toBe(0);
  });

  test('bufferLimit caps results in getSnapshot', () => {
    const auditor = makeAuditor();
    const now = Date.now();
    // Register more tokens than the buffer limit (use a small limit via config)
    for (let i = 0; i < 5; i++) {
      auditor.registerPolicy({ id: `pol-${i}`, name: `Policy ${i}`, allowedScopes: ['read'] });
      auditor.registerToken({
        id: `tok-extra-${i}`,
        label: `TOKEN_${i}`,
        issuedAt: now - THIRTY_DAYS_MS,
        grantedScopes: ['read'],
        policyId: `pol-${i}`,
      });
    }
    const panel = new SecurityPanel(auditor, { bufferLimit: 3 });
    panel.runAudit(now);
    const snap = panel.getSnapshot();
    expect(snap.results.length).toBeLessThanOrEqual(3);
    panel.dispose();
  });

  test('subscribe returns an unsubscribe function', () => {
    const auditor = makeAuditor();
    const panel = new SecurityPanel(auditor);
    let callCount = 0;
    const unsub = panel.subscribe(() => { callCount++; });
    panel.runAudit();
    expect(callCount).toBe(1);
    unsub();
    panel.runAudit();
    expect(callCount).toBe(1);
    panel.dispose();
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  test('DEFAULT_ROTATION_CADENCE_MS is 90 days', () => {
    expect(DEFAULT_ROTATION_CADENCE_MS).toBe(NINETY_DAYS_MS);
  });

  test('DEFAULT_ROTATION_WARNING_THRESHOLD_MS is 14 days', () => {
    expect(DEFAULT_ROTATION_WARNING_THRESHOLD_MS).toBe(FOURTEEN_DAYS_MS);
  });
});
