import type { McpWorkspace, McpWorkspaceRow } from '../input/mcp-workspace.ts';
import type { Line } from '../types/grid.ts';
import { wrapText } from '../utils/terminal-width.ts';
import { GLYPHS } from './ui-primitives.ts';
import {
  getFullscreenWorkspaceMetrics,
  padDisplay,
  renderFullscreenWorkspace,
  stableWindow,
  WORKSPACE_PALETTE as PALETTE,
  type WorkspaceRow,
} from './fullscreen-workspace.ts';

function statusColor(text: string): string {
  if (text.includes('failed') || text.includes('Save failed') || text.includes('Remove failed')) return PALETTE.bad;
  if (text.includes('attention') || text.includes('quarantine')) return PALETTE.warn;
  return PALETTE.muted;
}

function connectedColor(connected: boolean): string {
  return connected ? PALETTE.good : PALETTE.warn;
}

function rowLabel(row: McpWorkspaceRow): string {
  if (row.type === 'server') return `${row.server.name} (${row.server.source})`;
  return row.label;
}

function rowDetail(row: McpWorkspaceRow): string {
  if (row.type === 'server') {
    const server = row.server;
    return `${server.connected ? 'connected' : 'offline'} · ${server.role} · ${server.trustMode} · schema ${server.freshness}`;
  }
  return row.detail;
}

function buildLeftRows(workspace: McpWorkspace, height: number): WorkspaceRow[] {
  const rendered: WorkspaceRow[] = [];
  let selectedRenderedIndex = 0;
  let sawServerGroup = false;
  let sawActionGroup = false;

  workspace.rows.forEach((row, rowIndex) => {
    if (row.type === 'server' && !sawServerGroup) {
      rendered.push({ text: 'SERVERS', kind: 'group', bold: true });
      sawServerGroup = true;
    }
    if (row.type === 'action' && !sawActionGroup) {
      if (!sawServerGroup) rendered.push({ text: 'SERVERS', kind: 'group', bold: true });
      if (workspace.servers.length === 0) rendered.push({ text: '  No configured servers', kind: 'item', fg: PALETTE.dim, dim: true });
      rendered.push({ text: 'ACTIONS', kind: 'group', bold: true });
      sawActionGroup = true;
    }

    const selected = workspace.mode === 'browse' && rowIndex === workspace.selectedIndex;
    if (selected) selectedRenderedIndex = rendered.length;
    const marker = selected ? GLYPHS.navigation.selected : row.type === 'server' ? (row.server.connected ? '✓' : '•') : '+';
    rendered.push({
      text: `  ${marker} ${rowLabel(row)}`,
      selected,
      kind: 'item',
      fg: row.type === 'server' ? connectedColor(row.server.connected) : PALETTE.info,
      bold: selected || row.type === 'action',
    });
  });

  const visible = Math.max(1, height);
  const window = stableWindow(rendered.length, selectedRenderedIndex, visible);
  const rows = rendered.slice(window.start, window.end);
  if (window.start > 0 && rows.length > 0) {
    rows[0] = { text: `${GLYPHS.navigation.moreAbove} ${window.start} more row(s) above`, kind: 'more', fg: PALETTE.dim, dim: true };
  }
  if (window.end < rendered.length && rows.length > 0) {
    rows[rows.length - 1] = { text: `${GLYPHS.navigation.moreBelow} ${rendered.length - window.end} more row(s) below`, kind: 'more', fg: PALETTE.dim, dim: true };
  }
  while (rows.length < height) rows.push({ text: '', kind: 'empty' });
  return rows.slice(0, height);
}

