import { describe, it, expect } from 'bun:test';
import type { SandboxAvailability } from '@pellux/goodvibes-sdk/platform/tools/exec/sandbox';
import type { PermissionPromptRequest, PermissionPromptDecision } from '@pellux/goodvibes-sdk/platform/permissions';
import {
  createSandboxExecAsk,
  extractExecCommands,
  readSandboxAskAnnotation,
  type SandboxExecAskDeps,
} from '../../permissions/sandbox-exec-gate.ts';

const AVAILABLE: SandboxAvailability = {
  available: true,
  backend: 'bubblewrap',
  bwrapPath: '/usr/bin/bwrap',
  reason: 'bubblewrap sandbox available; network isolation confirmed',
  networkIsolationGuaranteed: true,
};

const UNAVAILABLE: SandboxAvailability = {
  available: false,
  backend: 'none',
  reason: 'bubblewrap (bwrap) was not found on PATH',
  networkIsolationGuaranteed: false,
};

function execRequest(command: string | { commands: unknown[] }): PermissionPromptRequest {
  const args = typeof command === 'string' ? { command } : command;
  return {
    callId: 'c1',
    tool: 'exec',
    args: args as Record<string, unknown>,
    category: 'execute',
    analysis: { classification: 'shell', riskLevel: 'high', summary: 'run a command', reasons: [] },
  };
}

function deps(overrides: Partial<SandboxExecAskDeps> = {}): SandboxExecAskDeps {
  return {
    isSandboxFeatureEnabled: () => true,
    isSandboxConfigEnabled: () => true,
    readEgressAllowlist: () => [],
    detectAvailability: () => AVAILABLE,
    ...overrides,
  };
}

describe('extractExecCommands', () => {
  it('reads a single command string', () => {
    expect(extractExecCommands(execRequest('ls -la'))).toEqual(['ls -la']);
  });
  it('reads a commands array of {cmd} entries', () => {
    expect(extractExecCommands(execRequest({ commands: [{ cmd: 'echo a' }, { cmd: 'echo b' }] }))).toEqual(['echo a', 'echo b']);
  });
});

describe('createSandboxExecAsk', () => {
  it('passes non-exec requests straight through', async () => {
    let asked = false;
    const ask = async (): Promise<PermissionPromptDecision> => { asked = true; return { approved: false }; };
    const gate = createSandboxExecAsk(deps(), ask);
    const req = { ...execRequest('ls'), tool: 'write', category: 'write' } as PermissionPromptRequest;
    await gate(req);
    expect(asked).toBe(true);
  });

  it('auto-allows a boundary-safe command without prompting when the sandbox is active', async () => {
    let asked = false;
    const ask = async (): Promise<PermissionPromptDecision> => { asked = true; return { approved: false }; };
    const gate = createSandboxExecAsk(deps(), ask);
    const decision = await gate(execRequest('echo hello'));
    expect(decision).toEqual({ approved: true });
    expect(asked).toBe(false);
  });

  it('surfaces a named network escalation as an ask instead of auto-allowing', async () => {
    let seen: PermissionPromptRequest | null = null;
    const ask = async (r: PermissionPromptRequest): Promise<PermissionPromptDecision> => { seen = r; return { approved: false }; };
    const gate = createSandboxExecAsk(deps(), ask);
    await gate(execRequest('curl https://example.com'));
    expect(seen).not.toBeNull();
    const annotation = readSandboxAskAnnotation(seen);
    expect(annotation).not.toBeNull();
    expect(annotation!.sandboxEscalations.some((e) => e.includes('wants network'))).toBe(true);
  });

  it('does not intervene when the feature flag is off (base policy applies)', async () => {
    let seen: PermissionPromptRequest | null = null;
    const ask = async (r: PermissionPromptRequest): Promise<PermissionPromptDecision> => { seen = r; return { approved: false }; };
    const gate = createSandboxExecAsk(deps({ isSandboxFeatureEnabled: () => false }), ask);
    await gate(execRequest('echo hello'));
    expect(seen).not.toBeNull();
    expect(readSandboxAskAnnotation(seen)).toBeNull();
  });

  it('does not auto-allow when the host cannot provide a boundary', async () => {
    let asked = false;
    const ask = async (): Promise<PermissionPromptDecision> => { asked = true; return { approved: false }; };
    const gate = createSandboxExecAsk(deps({ detectAvailability: () => UNAVAILABLE }), ask);
    await gate(execRequest('echo hello'));
    expect(asked).toBe(true);
  });

  it('a batch auto-allows only when every command is boundary-safe', async () => {
    let asked = false;
    const ask = async (r: PermissionPromptRequest): Promise<PermissionPromptDecision> => {
      asked = true;
      const annotation = readSandboxAskAnnotation(r);
      expect(annotation?.sandboxEscalations.some((e) => e.includes('wants network'))).toBe(true);
      return { approved: false };
    };
    const gate = createSandboxExecAsk(deps(), ask);
    // one safe + one network → the whole batch asks with the union of escalations
    await gate(execRequest({ commands: [{ cmd: 'echo ok' }, { cmd: 'curl https://x.test' }] }));
    expect(asked).toBe(true);
  });

  it('memoizes the host probe across asks', async () => {
    let probes = 0;
    const ask = async (): Promise<PermissionPromptDecision> => ({ approved: false });
    const gate = createSandboxExecAsk(deps({ detectAvailability: () => { probes++; return AVAILABLE; } }), ask);
    await gate(execRequest('echo a'));
    await gate(execRequest('echo b'));
    expect(probes).toBe(1);
  });
});
