import { describe, test, expect } from 'bun:test';
import { repairToolCall } from '@pellux/goodvibes-sdk/platform/tools';
import type { ToolDefinition } from '@pellux/goodvibes-sdk/platform/types';

// ---------------------------------------------------------------------------
// Test schema helpers
// ---------------------------------------------------------------------------

const AGENT_SCHEMA: ToolDefinition = {
  name: 'agent',
  description: 'Manages in-process subagents.',
  parameters: {
    type: 'object',
    required: ['mode'],
    properties: {
      mode: {
        type: 'string',
        enum: ['spawn', 'status', 'cancel', 'list', 'templates', 'get', 'budget', 'plan', 'wait', 'message'],
      },
      task: { type: 'string' },
      template: { type: 'string', enum: ['engineer', 'reviewer', 'general'] },
      agentId: { type: 'string' },
      timeoutMs: { type: 'number' },
      dangerously_disable_wrfc: { type: 'boolean' },
    },
  },
};

const STRING_SCHEMA: ToolDefinition = {
  name: 'read',
  description: 'Read a file.',
  parameters: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string' },
      encoding: { type: 'string' },
    },
  },
};

const NUMBER_SCHEMA: ToolDefinition = {
  name: 'wait',
  description: 'Wait for a duration.',
  parameters: {
    type: 'object',
    required: ['duration'],
    properties: {
      duration: { type: 'number' },
    },
  },
};

const BOOL_SCHEMA: ToolDefinition = {
  name: 'toggle',
  description: 'Toggle a feature.',
  parameters: {
    type: 'object',
    required: ['enabled'],
    properties: {
      enabled: { type: 'boolean' },
    },
  },
};

const ENUM_SCHEMA: ToolDefinition = {
  name: 'set_level',
  description: 'Set log level.',
  parameters: {
    type: 'object',
    required: ['level'],
    properties: {
      level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
    },
  },
};

// ---------------------------------------------------------------------------
// Rule 1: Missing `mode` on agent tool
// ---------------------------------------------------------------------------

