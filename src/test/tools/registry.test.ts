import { describe, test, expect, beforeEach } from 'bun:test';
import { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import { ToolError } from '@pellux/goodvibes-sdk/platform/types';
import type { Tool, ToolDefinition } from '@pellux/goodvibes-sdk/platform/types';

function makeTool(name: string, output = 'ok'): Tool {
  return {
    definition: {
      name,
      description: `Mock tool: ${name}`,
      parameters: { type: 'object', properties: {}, required: [] },
    } as ToolDefinition,
    execute: async (_args) => ({ success: true, output }),
  };
}

function makeFailingTool(name: string, message: string): Tool {
  return {
    definition: {
      name,
      description: `Failing tool: ${name}`,
      parameters: { type: 'object', properties: {}, required: [] },
    } as ToolDefinition,
    execute: async (_args) => { throw new Error(message); },
  };
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('register', () => {
    test('registers a tool successfully', () => {
      const tool = makeTool('read');
      registry.register(tool);
      expect(registry.has('read')).toBe(true);
    });

    test('throws when registering duplicate tool name', () => {
      registry.register(makeTool('read'));
      expect(() => registry.register(makeTool('read'))).toThrow(
        "Tool 'read' is already registered"
      );
    });

    test('allows registering multiple distinct tools', () => {
      registry.register(makeTool('read'));
      registry.register(makeTool('write'));
      registry.register(makeTool('exec'));
      expect(registry.has('read')).toBe(true);
      expect(registry.has('write')).toBe(true);
      expect(registry.has('exec')).toBe(true);
    });
  });

  describe('getToolDefinitions', () => {
    test('returns empty array when no tools registered', () => {
      expect(registry.getToolDefinitions()).toEqual([]);
    });

    test('returns definitions for all registered tools', () => {
      registry.register(makeTool('tool_a'));
      registry.register(makeTool('tool_b'));
      const defs = registry.getToolDefinitions();
      expect(defs).toHaveLength(2);
      expect(defs.map((d) => d.name)).toContain('tool_a');
      expect(defs.map((d) => d.name)).toContain('tool_b');
    });

    test('definitions have required shape', () => {
      registry.register(makeTool('my_tool'));
      const [def] = registry.getToolDefinitions();
      expect(def).toHaveProperty('name', 'my_tool');
      expect(def).toHaveProperty('description');
      expect(def).toHaveProperty('parameters');
    });
  });

  describe('execute', () => {
    test('executes a registered tool and returns result with callId', async () => {
      registry.register(makeTool('read', 'file contents'));
      const result = await registry.execute('call-1', 'read', {});
      expect(result.callId).toBe('call-1');
      expect(result.success).toBe(true);
      expect(result.output).toBe('file contents');
    });

    test('returns error result for unknown tool', async () => {
      const result = await registry.execute('call-x', 'nonexistent', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown tool');
      expect(result.callId).toBe('call-x');
    });

    test('throws ToolError when tool execute throws', async () => {
      registry.register(makeFailingTool('broken_tool', 'internal failure'));
      await expect(registry.execute('call-2', 'broken_tool', {})).rejects.toBeInstanceOf(ToolError);
    });

    test('ToolError wraps original message', async () => {
      expect.assertions(2);
      registry.register(makeFailingTool('broken_tool', 'original message'));
      try {
        await registry.execute('call-3', 'broken_tool', {});
      } catch (err) {
        expect(err).toBeInstanceOf(ToolError);
        expect((err as Error).message).toContain('original message');
      }
    });
  });

  describe('list', () => {
    test('returns empty array when no tools', () => {
      expect(registry.list()).toEqual([]);
    });

    test('returns all registered tools', () => {
      registry.register(makeTool('a'));
      registry.register(makeTool('b'));
      expect(registry.list()).toHaveLength(2);
    });
  });

  describe('has', () => {
    test('returns false for unregistered tool', () => {
      expect(registry.has('nope')).toBe(false);
    });

    test('returns true after registration', () => {
      registry.register(makeTool('exists'));
      expect(registry.has('exists')).toBe(true);
    });
  });
});
