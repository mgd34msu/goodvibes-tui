import { describe, test, expect } from 'bun:test';
import { ToolRegistry } from '../../tools/registry.ts';
import { registerAllTools } from '../../tools/index.ts';

describe('registerAllTools', () => {
  test('registers exactly 7 tools', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    expect(registry.list()).toHaveLength(7);
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