describe('Rule 1: infer agent mode', () => {
  test('infers spawn when task is present', () => {
    const result = repairToolCall('agent', { task: 'Write a test' }, AGENT_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['mode']).toBe('spawn');
    expect(result.repairs).toHaveLength(1);
    expect(result.repairs[0]).toContain('spawn');
  });

  test('infers spawn when template is present (no task)', () => {
    const result = repairToolCall('agent', { template: 'engineer' }, AGENT_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['mode']).toBe('spawn');
  });

  test('infers spawn when both task and template are present', () => {
    const result = repairToolCall('agent', { task: 'Build it', template: 'engineer' }, AGENT_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['mode']).toBe('spawn');
  });

  test('infers status when only agentId is present', () => {
    const result = repairToolCall('agent', { agentId: 'abc-123' }, AGENT_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['mode']).toBe('status');
  });

  test('infers list for empty args object', () => {
    const result = repairToolCall('agent', {}, AGENT_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['mode']).toBe('list');
  });

  test('does not overwrite mode when already present', () => {
    const result = repairToolCall('agent', { mode: 'cancel', agentId: 'abc-123' }, AGENT_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.fixed['mode']).toBe('cancel');
  });

  test('does not infer mode for non-agent tools', () => {
    const result = repairToolCall('read', { task: 'Build it' }, STRING_SCHEMA);
    // 'task' is not in STRING_SCHEMA — no mode inference attempted
    expect(result.fixed['mode']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rule 2: Fill missing required string param from non-required param
// ---------------------------------------------------------------------------

describe('Rule 2: fill missing required string params', () => {
  test('fills missing required path from non-required encoding when names match target', () => {
    // Provide a non-required param with a path-like name
    const result = repairToolCall(
      'read',
      { pathValue: '/etc/hosts' },
      {
        name: 'read',
        description: 'Read a file.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string' },
            pathValue: { type: 'string' }, // non-required, name overlaps 'path'
          },
        },
      },
    );
    expect(result.repaired).toBe(true);
    expect(result.fixed['path']).toBe('/etc/hosts');
    expect(result.repairs[0]).toContain('pathValue');
  });

  test('does not fill missing required path from non-required string with no name overlap', () => {
    // 'encoding' has no name overlap with 'path' — generic fallback removed
    const result = repairToolCall(
      'read',
      { encoding: '/etc/hosts' },
      STRING_SCHEMA,
    );
    expect(result.repaired).toBe(false);
    expect(result.fixed['path']).toBeUndefined();
  });

  test('removes source key from fixed after copying to missing required param', () => {
    const result = repairToolCall(
      'read',
      { pathValue: '/etc/hosts' },
      {
        name: 'read',
        description: 'Read a file.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string' },
            pathValue: { type: 'string' },
          },
        },
      },
    );
    expect(result.repaired).toBe(true);
    expect(result.fixed['path']).toBe('/etc/hosts');
    // Source key must be removed to avoid dual values
    expect(result.fixed['pathValue']).toBeUndefined();
    // Original must be unchanged
    expect(result.original['pathValue']).toBe('/etc/hosts');
  });

  test('does not fill when no non-required string args present', () => {
    const result = repairToolCall('read', {}, STRING_SCHEMA);
    // No candidates available — missing path stays missing
    expect(result.fixed['path']).toBeUndefined();
    expect(result.repaired).toBe(false);
  });

  test('does not fill required param from another required param', () => {
    const schema: ToolDefinition = {
      name: 'copy',
      description: 'Copy a file.',
      parameters: {
        type: 'object',
        required: ['src', 'dst'],
        properties: {
          src: { type: 'string' },
          dst: { type: 'string' },
        },
      },
    };
    // Both required — should not fill dst from src
    const result = repairToolCall('copy', { src: '/a/b' }, schema);
    expect(result.fixed['dst']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rule 3: String → number coercion
// ---------------------------------------------------------------------------

describe('Rule 3: string-to-number coercion', () => {
  test('coerces numeric string to number', () => {
    const result = repairToolCall('wait', { duration: '30000' }, NUMBER_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['duration']).toBe(30000);
    expect(typeof result.fixed['duration']).toBe('number');
    expect(result.repairs[0]).toContain('30000');
  });

  test('coerces zero string', () => {
    const result = repairToolCall('wait', { duration: '0' }, NUMBER_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['duration']).toBe(0);
  });

  test('coerces float string', () => {
    const result = repairToolCall('wait', { duration: '1.5' }, NUMBER_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['duration']).toBe(1.5);
  });

  test('does not coerce non-numeric string', () => {
    const result = repairToolCall('wait', { duration: 'forever' }, NUMBER_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.fixed['duration']).toBe('forever');
  });

  test('leaves actual number unchanged', () => {
    const result = repairToolCall('wait', { duration: 5000 }, NUMBER_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.fixed['duration']).toBe(5000);
  });

  test('does not coerce empty string to 0', () => {
    const result = repairToolCall('wait', { duration: '' }, NUMBER_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.fixed['duration']).toBe('');
  });

  test('does not coerce whitespace-only string to 0', () => {
    const result = repairToolCall('wait', { duration: '   ' }, NUMBER_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.fixed['duration']).toBe('   ');
  });
});

// ---------------------------------------------------------------------------
// Rule 4: Boolean coercion
// ---------------------------------------------------------------------------

describe('Rule 4: boolean coercion', () => {
  test('coerces "true" to true', () => {
    const result = repairToolCall('toggle', { enabled: 'true' }, BOOL_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['enabled']).toBe(true);
  });

  test('coerces "false" to false', () => {
    const result = repairToolCall('toggle', { enabled: 'false' }, BOOL_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['enabled']).toBe(false);
  });

  test('coerces "yes" to true', () => {
    const result = repairToolCall('toggle', { enabled: 'yes' }, BOOL_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['enabled']).toBe(true);
  });

  test('coerces "no" to false', () => {
    const result = repairToolCall('toggle', { enabled: 'no' }, BOOL_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['enabled']).toBe(false);
  });

  test('coerces case-insensitive variants (TRUE, YES)', () => {
    const r1 = repairToolCall('toggle', { enabled: 'TRUE' }, BOOL_SCHEMA);
    expect(r1.fixed['enabled']).toBe(true);
    const r2 = repairToolCall('toggle', { enabled: 'YES' }, BOOL_SCHEMA);
    expect(r2.fixed['enabled']).toBe(true);
  });

  test('leaves actual boolean unchanged', () => {
    const result = repairToolCall('toggle', { enabled: true }, BOOL_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.fixed['enabled']).toBe(true);
  });

  test('leaves unrecognised string unchanged', () => {
    const result = repairToolCall('toggle', { enabled: 'maybe' }, BOOL_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.fixed['enabled']).toBe('maybe');
  });
});

// ---------------------------------------------------------------------------
// Rule 5: Enum normalization
// ---------------------------------------------------------------------------

describe('Rule 5: enum normalization', () => {
  test('normalizes wrong-case enum value', () => {
    const result = repairToolCall('set_level', { level: 'Debug' }, ENUM_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['level']).toBe('debug');
  });

  test('normalizes all-caps enum value', () => {
    const result = repairToolCall('set_level', { level: 'ERROR' }, ENUM_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['level']).toBe('error');
  });

  test('normalizes agent mode enum (Spawn -> spawn)', () => {
    const result = repairToolCall('agent', { mode: 'Spawn', task: 'Do it' }, AGENT_SCHEMA);
    expect(result.repaired).toBe(true);
    expect(result.fixed['mode']).toBe('spawn');
  });

  test('leaves exact enum value unchanged', () => {
    const result = repairToolCall('set_level', { level: 'warn' }, ENUM_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.fixed['level']).toBe('warn');
  });

  test('does not normalize completely wrong enum value', () => {
    const result = repairToolCall('set_level', { level: 'verbose' }, ENUM_SCHEMA);
    // 'verbose' not in enum, case-insensitive still no match -> unchanged
    expect(result.repaired).toBe(false);
    expect(result.fixed['level']).toBe('verbose');
  });
});

// ---------------------------------------------------------------------------
// RepairResult contract
// ---------------------------------------------------------------------------

describe('RepairResult contract', () => {
  test('original is always preserved unchanged', () => {
    const args = { duration: '5000' };
    const result = repairToolCall('wait', args, NUMBER_SCHEMA);
    expect(result.original).toEqual({ duration: '5000' });
    expect(result.fixed['duration']).toBe(5000);
  });

  test('returns repaired=false and fixed===original when nothing to fix', () => {
    const args = { duration: 5000 };
    const result = repairToolCall('wait', args, NUMBER_SCHEMA);
    expect(result.repaired).toBe(false);
    expect(result.repairs).toHaveLength(0);
    expect(result.fixed).toEqual(args);
  });

  test('repairs array lists all fixes when multiple repairs apply', () => {
    // duration: string number + agent mode missing
    const result = repairToolCall(
      'agent',
      { task: 'Do work', timeoutMs: '30000', dangerously_disable_wrfc: 'true' },
      AGENT_SCHEMA,
    );
    expect(result.repaired).toBe(true);
    // mode inferred + timeoutMs coerced + dangerously_disable_wrfc coerced
    expect(result.repairs.length).toBeGreaterThanOrEqual(2);
    expect(result.fixed['mode']).toBe('spawn');
    expect(result.fixed['timeoutMs']).toBe(30000);
    expect(result.fixed['dangerously_disable_wrfc']).toBe(true);
  });

  test('structuredClone protects nested objects from mutation', () => {
    const nested = { meta: { retries: 3 } };
    const schema: ToolDefinition = {
      name: 'task',
      description: 'Run a task.',
      parameters: {
        type: 'object',
        required: ['duration'],
        properties: {
          duration: { type: 'number' },
          config: { type: 'object' },
        },
      },
    };
    const result = repairToolCall('task', { duration: '1000', config: nested }, schema);
    // Mutate the fixed copy — original must not be affected
    (result.fixed['config'] as Record<string, unknown>)['extra'] = true;
    expect((nested as Record<string, unknown>)['extra']).toBeUndefined();
  });

  test('never throws on garbage input', () => {
    const schema: ToolDefinition = {
      name: 'bad',
      description: 'Bad schema.',
      parameters: { type: 'object' }, // no properties, no required
    };
    expect(() => repairToolCall('bad', {}, schema)).not.toThrow();
    // Also with null-ish values in args
    expect(() =>
      repairToolCall('bad', { a: null, b: undefined } as Record<string, unknown>, schema),
    ).not.toThrow();
  });
});