function selectedDetailLines(workspace: McpWorkspace, width: number): WorkspaceRow[] {
  const lines: string[] = [];
  if (workspace.mode === 'form') {
    const field = workspace.formFields[workspace.formIndex];
    lines.push(
      workspace.editingServerName ? `Editing server: ${workspace.editingServerName}` : 'Adding an MCP server',
      'Write a server through the SDK MCP config manager, then reload the live runtime without restarting the TUI.',
      field ? `${field.label}: ${field.help}` : '',
      'Project scope writes to this workspace. Global scope writes to your user MCP config. External Claude/Desktop config files are shown but not edited here.',
    );
  } else if (workspace.mode === 'delete-confirm') {
    lines.push(
      `Remove configured server: ${workspace.editingServerName ?? '(unknown)'}`,
      'This removes the selected writable project/global config entry and reloads MCP runtime state.',
      'Press y to remove, n or Esc to cancel.',
    );
  } else {
    const selected = workspace.selectedRow;
    if (!selected) lines.push('No MCP rows available.');
    else if (selected.type === 'action') lines.push(selected.label, selected.detail);
    else {
      const server = selected.server;
      lines.push(
        server.name,
        `Connected: ${server.connected ? 'yes' : 'no'}    Source: ${server.source}    Schema: ${server.freshness}`,
        `Role: ${server.role}    Trust: ${server.trustMode}`,
        `Command: ${server.command ? `${server.command}${server.args?.length ? ` ${server.args.join(' ')}` : ''}` : '(runtime only; no launch config found)'}`,
        `Allowed paths: ${server.allowedPaths.length > 0 ? server.allowedPaths.join(', ') : '(none)'}`,
        `Allowed hosts: ${server.allowedHosts.length > 0 ? server.allowedHosts.join(', ') : '(none)'}`,
        ...(server.quarantineReason ? [`Quarantine: ${server.quarantineReason}${server.quarantineDetail ? ` - ${server.quarantineDetail}` : ''}`] : []),
      );
    }
  }

  lines.push('', `Status: ${workspace.status}`);
  return lines.flatMap((text, index): WorkspaceRow[] => {
    if (text === '') return [{ text: '', dim: true }];
    return wrapText(text, Math.max(1, width)).map((wrapped, wrapIndex): WorkspaceRow => ({
      text: wrapped,
      fg: index === 0 ? PALETTE.title : text.startsWith('Status:') ? statusColor(workspace.status) : PALETTE.text,
      bold: index === 0 && wrapIndex === 0,
      dim: text.length === 0,
    }));
  });
}

function buildFormRows(workspace: McpWorkspace, width: number, height: number): WorkspaceRow[] {
  const rows: WorkspaceRow[] = [];
  const fields = workspace.formFields;
  const labelWidth = Math.min(24, Math.max(14, Math.floor(width * 0.24)));
  const valueWidth = Math.max(12, width - labelWidth - 20);
  rows.push({
    text: `  ${padDisplay('Field', labelWidth)}  ${padDisplay('Value', valueWidth)}  ${padDisplay('Edit', 10)}`,
    fg: PALETTE.muted,
    bold: true,
  });

  const visible = Math.max(1, height - 2);
  const window = stableWindow(fields.length, workspace.formIndex, visible);
  if (window.start > 0) rows.push({ text: `${GLYPHS.navigation.moreAbove} ${window.start} more field(s) above`, kind: 'more', fg: PALETTE.dim, dim: true });
  for (let index = window.start; index < window.end; index += 1) {
    const field = fields[index]!;
    const selected = index === workspace.formIndex;
    const marker = selected ? GLYPHS.navigation.selected : ' ';
    const value = field.id === 'save' || field.id === 'cancel'
      ? field.help
      : field.value.length > 0 ? field.value : '(empty)';
    rows.push({
      text: `${marker} ${padDisplay(field.label, labelWidth)}  ${padDisplay(value, valueWidth)}  ${padDisplay(field.editable ? 'text' : 'cycle/action', 12)}`,
      selected,
      fg: field.id === 'save' ? PALETTE.good : field.id === 'cancel' ? PALETTE.warn : field.editable ? PALETTE.text : PALETTE.info,
      bold: selected,
    });
  }
  if (window.end < fields.length) rows.push({ text: `${GLYPHS.navigation.moreBelow} ${fields.length - window.end} more field(s) below`, kind: 'more', fg: PALETTE.dim, dim: true });
  while (rows.length < height) rows.push({ text: '', kind: 'empty' });
  return rows.slice(0, height);
}

