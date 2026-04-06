import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default TTL for spawn tokens: 1 hour in milliseconds. */
const DEFAULT_TOKEN_TTL_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpawnToken {
  type: 'orchestrator' | 'agent';
  sessionId: string;
  issuedTo: string;         // agent ID or 'main'
  issuedBy: string;         // 'system' for orchestrator, agent ID for agent tokens
  depth: number;            // 0 for orchestrator, 1 for agent tokens
  maxDepth: number;         // from config, always 0 or 1
  canGenerate: boolean;     // true for orchestrator, false for agent
  expiresAt: number;        // Unix ms timestamp — Date.now() + TTL
  signature: string;        // HMAC-SHA256
}

export interface OrchestrationPolicyConfig {
  recursionEnabled: boolean;
  maxDepth: number;
  maxActiveAgents: number;
}

interface ValidateResult {
  valid: boolean;
  reason?: string;
}

interface CanSpawnResult {
  allowed: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// SpawnTokenManager
// ---------------------------------------------------------------------------

/**
 * Manages spawn tokens for the bounded recursive orchestration security model.
 *
 * Security model (3 layers):
 *   1. Policy gate   — recursionEnabled must be true
 *   2. Capacity gate — currentAgentCount < maxActiveAgents && depth <= maxDepth
 *   3. Token gate    — token must be valid, authentic, not expired, and canGenerate
 */
export class SpawnTokenManager {
  private static instance: SpawnTokenManager | null = null;

  private secret: string;
  private tokens = new Map<string, SpawnToken>();

  constructor(sessionId: string) {
    // Per-session random secret — never shared outside this instance
    this.secret = `${sessionId}:${randomBytes(32).toString('hex')}`;
  }

  // -------------------------------------------------------------------------
  // Singleton
  // -------------------------------------------------------------------------

  static getInstance(sessionId?: string): SpawnTokenManager {
    if (!SpawnTokenManager.instance) {
      if (!sessionId) {
        sessionId = randomBytes(8).toString('hex');
      }
      SpawnTokenManager.instance = new SpawnTokenManager(sessionId);
    }
    return SpawnTokenManager.instance;
  }

  /** Reset the singleton — primarily for testing. */
  static resetInstance(): void {
    SpawnTokenManager.instance = null;
  }

  // -------------------------------------------------------------------------
  // Signing
  // -------------------------------------------------------------------------

  private sign(token: Omit<SpawnToken, 'signature'>): string {
    const payload = JSON.stringify({
      type: token.type,
      sessionId: token.sessionId,
      issuedTo: token.issuedTo,
      issuedBy: token.issuedBy,
      depth: token.depth,
      maxDepth: token.maxDepth,
      canGenerate: token.canGenerate,
      expiresAt: token.expiresAt,
    });
    return createHmac('sha256', this.secret).update(payload).digest('hex');
  }

  private verifySignature(token: SpawnToken): boolean {
    const expected = this.sign(token);
    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(token.signature);
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Create the orchestrator token. Called once at session start.
   * The orchestrator token can generate agent tokens.
   */
  createOrchestratorToken(ttlMs: number = DEFAULT_TOKEN_TTL_MS): SpawnToken {
    const partial: Omit<SpawnToken, 'signature'> = {
      type: 'orchestrator',
      sessionId: this.secret.split(':')[0],
      issuedTo: 'main',
      issuedBy: 'system',
      depth: 0,
      maxDepth: 1,
      canGenerate: true,
      expiresAt: Date.now() + ttlMs,
    };
    const token: SpawnToken = { ...partial, signature: this.sign(partial) };
    this.tokens.set(token.signature, token);
    return token;
  }

  /**
   * Generate an agent token from an orchestrator token.
   * Returns null if the orchestrator token is invalid or cannot generate.
   */
  generateAgentToken(
    orchestratorToken: SpawnToken,
    agentId: string,
    ttlMs: number = DEFAULT_TOKEN_TTL_MS,
  ): SpawnToken | null {
    const validation = this.validate(orchestratorToken);
    if (!validation.valid) {
      logger.info('generateAgentToken: orchestrator token invalid', { reason: validation.reason });
      return null;
    }
    if (!orchestratorToken.canGenerate) {
      logger.info('generateAgentToken: token does not have canGenerate=true', { issuedTo: orchestratorToken.issuedTo });
      return null;
    }
    if (orchestratorToken.type !== 'orchestrator') {
      logger.info('generateAgentToken: only orchestrator tokens can generate agent tokens');
      return null;
    }

    const partial: Omit<SpawnToken, 'signature'> = {
      type: 'agent',
      sessionId: orchestratorToken.sessionId,
      issuedTo: agentId,
      issuedBy: 'main',
      depth: 1,
      maxDepth: orchestratorToken.maxDepth,
      canGenerate: false,   // agents cannot generate further tokens
      expiresAt: Date.now() + ttlMs,
    };
    const token: SpawnToken = { ...partial, signature: this.sign(partial) };
    this.tokens.set(token.signature, token);
    return token;
  }

  /**
   * Validate a token is authentic (correct HMAC), registered, and not expired.
   */
  validate(token: SpawnToken): ValidateResult {
    if (!token || typeof token !== 'object') {
      return { valid: false, reason: 'token is not an object' };
    }
    if (!token.signature) {
      return { valid: false, reason: 'token has no signature' };
    }
    if (!this.tokens.has(token.signature)) {
      return { valid: false, reason: 'token not registered (revoked or foreign)' };
    }
    if (!this.verifySignature(token)) {
      return { valid: false, reason: 'signature mismatch — token tampered' };
    }
    if (Date.now() > token.expiresAt) {
      return { valid: false, reason: 'token expired' };
    }
    return { valid: true };
  }

  /**
   * Check if spawning is allowed given config constraints and token.
   * 3-layer check: config gate → capacity gate → token gate.
   */
  canSpawn(
    token: SpawnToken,
    config: OrchestrationPolicyConfig,
    currentAgentCount: number,
  ): CanSpawnResult {
    // Layer 1: policy gate
    if (!config.recursionEnabled) {
      return { allowed: false, reason: 'recursive orchestration is disabled in policy' };
    }

    // Layer 2: capacity checks
    if (currentAgentCount >= config.maxActiveAgents) {
      return {
        allowed: false,
        reason: `maxActiveAgents limit reached (${currentAgentCount}/${config.maxActiveAgents})`,
      };
    }
    if (token.depth > config.maxDepth) {
      return {
        allowed: false,
        reason: `depth ${token.depth} exceeds maxDepth ${config.maxDepth}`,
      };
    }

    // Layer 3: token gate
    const validation = this.validate(token);
    if (!validation.valid) {
      return { allowed: false, reason: `invalid token: ${validation.reason}` };
    }

    return { allowed: true };
  }

  /**
   * Revoke a token by its signature.
   * Returns true if the token was found and revoked.
   */
  revoke(tokenSignature: string): boolean {
    return this.tokens.delete(tokenSignature);
  }
}
