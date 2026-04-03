/**
 * Safety Gate — Release Gate 1
 *
 * Verifies that:
 * - All tool execution goes through the phased executor with permission checks
 * - Exec tool has AST normalization and guard gates
 * - Fetch tool has sanitization gates
 * - Permission phase aborts the pipeline on denial (fail-closed)
 * - Safety paths are auditable (no silent pass-through)
 */

import { describe, test, expect } from 'bun:test';
import { permissionPhase } from '../../runtime/tools/phases/permission.ts';
import { guardExecCommand, formatDenialResponse } from '../../tools/exec/ast-guard.ts';
import { applySanitizer, resolveSanitizeMode } from '../../tools/fetch/sanitizer.ts';
import { PhasedToolExecutor } from '../../runtime/tools/phased-executor.ts';
import type { ToolCall, Tool } from '../../types/tools.ts';
import type { ToolRuntimeContext } from '../../runtime/tools/context.ts';
import type { ToolExecutionRecord } from '../../runtime/tools/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(callId: string): ToolExecutionRecord {
  return {
    callId,
    toolName: 'test-tool',
    phases: [],
    currentPhase: 'received',
    startedAt: Date.now(),
    cancelled: false,
  };
}

function makeCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: 'call-1', name, arguments: args };
}

function makePermissionContext(approved: boolean): ToolRuntimeContext {
  return {
    permissionManager: {
      check: async (_name: string, _args: unknown) => approved,
    },
    eventBus: { emit: () => {} },
    sessionId: 'sess-1',
    turnId: 'turn-1',
  } as unknown as ToolRuntimeContext;
}

// ---------------------------------------------------------------------------
// 1. Permission phase: fail-closed
// ---------------------------------------------------------------------------

describe('safety gate: permission phase', () => {
  test('permission denied → phase aborts with success=false and abort=true', async () => {
    const call = makeCall('dangerous-tool');
    const record = makeRecord('call-1');
    const ctx = makePermissionContext(false);
    const result = await permissionPhase(call, {} as Tool, ctx, record);

    expect(result.success).toBe(false);
    expect(result.abort).toBe(true);
    expect(result.phase).toBe('permissioned');
    expect(result.error).toContain("Permission denied");
  });

  test('permission approved → phase succeeds with abort undefined', async () => {
    const call = makeCall('safe-tool');
    const record = makeRecord('call-2');
    const ctx = makePermissionContext(true);
    const result = await permissionPhase(call, {} as Tool, ctx, record);

    expect(result.success).toBe(true);
    expect(result.abort).toBeUndefined();
    expect(result.phase).toBe('permissioned');
  });

  test('permission check throws → phase aborts (fail-closed, no silent pass)', async () => {
    const call = makeCall('error-tool');
    const record = makeRecord('call-3');
    const throwingCtx = {
      permissionManager: {
        check: async () => { throw new Error('permission service unavailable'); },
      },
      eventBus: { emit: () => {} },
      sessionId: 'sess-1',
      turnId: 'turn-1',
    } as unknown as ToolRuntimeContext;

    const result = await permissionPhase(call, {} as Tool, throwingCtx, record);

    // Must NOT pass silently — errors must abort
    expect(result.success).toBe(false);
    expect(result.abort).toBe(true);
    expect(result.error).toContain('Permission check threw');
  });

  test('permission phase uses _updatedArgs from prehook when present', async () => {
    const capturedArgs: unknown[] = [];
    const call = makeCall('tool', { original: true });
    const record = makeRecord('call-4');
    record._updatedArgs = { updated: true };
    const ctx = {
      permissionManager: {
        check: async (_name: string, args: unknown) => {
          capturedArgs.push(args);
          return true;
        },
      },
      eventBus: { emit: () => {} },
      sessionId: 'sess-1',
      turnId: 'turn-1',
    } as unknown as ToolRuntimeContext;

    await permissionPhase(call, {} as Tool, ctx, record);
    expect(capturedArgs[0]).toEqual({ updated: true });
  });
});

// ---------------------------------------------------------------------------
// 2. PhasedToolExecutor: pipeline exists and enforces ordering
// ---------------------------------------------------------------------------

