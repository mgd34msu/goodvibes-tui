import { describe, test, expect, beforeEach } from 'bun:test';
import { SpawnTokenManager } from '@pellux/goodvibes-sdk/platform/security';
import type { SpawnToken, OrchestrationPolicyConfig } from '@pellux/goodvibes-sdk/platform/security';
import { getTestSpawnTokenManager, resetTestSpawnTokenManagers } from '../helpers/runtime-services.ts';

// ---------------------------------------------------------------------------
// Setup: reset shared test helper state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetTestSpawnTokenManagers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultConfig(overrides: Partial<OrchestrationPolicyConfig> = {}): OrchestrationPolicyConfig {
  return {
    recursionEnabled: true,
    maxDepth: 1,
    maxActiveAgents: 8,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator token
// ---------------------------------------------------------------------------

describe('createOrchestratorToken', () => {
  test('creates a token with type orchestrator', () => {
    const manager = getTestSpawnTokenManager('sess-001');
    const token = manager.createOrchestratorToken();
    expect(token.type).toBe('orchestrator');
  });

  test('orchestrator token is issued to main', () => {
    const manager = getTestSpawnTokenManager('sess-001');
    const token = manager.createOrchestratorToken();
    expect(token.issuedTo).toBe('main');
  });

  test('orchestrator token is issued by system', () => {
    const manager = getTestSpawnTokenManager('sess-001');
    const token = manager.createOrchestratorToken();
    expect(token.issuedBy).toBe('system');
  });

  test('orchestrator token has depth 0', () => {
    const manager = getTestSpawnTokenManager('sess-001');
    const token = manager.createOrchestratorToken();
    expect(token.depth).toBe(0);
  });

  test('orchestrator token has canGenerate true', () => {
    const manager = getTestSpawnTokenManager('sess-001');
    const token = manager.createOrchestratorToken();
    expect(token.canGenerate).toBe(true);
  });

  test('orchestrator token has a non-empty signature', () => {
    const manager = getTestSpawnTokenManager('sess-001');
    const token = manager.createOrchestratorToken();
    expect(typeof token.signature).toBe('string');
    expect(token.signature.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Agent token generation
// ---------------------------------------------------------------------------

describe('generateAgentToken', () => {
  test('generates an agent token from orchestrator token', () => {
    const manager = getTestSpawnTokenManager('sess-002');
    const orchestrator = manager.createOrchestratorToken();
    const agentToken = manager.generateAgentToken(orchestrator, 'agent-abc');
    expect(agentToken).not.toBeNull();
    expect(agentToken!.type).toBe('agent');
  });

  test('agent token is issued to the given agentId', () => {
    const manager = getTestSpawnTokenManager('sess-002');
    const orchestrator = manager.createOrchestratorToken();
    const agentToken = manager.generateAgentToken(orchestrator, 'agent-abc');
    expect(agentToken!.issuedTo).toBe('agent-abc');
  });

  test('agent token has depth 1', () => {
    const manager = getTestSpawnTokenManager('sess-002');
    const orchestrator = manager.createOrchestratorToken();
    const agentToken = manager.generateAgentToken(orchestrator, 'agent-abc');
    expect(agentToken!.depth).toBe(1);
  });

  test('agent token has canGenerate false', () => {
    const manager = getTestSpawnTokenManager('sess-002');
    const orchestrator = manager.createOrchestratorToken();
    const agentToken = manager.generateAgentToken(orchestrator, 'agent-abc');
    expect(agentToken!.canGenerate).toBe(false);
  });

  test('agent token cannot generate further tokens', () => {
    const manager = getTestSpawnTokenManager('sess-002');
    const orchestrator = manager.createOrchestratorToken();
    const agentToken = manager.generateAgentToken(orchestrator, 'agent-abc');
    // Attempt to use the agent token to generate another token
    const grandchild = manager.generateAgentToken(agentToken!, 'agent-xyz');
    expect(grandchild).toBeNull();
  });

  test('returns null for revoked orchestrator token', () => {
    const manager = getTestSpawnTokenManager('sess-002');
    const orchestrator = manager.createOrchestratorToken();
    manager.revoke(orchestrator.signature);
    const result = manager.generateAgentToken(orchestrator, 'agent-abc');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

describe('validate', () => {
  test('validates an authentic orchestrator token', () => {
    const manager = getTestSpawnTokenManager('sess-003');
    const token = manager.createOrchestratorToken();
    const result = manager.validate(token);
    expect(result.valid).toBe(true);
  });

  test('validates an authentic agent token', () => {
    const manager = getTestSpawnTokenManager('sess-003');
    const orchestrator = manager.createOrchestratorToken();
    const agentToken = manager.generateAgentToken(orchestrator, 'agent-001')!;
    const result = manager.validate(agentToken);
    expect(result.valid).toBe(true);
  });

  test('rejects a tampered token (modified issuedTo)', () => {
    const manager = getTestSpawnTokenManager('sess-003');
    const token = manager.createOrchestratorToken();
    // Tamper with the token payload while keeping original signature
    const tampered: SpawnToken = { ...token, issuedTo: 'attacker' };
    const result = manager.validate(tampered);
    expect(result.valid).toBe(false);
  });

  test('rejects a tampered token (modified canGenerate)', () => {
    const manager = getTestSpawnTokenManager('sess-003');
    const orchestrator = manager.createOrchestratorToken();
    const agentToken = manager.generateAgentToken(orchestrator, 'agent-001')!;
    const tampered: SpawnToken = { ...agentToken, canGenerate: true };
    const result = manager.validate(tampered);
    expect(result.valid).toBe(false);
  });

  test('rejects a token that is not registered', () => {
    const manager = getTestSpawnTokenManager('sess-003');
    // Create token with a different manager (different secret) — not registered here
    resetTestSpawnTokenManagers();
    const other = getTestSpawnTokenManager('sess-003b');
    const foreignToken = other.createOrchestratorToken();
    resetTestSpawnTokenManagers();
    const fresh = getTestSpawnTokenManager('sess-003c');
    const result = fresh.validate(foreignToken);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canSpawn
// ---------------------------------------------------------------------------

describe('canSpawn', () => {
  test('allows spawning when config permits and token is valid', () => {
    const manager = getTestSpawnTokenManager('sess-004');
    const token = manager.createOrchestratorToken();
    const result = manager.canSpawn(token, defaultConfig(), 0);
    expect(result.allowed).toBe(true);
  });

  test('denies when recursive orchestration is disabled', () => {
    const manager = getTestSpawnTokenManager('sess-004');
    const token = manager.createOrchestratorToken();
    const result = manager.canSpawn(token, defaultConfig({ recursionEnabled: false }), 0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('recursive orchestration');
  });

  test('denies when maxActiveAgents is exceeded', () => {
    const manager = getTestSpawnTokenManager('sess-004');
    const token = manager.createOrchestratorToken();
    const result = manager.canSpawn(token, defaultConfig({ maxActiveAgents: 3 }), 3);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('fleet.maxSize');
  });

  test('denies when depth exceeds maxDepth', () => {
    const manager = getTestSpawnTokenManager('sess-004');
    const orchestrator = manager.createOrchestratorToken();
    const agentToken = manager.generateAgentToken(orchestrator, 'agent-deep')!;
    // Agent token has depth=1; maxDepth=0 means no recursion allowed
    const result = manager.canSpawn(agentToken, defaultConfig({ maxDepth: 0 }), 0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('maxDepth');
  });

  test('denies when token is invalid (revoked)', () => {
    const manager = getTestSpawnTokenManager('sess-004');
    const token = manager.createOrchestratorToken();
    manager.revoke(token.signature);
    const result = manager.canSpawn(token, defaultConfig(), 0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('invalid token');
  });

  test('denies when currentAgentCount is exactly at the limit', () => {
    const manager = getTestSpawnTokenManager('sess-004');
    const token = manager.createOrchestratorToken();
    const result = manager.canSpawn(token, defaultConfig({ maxActiveAgents: 5 }), 5);
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

describe('revoke', () => {
  test('revokes a registered token', () => {
    const manager = getTestSpawnTokenManager('sess-005');
    const token = manager.createOrchestratorToken();
    const revoked = manager.revoke(token.signature);
    expect(revoked).toBe(true);
  });

  test('returns false for an unknown signature', () => {
    const manager = getTestSpawnTokenManager('sess-005');
    const revoked = manager.revoke('not-a-real-signature');
    expect(revoked).toBe(false);
  });

  test('revoked token fails validation', () => {
    const manager = getTestSpawnTokenManager('sess-005');
    const token = manager.createOrchestratorToken();
    manager.revoke(token.signature);
    const result = manager.validate(token);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Token expiry
// ---------------------------------------------------------------------------

describe('token expiry', () => {
  test('orchestrator token has expiresAt in the future', () => {
    const manager = getTestSpawnTokenManager('sess-exp-001');
    const before = Date.now();
    const token = manager.createOrchestratorToken();
    expect(token.expiresAt).toBeGreaterThan(before);
  });

  test('agent token has expiresAt in the future', () => {
    const manager = getTestSpawnTokenManager('sess-exp-002');
    const orchestrator = manager.createOrchestratorToken();
    const agentToken = manager.generateAgentToken(orchestrator, 'agent-exp-001')!;
    expect(agentToken.expiresAt).toBeGreaterThan(Date.now());
  });

  test('expired orchestrator token fails validate', () => {
    const manager = getTestSpawnTokenManager('sess-exp-003');
    const token = manager.createOrchestratorToken(/* ttlMs= */ -1);
    const result = manager.validate(token);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expired');
  });

  test('expired token prevents generateAgentToken', () => {
    const manager = getTestSpawnTokenManager('sess-exp-004');
    const expired = manager.createOrchestratorToken(/* ttlMs= */ -1);
    const result = manager.generateAgentToken(expired, 'agent-x');
    expect(result).toBeNull();
  });

  test('expiresAt is included in HMAC signature (tampered expiresAt rejected)', () => {
    const manager = getTestSpawnTokenManager('sess-exp-005');
    const token = manager.createOrchestratorToken();
    // Move expiresAt far into future — signature should no longer match
    const tampered: SpawnToken = { ...token, expiresAt: token.expiresAt + 999_999_999 };
    const result = manager.validate(tampered);
    expect(result.valid).toBe(false);
  });

  test('non-expired token validates successfully', () => {
    const manager = getTestSpawnTokenManager('sess-exp-006');
    const token = manager.createOrchestratorToken(3_600_000);
    const result = manager.validate(token);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Token type correctness
// ---------------------------------------------------------------------------

describe('token types', () => {
  test('orchestrator type is orchestrator', () => {
    const manager = getTestSpawnTokenManager('sess-006');
    const token = manager.createOrchestratorToken();
    expect(token.type).toBe('orchestrator');
  });

  test('agent type is agent', () => {
    const manager = getTestSpawnTokenManager('sess-006');
    const orchestrator = manager.createOrchestratorToken();
    const agentToken = manager.generateAgentToken(orchestrator, 'agent-type-test')!;
    expect(agentToken.type).toBe('agent');
  });

  test('two agent tokens for different agents have different signatures', () => {
    const manager = getTestSpawnTokenManager('sess-006');
    const orchestrator = manager.createOrchestratorToken();
    const t1 = manager.generateAgentToken(orchestrator, 'agent-A')!;
    const t2 = manager.generateAgentToken(orchestrator, 'agent-B')!;
    expect(t1.signature).not.toBe(t2.signature);
  });
});
