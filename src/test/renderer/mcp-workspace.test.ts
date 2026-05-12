import { describe, expect, test } from 'bun:test';
import { McpWorkspace } from '../../input/mcp-workspace.ts';
import { renderMcpWorkspace } from '../../renderer/mcp-workspace.ts';
import { lineToString, linesToText } from '../setup.ts';

describe('renderMcpWorkspace', () => {
  test('uses the shared fullscreen workspace frame', () => {
    const workspace = new McpWorkspace();
    workspace.active = true;
    const lines = renderMcpWorkspace(workspace, 120, 32);
    const text = linesToText(lines).join('\n');

    expect(lines).toHaveLength(32);
    expect(lines.every(line => line.length === 120)).toBe(true);
    expect(lineToString(lines[0])).toContain('MCP Workspace / Servers');
    expect(text).toContain('SERVERS');
    expect(text).toContain('ACTIONS');
    expect(text).toContain('Add server');
  });

  test('renders the add-server form inside the same workspace body', () => {
    const workspace = new McpWorkspace();
    workspace.active = true;
    workspace.openAddForm();
    const lines = renderMcpWorkspace(workspace, 140, 36);
    const text = linesToText(lines).join('\n');

    expect(lineToString(lines[0])).toContain('Edit Server');
    expect(text).toContain('MCP server form');
    expect(text).toContain('Server name');
    expect(text).toContain('Save and reload');
    expect(text).toContain('Focus server form');
  });
});