function buildToolRows(workspace: McpWorkspace, width: number, height: number): WorkspaceRow[] {
  const server = workspace.selectedServer?.name;
  const tools = server ? workspace.tools.filter((tool) => tool.serverName === server) : workspace.tools;
  const toolWidth = Math.min(36, Math.max(18, Math.floor(width * 0.34)));
  const serverWidth = Math.min(24, Math.max(12, Math.floor(width * 0.20)));
  const descriptionWidth = Math.max(12, width - toolWidth - serverWidth - 8);
  const label = workspace.loadingTools
    ? 'Tools: loading...'
    : server
      ? `Tools for ${server}: ${tools.length}`
      : `Tools: ${tools.length}`;
  const rows: WorkspaceRow[] = [
    { text: label, fg: PALETTE.subtitle, bold: true },
    { text: `  ${padDisplay('Tool', toolWidth)}  ${padDisplay('Server', serverWidth)}  ${padDisplay('Description', descriptionWidth)}`, fg: PALETTE.muted, bold: true },
  ];

  if (tools.length === 0) {
    rows.push({
      text: workspace.loadingTools ? 'Loading tool list from connected MCP servers.' : 'No tools cached for the selected server. Press t to refresh.',
      fg: PALETTE.muted,
      dim: true,
    });
  } else {
    for (const tool of tools.slice(0, Math.max(0, height - rows.length))) {
      rows.push({
        text: `  ${padDisplay(tool.toolName, toolWidth)}  ${padDisplay(tool.serverName, serverWidth)}  ${padDisplay(tool.description ?? '', descriptionWidth)}`,
        fg: PALETTE.text,
      });
    }
  }

  while (rows.length < height) rows.push({ text: '', kind: 'empty' });
  return rows.slice(0, height);
}

function buildDeleteRows(workspace: McpWorkspace, height: number): WorkspaceRow[] {
  const rows: WorkspaceRow[] = [
    { text: `${GLYPHS.navigation.selected} Confirm remove ${workspace.editingServerName ?? '(unknown)'}`, selected: true, fg: PALETTE.bad, bold: true },
    { text: '  Cancel and return to MCP server browser', fg: PALETTE.muted },
  ];
  while (rows.length < height) rows.push({ text: '', kind: 'empty' });
  return rows.slice(0, height);
}

function buildControlRows(workspace: McpWorkspace, width: number, height: number): WorkspaceRow[] {
  if (workspace.mode === 'form') return buildFormRows(workspace, width, height);
  if (workspace.mode === 'delete-confirm') return buildDeleteRows(workspace, height);
  return buildToolRows(workspace, width, height);
}

function footerText(workspace: McpWorkspace): string {
  if (workspace.mode === 'form') return 'Focus server form · Up/Down field · Left/Right cycle · Type edit · Enter save/cancel row · Esc back';
  if (workspace.mode === 'delete-confirm') return 'Focus remove confirmation · y confirm · n/Esc cancel';
  return 'Focus MCP workspace · Up/Down choose · Enter edit/action · a add · d remove · r reload · t tools · Esc close';
}

export function renderMcpWorkspace(workspace: McpWorkspace, width: number, height: number): Line[] {
  const metrics = getFullscreenWorkspaceMetrics({ width, height });
  const connected = workspace.servers.filter((server) => server.connected).length;
  const stateLabel = workspace.mode === 'browse' ? 'Browse' : workspace.mode === 'form' ? 'Edit Server' : 'Confirm Remove';
  const mainHeader = workspace.mode === 'form'
    ? 'MCP server form'
    : workspace.mode === 'delete-confirm'
      ? 'Remove MCP server'
      : `Servers ${connected}/${workspace.servers.length} connected · Tools ${workspace.tools.length}`;

  return renderFullscreenWorkspace({
    width,
    height,
    title: 'MCP Workspace / Servers',
    stateLabel,
    leftHeader: 'Servers',
    mainHeader,
    leftRows: buildLeftRows(workspace, metrics.bodyRows),
    contextRows: selectedDetailLines(workspace, metrics.contextWidth),
    controlRows: buildControlRows(workspace, metrics.contextWidth, metrics.controlRows),
    footer: footerText(workspace),
  });
}
