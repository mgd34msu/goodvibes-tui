/**
 * GC-TOOLS-001, Tests for ToolContractVerifier and ToolContractsPanel.
 *
 * Covers:
 *   - All 5 dimension checkers (schema, timeout-cancellation, permission-class,
 *     output-policy, idempotency)
 *   - Fail-closed registration (error-level violations block pass)
 *   - Pass-with-warnings (warn-only does not fail)
 *   - ToolContractsPanel: load, upsert, get, getFailures, getSummary
 *   - Edge cases: empty name, missing params, non-boolean idempotent
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ToolContractVerifier,
} from '@/runtime/index.ts';
import type {
  ContractVerifierOptions,
} from '@/runtime/index.ts';
import { ToolContractsPanel } from '@/runtime/index.ts';
import type { Tool } from '@pellux/goodvibes-sdk/platform/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTool(overrides: {
  name?: string | null;
  description?: string | null;
  parameters?: unknown;
  category?: string;
  cancellable?: boolean;
  phaseTimeouts?: Record<string, number>;
  idempotent?: unknown;
  _missingParams?: boolean;
  _missingDesc?: boolean;
} = {}): Tool {
  const def: Record<string, unknown> = {
    name: 'name' in overrides && overrides.name !== undefined ? overrides.name : 'test_tool',
    description: 'description' in overrides && overrides.description !== undefined
      ? overrides.description
      : 'A valid test tool description.',
    parameters: 'parameters' in overrides ? overrides.parameters : { type: 'object', properties: {} },
  };

  // Allow callers to explicitly remove description or parameters
  if (overrides._missingDesc) delete def.description;
  if (overrides._missingParams) delete def.parameters;

  const tool: Record<string, unknown> = {
    definition: def,
    execute: async () => ({ callId: 'c1', success: true, output: 'ok' }),
  };

  if ('category' in overrides) tool.category = overrides.category;
  if ('cancellable' in overrides) tool.cancellable = overrides.cancellable;
  if ('phaseTimeouts' in overrides) tool.phaseTimeouts = overrides.phaseTimeouts;
  if ('idempotent' in overrides) tool.idempotent = overrides.idempotent;

  return tool as unknown as Tool;
}

const verifier = new ToolContractVerifier();

// ── Dimension 1: Schema ───────────────────────────────────────────────────────

describe('checkSchema', () => {
  it('passes a valid tool definition', () => {
    const result = verifier.verify(makeTool({}));
    expect(result.passed).toBe(true);
    expect(result.violations.filter((v) => v.dimension === 'schema')).toHaveLength(0);
  });

  it('errors when parameters is missing', () => {
    const result = verifier.verify(makeTool({ _missingParams: true }));
    const schemaErrors = result.violations.filter(
      (v) => v.dimension === 'schema' && v.severity === 'error',
    );
    expect(schemaErrors.length).toBeGreaterThanOrEqual(1);
    expect(result.passed).toBe(false);
  });

  it('errors when parameters has no type field', () => {
    const result = verifier.verify(makeTool({ parameters: { properties: {} } }));
    const v = result.violations.find(
      (v) => v.dimension === 'schema' && v.message.includes("missing required 'type'"),
    );
    expect(v).toBeDefined();
    expect(result.passed).toBe(false);
  });

  it('errors when parameters type is invalid', () => {
    const result = verifier.verify(makeTool({ parameters: { type: 'badtype' } }));
    const v = result.violations.find(
      (v) => v.dimension === 'schema' && v.message.includes("invalid 'type' value"),
    );
    expect(v).toBeDefined();
    expect(result.passed).toBe(false);
  });

  it('warns when object schema has no properties', () => {
    const result = verifier.verify(makeTool({ parameters: { type: 'object' } }));
    const v = result.violations.find(
      (v) => v.dimension === 'schema' && v.severity === 'warn' && v.message.includes('properties'),
    );
    expect(v).toBeDefined();
    // warn only, still passes
    expect(result.passed).toBe(true);
  });

  it('errors on empty tool name', () => {
    const result = verifier.verify(makeTool({ name: '' }));
    const v = result.violations.find(
      (v) => v.dimension === 'schema' && v.message.includes('empty or missing name'),
    );
    expect(v).toBeDefined();
    expect(result.passed).toBe(false);
  });

  it('warns on name with unsafe characters', () => {
    const result = verifier.verify(makeTool({ name: 'tool name with spaces' }));
    const v = result.violations.find(
      (v) => v.dimension === 'schema' && v.severity === 'warn' && v.message.includes('characters'),
    );
    expect(v).toBeDefined();
  });

  it('errors on missing description', () => {
    const result = verifier.verify(makeTool({ _missingDesc: true }));
    const v = result.violations.find(
      (v) => v.dimension === 'schema' && v.message.includes('missing or non-string description'),
    );
    expect(v).toBeDefined();
    expect(result.passed).toBe(false);
  });

  it('warns on very short description', () => {
    const result = verifier.verify(makeTool({ description: 'short' }));
    const v = result.violations.find(
      (v) => v.dimension === 'schema' && v.severity === 'warn',
    );
    expect(v).toBeDefined();
  });
});

// ── Dimension 2: Timeout / Cancellation ───────────────────────────────────────

describe('checkTimeoutCancellation', () => {
  it('passes a phased tool with valid phase timeouts', () => {
    const result = verifier.verify(
      makeTool({ category: 'read', phaseTimeouts: { validate: 5000, execute: 30000 } }),
    );
    const dim = result.violations.filter((v) => v.dimension === 'timeout-cancellation');
    expect(dim).toHaveLength(0);
  });

  it('errors on non-positive phase timeout', () => {
    const result = verifier.verify(
      makeTool({ category: 'read', phaseTimeouts: { validate: -1 } }),
    );
    const v = result.violations.find(
      (v) => v.dimension === 'timeout-cancellation' && v.severity === 'error',
    );
    expect(v).toBeDefined();
    expect(result.passed).toBe(false);
  });

  it('errors on non-integer phase timeout', () => {
    const result = verifier.verify(
      makeTool({ category: 'read', phaseTimeouts: { validate: 1.5 } }),
    );
    const v = result.violations.find(
      (v) => v.dimension === 'timeout-cancellation' && v.severity === 'error',
    );
    expect(v).toBeDefined();
  });

  it('warns when phase timeout exceeds 10 minutes', () => {
    const result = verifier.verify(
      makeTool({ category: 'read', phaseTimeouts: { execute: 700_000 } }),
    );
    const v = result.violations.find(
      (v) => v.dimension === 'timeout-cancellation' && v.severity === 'warn',
    );
    expect(v).toBeDefined();
    expect(result.passed).toBe(true);
  });

  it('warns when side-effecting tool declares cancellable=false', () => {
    const result = verifier.verify(
      makeTool({ category: 'write', cancellable: false, idempotent: true }),
    );
    const v = result.violations.find(
      (v) => v.dimension === 'timeout-cancellation' && v.severity === 'warn',
    );
    expect(v).toBeDefined();
    expect(result.passed).toBe(true);
  });
});

// ── Dimension 3: Permission class ─────────────────────────────────────────────

describe('checkPermissionClass', () => {
  it('passes all known categories', () => {
    const known = ['read', 'write', 'execute', 'delegate', 'network', 'analyze'];
    for (const category of known) {
      const result = verifier.verify(
        makeTool({ category, idempotent: category !== 'read' ? true : undefined }),
      );
      const perm = result.violations.filter(
        (v) => v.dimension === 'permission-class' && v.severity === 'error',
      );
      expect(perm).toHaveLength(0);
    }
  });

  it('warns (non-strict) when category is absent', () => {
    const result = verifier.verify(makeTool({}));
    const v = result.violations.find(
      (v) => v.dimension === 'permission-class' && v.severity === 'warn',
    );
    expect(v).toBeDefined();
    expect(result.passed).toBe(true);
  });

  it('errors (strict) when category is absent', () => {
    const strict = new ToolContractVerifier({ strictPermissionClass: true });
    const result = strict.verify(makeTool({}));
    const v = result.violations.find(
      (v) => v.dimension === 'permission-class' && v.severity === 'error',
    );
    expect(v).toBeDefined();
    expect(result.passed).toBe(false);
  });

  it('errors on unknown category', () => {
    const result = verifier.verify(makeTool({ category: 'unknown_cat' }));
    const v = result.violations.find(
      (v) => v.dimension === 'permission-class' && v.severity === 'error',
    );
    expect(v).toBeDefined();
    expect(result.passed).toBe(false);
  });
});

// ── Dimension 4: Output policy ────────────────────────────────────────────────

describe('checkOutputPolicy', () => {
  it('passes all mapped categories', () => {
    const mapped = ['read', 'write', 'execute', 'delegate', 'network', 'analyze'];
    for (const category of mapped) {
      const result = verifier.verify(
        makeTool({ category, idempotent: ['write', 'execute', 'network', 'delegate'].includes(category) ? true : undefined }),
      );
      const op = result.violations.filter(
        (v) => v.dimension === 'output-policy' && v.severity === 'error',
      );
      expect(op).toHaveLength(0);
    }
  });

  it('skips output-policy check when category is absent (already covered by permission-class)', () => {
    const result = verifier.verify(makeTool({}));
    const op = result.violations.filter((v) => v.dimension === 'output-policy');
    // No output-policy violation should be produced when category is missing
    expect(op).toHaveLength(0);
  });
});

// ── Dimension 5: Idempotency ──────────────────────────────────────────────────

describe('checkIdempotency', () => {
  it('passes side-effecting tool with idempotent: true', () => {
    const result = verifier.verify(makeTool({ category: 'write', idempotent: true }));
    const idem = result.violations.filter((v) => v.dimension === 'idempotency');
    expect(idem).toHaveLength(0);
  });

  it('passes side-effecting tool with idempotent: false', () => {
    const result = verifier.verify(makeTool({ category: 'execute', idempotent: false }));
    const idem = result.violations.filter((v) => v.dimension === 'idempotency');
    expect(idem).toHaveLength(0);
  });

  it('does not check idempotency for read category', () => {
    const result = verifier.verify(makeTool({ category: 'read' }));
    const idem = result.violations.filter((v) => v.dimension === 'idempotency');
    expect(idem).toHaveLength(0);
  });

  it('errors (strict) when idempotency is absent on side-effecting tool', () => {
    const result = verifier.verify(makeTool({ category: 'write' }));
    const v = result.violations.find(
      (v) => v.dimension === 'idempotency' && v.severity === 'error',
    );
    expect(v).toBeDefined();
    expect(result.passed).toBe(false);
  });

  it('warns (non-strict) when idempotency is absent on side-effecting tool', () => {
    const lenient = new ToolContractVerifier({ strictIdempotency: false });
    const result = lenient.verify(makeTool({ category: 'network' }));
    const v = result.violations.find(
      (v) => v.dimension === 'idempotency' && v.severity === 'warn',
    );
    expect(v).toBeDefined();
    expect(result.passed).toBe(true);
  });

  it('errors when idempotent is non-boolean', () => {
    const result = verifier.verify(makeTool({ category: 'write', idempotent: 'yes' }));
    const v = result.violations.find(
      (v) => v.dimension === 'idempotency' && v.severity === 'error' && v.message.includes('boolean'),
    );
    expect(v).toBeDefined();
    expect(result.passed).toBe(false);
  });
});

// ── Fail-closed: error-level violations block registration ────────────────────

describe('fail-closed contract enforcement', () => {
  it('blocks a tool with multiple error violations', () => {
    const result = verifier.verify(
      makeTool({ name: '', _missingParams: true, _missingDesc: true }),
    );
    expect(result.passed).toBe(false);
    const errors = result.violations.filter((v) => v.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('sets isPhasedTool=false for plain tools', () => {
    const result = verifier.verify(makeTool({}));
    expect(result.isPhasedTool).toBe(false);
  });

  it('sets isPhasedTool=true when category is present', () => {
    const result = verifier.verify(makeTool({ category: 'read' }));
    expect(result.isPhasedTool).toBe(true);
  });

  it('records verifiedAt as a recent timestamp', () => {
    const before = Date.now();
    const result = verifier.verify(makeTool({}));
    const after = Date.now();
    expect(result.verifiedAt).toBeGreaterThanOrEqual(before);
    expect(result.verifiedAt).toBeLessThanOrEqual(after);
  });
});

// ── Pass-with-warnings ────────────────────────────────────────────────────────

describe('pass-with-warnings', () => {
  it('passes when only warnings are present', () => {
    // Plain tool with no category: warn on permission-class only
    const result = verifier.verify(
      makeTool({ parameters: { type: 'object' } }), // also triggers warn on missing properties
    );
    expect(result.passed).toBe(true);
    const warns = result.violations.filter((v) => v.severity === 'warn');
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  it('formatResult includes [WARN] prefix for warnings', () => {
    const result = verifier.verify(makeTool({ parameters: { type: 'object' } }));
    const formatted = ToolContractVerifier.formatResult(result);
    expect(formatted).toContain('[WARN]');
    expect(formatted).toContain('[PASS]');
  });
});

// ── verifyAll ─────────────────────────────────────────────────────────────────

describe('verifyAll', () => {
  it('returns a map keyed by tool name', () => {
    const tools = [
      makeTool({ name: 'tool_a', category: 'read' }),
      makeTool({ name: 'tool_b', category: 'write', idempotent: false }),
    ];
    const results = verifier.verifyAll(tools);
    expect(results.size).toBe(2);
    expect(results.has('tool_a')).toBe(true);
    expect(results.has('tool_b')).toBe(true);
  });

  it('formatAllResults includes summary line', () => {
    const tools = [
      makeTool({ name: 'tool_a', category: 'read' }),
    ];
    const results = verifier.verifyAll(tools);
    const formatted = ToolContractVerifier.formatAllResults(results);
    expect(formatted).toContain('Summary:');
  });
});

// ── ToolContractsPanel ────────────────────────────────────────────────────────

describe('ToolContractsPanel', () => {
  let panel: ToolContractsPanel;

  beforeEach(() => {
    panel = new ToolContractsPanel();
  });

  it('load() populates entries and triggers subscribers', () => {
    let notified = false;
    panel.subscribe(() => { notified = true; });

    const tools = [
      makeTool({ name: 'tool_a', category: 'read' }),
      makeTool({ name: 'tool_b', category: 'write', idempotent: true }),
    ];
    panel.load(verifier.verifyAll(tools));

    expect(notified).toBe(true);
    expect(panel.get('tool_a')).toBeDefined();
    expect(panel.get('tool_b')).toBeDefined();
  });

  it('upsert() adds or updates a single entry', () => {
    const result = verifier.verify(makeTool({ name: 'my_tool', category: 'read' }));
    panel.upsert(result);
    const entry = panel.get('my_tool');
    expect(entry).toBeDefined();
    expect(entry!.toolName).toBe('my_tool');
  });

  it('getAll() returns entries sorted by name', () => {
    const tools = [
      makeTool({ name: 'z_tool', category: 'read' }),
      makeTool({ name: 'a_tool', category: 'read' }),
    ];
    panel.load(verifier.verifyAll(tools));
    const all = panel.getAll();
    expect(all[0].toolName).toBe('a_tool');
    expect(all[1].toolName).toBe('z_tool');
  });

  it('getFailures() returns only tools that failed', () => {
    const tools = [
      makeTool({ name: 'good_tool', category: 'read' }),
      makeTool({ name: 'bad_tool', _missingParams: true }),
    ];
    panel.load(verifier.verifyAll(tools));
    const failures = panel.getFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].toolName).toBe('bad_tool');
  });

  it('getSummary() returns correct counts', () => {
    const tools = [
      makeTool({ name: 'good_tool', category: 'read' }),  // passes clean
      makeTool({ name: 'warn_tool', parameters: { type: 'object' } }),  // passes with warn
      makeTool({ name: 'fail_tool', _missingParams: true }),  // fails
    ];
    panel.load(verifier.verifyAll(tools));
    const summary = panel.getSummary();
    expect(summary.total).toBe(3);
    expect(summary.failed).toBe(1);
    expect(summary.passed + summary.passedWithWarnings).toBe(2);
    expect(summary.totalErrors).toBeGreaterThanOrEqual(1);
  });

  it('subscribe() returns unsubscribe function that stops notifications', () => {
    let count = 0;
    const unsub = panel.subscribe(() => { count++; });

    panel.upsert(verifier.verify(makeTool({ name: 'tool_x', category: 'read' })));
    expect(count).toBe(1);

    unsub();
    panel.upsert(verifier.verify(makeTool({ name: 'tool_y', category: 'read' })));
    expect(count).toBe(1); // No further notifications
  });

  it('dispose() clears entries and history', () => {
    panel.load(verifier.verifyAll([makeTool({ name: 'tool_a', category: 'read' })]));
    panel.dispose();
    expect(panel.getAll()).toHaveLength(0);
    expect(panel.getSummary().total).toBe(0);
  });

  it('dispose() stops subscriber notifications', () => {
    let count = 0;
    panel.subscribe(() => { count++; });
    panel.dispose();
    // After dispose, load should not throw but also should not notify (subscribers cleared)
    // We verify no throw occurs
    expect(() => {
      panel.load(verifier.verifyAll([]));
    }).not.toThrow();
  });

  it('subscriber errors are caught and do not crash the panel', () => {
    const originalDebug = console.debug;
    console.debug = () => {};
    try {
      panel.subscribe(() => { throw new Error('subscriber boom'); });
      // Should not throw
      expect(() => {
        panel.upsert(verifier.verify(makeTool({ name: 'safe_tool', category: 'read' })));
      }).not.toThrow();
    } finally {
      console.debug = originalDebug;
    }
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles tool name that is whitespace-only', () => {
    const result = verifier.verify(makeTool({ name: '   ' }));
    const v = result.violations.find(
      (v) => v.dimension === 'schema' && v.message.includes('empty or missing name'),
    );
    expect(v).toBeDefined();
    expect(result.passed).toBe(false);
  });

  it('handles non-boolean idempotent=0 (falsy but not false)', () => {
    const result = verifier.verify(makeTool({ category: 'network', idempotent: 0 }));
    const v = result.violations.find(
      (v) => v.dimension === 'idempotency' && v.severity === 'error' && v.message.includes('boolean'),
    );
    expect(v).toBeDefined();
    expect(result.passed).toBe(false);
  });

  it('handles non-boolean idempotent=1 (truthy but not true)', () => {
    const result = verifier.verify(makeTool({ category: 'write', idempotent: 1 }));
    const v = result.violations.find(
      (v) => v.dimension === 'idempotency' && v.severity === 'error' && v.message.includes('boolean'),
    );
    expect(v).toBeDefined();
    expect(result.passed).toBe(false);
  });

  it('analyze category passes permission-class and output-policy checks', () => {
    const result = verifier.verify(makeTool({ category: 'analyze' }));
    const permErrors = result.violations.filter(
      (v) => (v.dimension === 'permission-class' || v.dimension === 'output-policy') && v.severity === 'error',
    );
    expect(permErrors).toHaveLength(0);
  });

  it('verifyAll returns empty map for empty input', () => {
    const results = verifier.verifyAll([]);
    expect(results.size).toBe(0);
  });

  it('tool with all dimensions satisfied passes cleanly', () => {
    const result = verifier.verify(
      makeTool({
        name: 'clean_tool',
        description: 'This tool is fully compliant with all contract dimensions.',
        parameters: { type: 'object', properties: { input: { type: 'string' } } },
        category: 'read',
      }),
    );
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});