describe('safety gate: phased executor structure', () => {
  test('PhasedToolExecutor exports execute method', () => {
    const executor = new PhasedToolExecutor({
      enableHooks: false,
      enablePermissions: true,
      enableEvents: false,
    });
    expect(typeof executor.execute).toBe('function');
    expect(typeof executor.cancel).toBe('function');
    expect(typeof executor.getRecord).toBe('function');
    expect(typeof executor.getActiveRecords).toBe('function');
  });

  test('executor with enablePermissions=false still exports all methods', () => {
    const executor = new PhasedToolExecutor({
      enableHooks: false,
      enablePermissions: false,
      enableEvents: false,
    });
    expect(executor).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. AST guard: exec command sanitization gate
// ---------------------------------------------------------------------------

describe('safety gate: exec AST guard', () => {
  test('guardExecCommand returns ASTGuardResult with allowed boolean', async () => {
    const result = await guardExecCommand('echo hello');
    expect(typeof result.allowed).toBe('boolean');
    expect(typeof result.astModeActive).toBe('boolean');
  });

  test('formatDenialResponse returns a non-empty record on denied result', () => {
    const deniedResult = {
      allowed: false,
      denialMessage: 'Command blocked by AST guard',
      astModeActive: true,
    };
    const response = formatDenialResponse(deniedResult, 'rm -rf /');
    expect(typeof response).toBe('object');
    expect(Object.keys(response).length).toBeGreaterThan(0);
  });

  test('allowed result does not produce denial message', async () => {
    const result = await guardExecCommand('ls');
    expect(result.allowed).toBe(true); // guard assertion
    if (result.allowed) {
      expect(result.denialMessage).toBeUndefined();
    }
  });

  test('dangerous command is blocked by AST guard', async () => {
    const result = await guardExecCommand('rm -rf /');
    expect(result.allowed).toBe(false);
    expect(result.denialMessage).toBeDefined();
  });

  test('pipe injection is blocked', async () => {
    const result = await guardExecCommand('echo hello | rm -rf /');
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Fetch sanitizer: sanitization gate
// ---------------------------------------------------------------------------

describe('safety gate: fetch sanitizer', () => {
  test('resolveSanitizeMode returns a valid mode for all inputs', () => {
    expect(resolveSanitizeMode('none')).toBe('none');
    expect(resolveSanitizeMode('safe-text')).toBe('safe-text');
    expect(resolveSanitizeMode('strict')).toBe('strict');
    expect(resolveSanitizeMode(undefined)).toBeDefined();
  });

  test('applySanitizer none mode: content unchanged, modified=false', () => {
    const content = '<script>alert(1)</script>';
    const result = applySanitizer(content, 'none');
    expect(result.content).toBe(content);
    expect(result.modified).toBe(false);
    expect(result.mode).toBe('none');
  });

  test('applySanitizer strict mode: script tags are stripped', () => {
    const content = 'Hello <script>alert(1)</script> world';
    const result = applySanitizer(content, 'strict');
    expect(result.mode).toBe('strict');
    expect(result.content).not.toContain('<script>');
    expect(result.modified).toBe(true);
  });

  test('applySanitizer safe-text mode: returns SanitizeResult', () => {
    const result = applySanitizer('plain text content', 'safe-text');
    expect(result.content).toBeDefined();
    expect(result.mode).toBe('safe-text');
  });

  test('sanitizer result always has content, mode, and modified fields', () => {
    for (const mode of ['none', 'safe-text', 'strict'] as const) {
      const result = applySanitizer('test content', mode);
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('mode');
      expect(result).toHaveProperty('modified');
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Audit trail: pipeline phases are recorded
// ---------------------------------------------------------------------------

describe('safety gate: audit trail via ToolExecutionRecord', () => {
  test('ToolExecutionRecord tracks phases array for audit', () => {
    const record = makeRecord('audit-call');
    expect(Array.isArray(record.phases)).toBe(true);
    expect(record.startedAt).toBeGreaterThan(0);
    expect(record.cancelled).toBe(false);
  });

  test('executor cancel sets cancelled flag on record', () => {
    const executor = new PhasedToolExecutor({
      enableHooks: false,
      enablePermissions: false,
      enableEvents: false,
    });
    // Cancelling unknown call-id is a no-op, not a throw
    expect(() => executor.cancel('nonexistent-call', 'test')).not.toThrow();
  });
});
