import { describe, test, expect } from 'bun:test';
import { ToolRegistry } from '../../tools/registry.ts';
import { registerAllTools } from '../../tools/index.ts';

describe('registerAllTools', () => {
  test('registers exactly 21 tools', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    expect(registry.list()).toHaveLength(21);
  });

  test('registers a tool named "read"', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    expect(registry.has('read')).toBe(true);
  });

  test('registers a tool named "write"', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    expect(registry.has('write')).toBe(true);
  });

  test('registers a tool named "edit"', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    expect(registry.has('edit')).toBe(true);
  });

  test('registers a tool named "find"', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    expect(registry.has('find')).toBe(true);
  });

  test('registers a tool named "exec"', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    expect(registry.has('exec')).toBe(true);
  });

  test('registers a tool named "analyze"', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    expect(registry.has('analyze')).toBe(true);
  });

  test('registers a tool named "inspect"', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    expect(registry.has('inspect')).toBe(true);
  });

  test('registers a tool named "agent"', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    expect(registry.has('agent')).toBe(true);
  });

  test('registers a tool named "state"', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    expect(registry.has('state')).toBe(true);
  });

  test('registers a tool named "workflow"', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    expect(registry.has('workflow')).toBe(true);
  });

  test('registers a tool named "fetch"', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    expect(registry.has('fetch')).toBe(true);
  });

  test('registers a tool named "registry"', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    expect(registry.has('registry')).toBe(true);
  });

  test('registers breadth tools for control, task, team, worklist, mcp, query, packet, remote, and repl', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    for (const name of ['control', 'task', 'team', 'worklist', 'mcp', 'query', 'packet', 'remote', 'repl']) {
      expect(registry.has(name)).toBe(true);
    }
    expect(registry.has('powershell')).toBe(false);
  });

  test('each tool has a definition with name and description', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    for (const tool of registry.list()) {
      expect(typeof tool.definition.name).toBe('string');
      expect(tool.definition.name.length).toBeGreaterThan(0);
      expect(typeof tool.definition.description).toBe('string');
      expect(tool.definition.description.length).toBeGreaterThan(0);
      expect(typeof tool.definition.parameters).toBe('object');
    }
  });

  test('each tool has an execute function', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    for (const tool of registry.list()) {
      expect(typeof tool.execute).toBe('function');
    }
  });
});
