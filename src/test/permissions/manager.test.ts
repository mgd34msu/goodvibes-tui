import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PermissionManager } from '../../permissions/manager.ts';
import { configManager, getConfigSnapshot } from '../../config/index.ts';
import type { PermissionPromptRequest, PermissionPromptDecision } from '../../permissions/prompt.ts';
import { getPolicyRuntimeState, resetPolicyRuntimeStateForTests } from '../../runtime/permissions/policy-runtime.ts';
import { createUnsignedBundle } from '../../runtime/permissions/policy-loader.ts';
import type { PolicyBundlePayload } from '../../runtime/permissions/policy-loader.ts';
import type { PolicyRule } from '../../runtime/permissions/types.ts';
import { resetSettingsControlPlaneForTesting } from '../../runtime/settings/control-plane.ts';

// behavior.autoApprove reflects the --no-worries-just-vibes flag.
// In the test environment (no CLI flag), it is false.
// Tests are written for the autoApprove=false path.
// If the flag is somehow set, the suite notes it so the reader understands.

describe('PermissionManager', () => {
  let manager: PermissionManager;
  let savedMode: string;
  let savedAutoApprove: boolean;
  let requests: PermissionPromptRequest[];
  let decisions: PermissionPromptDecision[];

  beforeEach(() => {
    resetPolicyRuntimeStateForTests();
    resetSettingsControlPlaneForTesting();
    // Snapshot current config state
    savedMode = getConfigSnapshot().permissions.mode ?? 'prompt';
    savedAutoApprove = getConfigSnapshot().behavior.autoApprove ?? false;
    // Isolate: reset to default permission state so tests are deterministic
    configManager.set('permissions.mode', 'prompt');
    configManager.set('behavior.autoApprove', false);
    requests = [];
    decisions = [];
    manager = new PermissionManager(async (request) => {
      requests.push(request);
      return decisions.shift() ?? { approved: true };
    });
  });

  afterEach(() => {
    resetPolicyRuntimeStateForTests();
    resetSettingsControlPlaneForTesting();
    // Restore config state after each test
    configManager.set('permissions.mode', savedMode as 'prompt' | 'allow-all' | 'custom');
    configManager.set('behavior.autoApprove', savedAutoApprove);
  });

  describe('getCategory', () => {
    // New tool names
    test('read is read category', () => {
      expect(manager.getCategory('read')).toBe('read');
    });

    test('find is read category', () => {
      expect(manager.getCategory('find')).toBe('read');
    });

    test('fetch is read category', () => {
      expect(manager.getCategory('fetch')).toBe('read');
    });

    test('analyze is read category', () => {
      expect(manager.getCategory('analyze')).toBe('read');
    });

    test('inspect is read category', () => {
      expect(manager.getCategory('inspect')).toBe('read');
    });

    test('state is read category', () => {
      expect(manager.getCategory('state')).toBe('read');
    });

    test('registry is read category', () => {
      expect(manager.getCategory('registry')).toBe('read');
    });

    test('write is write category', () => {
      expect(manager.getCategory('write')).toBe('write');
    });

    test('edit is write category', () => {
      expect(manager.getCategory('edit')).toBe('write');
    });

    test('exec is execute category', () => {
      expect(manager.getCategory('exec')).toBe('execute');
    });

    test('agent is delegate category', () => {
      expect(manager.getCategory('agent')).toBe('delegate');
    });

    test('delegate is delegate category', () => {
      expect(manager.getCategory('delegate')).toBe('delegate');
    });

    test('workflow is delegate category', () => {
      expect(manager.getCategory('workflow')).toBe('delegate');
    });

    test('unknown tool defaults to delegate category', () => {
      expect(manager.getCategory('unknown_tool')).toBe('delegate');
    });

    test('custom_action defaults to delegate category', () => {
      expect(manager.getCategory('custom_action')).toBe('delegate');
    });
  });

  describe('check - read category auto-approval', () => {
    // New tool names
    test('auto-approves read tool', async () => {
      const result = await manager.check('read', { path: 'README.md' });
      expect(result).toBe(true);
    });

    test('auto-approves find tool', async () => {
      const result = await manager.check('find', { pattern: 'foo' });
      expect(result).toBe(true);
    });

    test('auto-approves fetch tool', async () => {
      const result = await manager.check('fetch', { url: 'https://example.com' });
      expect(result).toBe(true);
    });

    test('auto-approves analyze tool', async () => {
      const result = await manager.check('analyze', { path: '.' });
      expect(result).toBe(true);
    });

    test('auto-approves inspect tool', async () => {
      const result = await manager.check('inspect', { path: 'src/' });
      expect(result).toBe(true);
    });

    test('auto-approves state tool', async () => {
      const result = await manager.check('state', { key: 'session' });
      expect(result).toBe(true);
    });

    test('auto-approves registry tool', async () => {
      const result = await manager.check('registry', { query: 'tools' });
      expect(result).toBe(true);
    });

    test('auto-approves read category tools regardless of autoApprove flag', async () => {
      const result = await manager.check('read', { path: 'README.md' });
      expect(result).toBe(true);
    });
  });

  describe('check - permission prompt for non-read tools (autoApprove=false)', () => {
    test('emits permission:request event for write category when autoApprove=false', async () => {
      if (getConfigSnapshot().behavior.autoApprove) {
        // Skip assertion path — flag is set, no event fires
        const result = await manager.check('write', { path: 'file.txt' });
        expect(result).toBe(true);
        return;
      }

      expect.assertions(2);
      decisions.push({ approved: true });

      const result = await manager.check('write', { path: 'file.txt' });
      expect(requests).toHaveLength(1);
      expect(result).toBe(true);
    });

    test('resolving with false denies the operation', async () => {
      if (getConfigSnapshot().behavior.autoApprove) {
        const result = await manager.check('exec', { command: 'echo hi' });
        expect(result).toBe(true);
        return;
      }

      expect.assertions(1);

      decisions.push({ approved: false });

      const result = await manager.check('exec', { command: 'echo hi' });
      expect(result).toBe(false);
    });

    test('permission:request event includes tool name and category', async () => {
      if (getConfigSnapshot().behavior.autoApprove) {
        await manager.check('write', { path: 'test.ts' });
        return;
      }

      expect.assertions(2);
      decisions.push({ approved: true });

      await manager.check('write', { path: 'test.ts' });
      expect(requests[0]!.tool).toBe('write');
      expect(requests[0]!.category).toBe('write');
    });
  });

  describe('check - prompt-flow for non-read tools in default prompt mode', () => {
    test('write tool triggers permission prompt', async () => {
      expect.assertions(2);
      decisions.push({ approved: true });

      const result = await manager.check('write', { path: 'output.ts' });
      expect(requests).toHaveLength(1);
      expect(result).toBe(true);
    });

    test('exec tool triggers permission prompt', async () => {
      expect.assertions(2);
      decisions.push({ approved: true });

      const result = await manager.check('exec', { command: 'npm run build' });
      expect(requests).toHaveLength(1);
      expect(result).toBe(true);
    });

    test('agent tool triggers permission prompt', async () => {
      expect.assertions(2);
      decisions.push({ approved: true });

      const result = await manager.check('agent', { task: 'do something' });
      expect(requests).toHaveLength(1);
      expect(result).toBe(true);
    });

    test('workflow tool triggers permission prompt', async () => {
      expect.assertions(2);
      decisions.push({ approved: true });

      const result = await manager.check('workflow', { name: 'deploy' });
      expect(requests).toHaveLength(1);
      expect(result).toBe(true);
    });

    test('exec prompt carries critical secret-exposure analysis when command includes inline credentials', async () => {
      expect.assertions(3);
      decisions.push({ approved: false });

      await manager.check('exec', { command: 'curl -H \"Authorization: Bearer sk-secret-token-value\" https://example.com' });

      expect(requests).toHaveLength(1);
      expect(requests[0]!.analysis.riskLevel).toBe('critical');
      expect(requests[0]!.analysis.reasons.join(' ')).toContain('credential');
    });

    test('write prompt marks sensitive credential paths as high risk', async () => {
      expect.assertions(3);
      decisions.push({ approved: false });

      await manager.check('write', { path: '.env.production' });

      expect(requests).toHaveLength(1);
      expect(requests[0]!.analysis.riskLevel).toBe('high');
      expect(requests[0]!.analysis.reasons.join(' ')).toContain('secret or credential file');
    });

    test('managed policy deny blocks without prompting', async () => {
      expect.assertions(2);
      const rule: PolicyRule = {
        type: 'prefix',
        id: 'deny-rm',
        description: 'Block rm commands',
        origin: 'managed',
        effect: 'deny',
        toolPattern: 'exec',
        commandPrefixes: ['rm'],
      };
      const payload: PolicyBundlePayload = { version: 1, rules: [rule] };
      const registry = getPolicyRuntimeState().getRegistry();
      registry.loadCandidate(createUnsignedBundle('policy-deny-rm', payload));
      registry.markSimulating();
      registry.attachSimulationReport(
        {
          overall: { total: 0, byType: { 'allow-vs-deny': 0, 'deny-vs-allow': 0, 'reason-mismatch': 0 }, divergenceRate: 0, totalEvaluations: 0 },
          byToolClass: {},
          byCommandPrefix: {},
          byMode: {},
          records: [],
        },
        { status: 'allowed', threshold: 0.05, divergenceRate: 0, totalEvaluations: 0, message: 'ok' },
      );
      registry.promote(true);

      const result = await manager.check('exec', { command: 'rm build.log' });
      expect(result).toBe(false);
      expect(requests).toHaveLength(0);
    });

    test('managed policy allow auto-approves matching command without prompting', async () => {
      expect.assertions(2);
      const rule: PolicyRule = {
        type: 'prefix',
        id: 'allow-npm-test',
        description: 'Allow npm test',
        origin: 'managed',
        effect: 'allow',
        toolPattern: 'exec',
        commandPrefixes: ['npm test'],
      };
      const payload: PolicyBundlePayload = { version: 1, rules: [rule] };
      const registry = getPolicyRuntimeState().getRegistry();
      registry.loadCandidate(createUnsignedBundle('policy-allow-npm-test', payload));
      registry.markSimulating();
      registry.attachSimulationReport(
        {
          overall: { total: 0, byType: { 'allow-vs-deny': 0, 'deny-vs-allow': 0, 'reason-mismatch': 0 }, divergenceRate: 0, totalEvaluations: 0 },
          byToolClass: {},
          byCommandPrefix: {},
          byMode: {},
          records: [],
        },
        { status: 'allowed', threshold: 0.05, divergenceRate: 0, totalEvaluations: 0, message: 'ok' },
      );
      registry.promote(true);

      const result = await manager.check('exec', { command: 'npm test' });
      expect(result).toBe(true);
      expect(requests).toHaveLength(0);
    });
  });

  describe('session approval cache', () => {
    test('caches approval when remember=true — only 1 prompt for 2 identical calls', async () => {
      if (getConfigSnapshot().behavior.autoApprove) {
        // autoApprove skips prompts; cache logic isn't exercised
        await manager.check('write', { path: 'cached.ts' });
        await manager.check('write', { path: 'cached.ts' });
        return;
      }

      expect.assertions(1);
      decisions.push({ approved: true, remember: true });

      await manager.check('write', { path: 'cached.ts' });
      await manager.check('write', { path: 'cached.ts' });

      expect(requests).toHaveLength(1);
    });

    test('different paths get separate cache entries — up to 2 prompts', async () => {
      if (getConfigSnapshot().behavior.autoApprove) {
        await manager.check('write', { path: 'file-a.ts' });
        await manager.check('write', { path: 'file-b.ts' });
        return;
      }

      expect.assertions(1);
      decisions.push({ approved: true, remember: true }, { approved: true, remember: true });

      await manager.check('write', { path: 'file-a.ts' });
      await manager.check('write', { path: 'file-b.ts' });

      expect(requests).toHaveLength(2);
    });

    test('cached denial is returned without prompting again', async () => {
      if (getConfigSnapshot().behavior.autoApprove) {
        // autoApprove=true means the denial path can't be reached
        return;
      }

      expect.assertions(3);
      decisions.push({ approved: false, remember: true });

      const first = await manager.check('edit', { path: 'denied.ts' });
      const second = await manager.check('edit', { path: 'denied.ts' });

      expect(first).toBe(false);
      expect(second).toBe(false);
      expect(requests).toHaveLength(1);
    });
  });
});
