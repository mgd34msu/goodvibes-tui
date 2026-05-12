import type { Line } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import type { McpWorkspace, McpWorkspaceRow } from '../input/mcp-workspace.ts';
import { getDisplayWidth, wrapText } from '../utils/terminal-width.ts';

const C = {
  border: '#64748b',
  title: '#67e8f9',
  section: '#93c5fd',
  text: '#e2e8f0',
  muted: '#94a3b8',
  dim: '#64748b',
  selectedBg: '#223049',
  panelBg: '#101720',
  detailBg: '#111827',
  good: '#22c55e',
  warn: '#f59e0b',
  bad: '#ef4444',
  info: '#38bdf8',
};

type Style = Partial<Omit<Line[number], 'char'>>;

function line(width: number, bg?: string): Line {
  const out = createEmptyLine(width);
  if (bg) {
    for (let i = 0; i < out.length; i += 1) out[i] = createStyledCell(' ', { bg });
  }
  return out;
}

function write(out: Line, x: number, maxWidth: number, text: string, style: Style = {}): void {
  let col = x;
  let used = 0;
  for (const ch of text) {
    const w = getDisplayWidth(ch);
    if (w <= 0) continue;
    if (used + w > maxWidth || col >= out.length) break;
    out[col] = createStyledCell(ch, style);
    if (w > 1 && col + 1 < out.length) out[col + 1] = createStyledCell(' ', style);
    col += w;
    used += w;
  }
}

function hline(width: number, left: string, fill: string, right: string): Line {
  const out = line(width);
  if (width <= 0) return out;
  out[0] = createStyledCell(left, { fg: C.border });
  for (let i = 1; i < width - 1; i += 1) out[i] = createStyledCell(fill, { fg: C.border });
  if (width > 1) out[width - 1] = createStyledCell(right, { fg: C.border });
  return out;
}

function content(width: number, bg = C.panelBg): Line {
  const out = line(width, bg);
  if (width > 0) out[0] = createStyledCell('|', { fg: C.border, bg });
  if (width > 1) out[width - 1] = createStyledCell('|', { fg: C.border, bg });
  return out;
}

function putVertical(out: Line, x: number, bg = C.panelBg): void {
  if (x <= 0 || x >= out.length - 1) return;
  out[x] = createStyledCell('|', { fg: C.border, bg });
}

function statusColor(text: string): string {
  if (text.includes('failed') || text.includes('Save failed') || text.includes('Remove failed')) return C.bad;
  if (text.includes('attention') || text.includes('quarantine')) return C.warn;
  return C.muted;
}

function connectedColor(connected: boolean): string {
  return connected ? C.good : C.warn;
}

function rowLabel(row: McpWorkspaceRow): string {
  if (row.type === 'server') return `${row.server.connected ? '[on] ' : '[off]'} ${row.server.name}`;
  return `+ ${row.label}`;
}

function rowDetail(row: McpWorkspaceRow): string {
  if (row.type === 'server') {
    const server = row.server;
    return `${server.role} / ${server.trustMode} / ${server.freshness} / ${server.source}`;
  }
  return row.detail;
}

function renderHeader(width: number, workspace: McpWorkspace): Line[] {
  const top = hline(width, '+', '-', '+');
  write(top, 2, Math.max(0, width - 4), ' MCP Workspace / Servers ', { fg: C.title, bold: true });
  const state = workspace.mode === 'browse' ? 'Browser' : workspace.mode === 'form' ? 'Edit Server' : 'Confirm Remove';
  write(top, Math.max(2, width - state.length - 4), state.length, state, { fg: C.section });
  return [top];
}

function renderLeftRail(workspace: McpWorkspace, width: number, height: number): Line[] {
  const rows = workspace.rows;
  const out: Line[] = [];
  const selected = workspace.selectedIndex;
  const visible = Math.max(1, height - 2);
  const start = rows.length <= visible ? 0 : Math.max(0, Math.min(selected - Math.floor(visible / 2), rows.length - visible));
  const end = Math.min(rows.length, start + visible);
  const title = line(width, C.detailBg);
  write(title, 1, width - 2, 'Servers and actions', { fg: C.section, bold: true, bg: C.detailBg });
  out.push(title);
  if (start > 0) {
    const above = line(width, C.panelBg);
    write(above, 1, width - 2, `^ ${start} item(s) above`, { fg: C.dim, bg: C.panelBg });
    out.push(above);
  }
  for (let index = start; index < end && out.length < height; index += 1) {
    const row = rows[index]!;
    const selectedRow = index === selected && workspace.mode === 'browse';
    const bg = selectedRow ? C.selectedBg : C.panelBg;
    const item = line(width, bg);
    write(item, 1, 2, selectedRow ? '>' : ' ', { fg: C.text, bg, bold: selectedRow });
    write(item, 3, width - 4, rowLabel(row), {
      fg: row.type === 'server' ? connectedColor(row.server.connected) : C.info,
      bg,
      bold: selectedRow || row.type === 'action',
    });
    out.push(item);
    if (row.type === 'server' && out.length < height) {
      const detail = line(width, bg);
      write(detail, 5, width - 6, rowDetail(row), { fg: C.muted, bg });
      out.push(detail);
    }
  }
  if (end < rows.length && out.length < height) {
    const below = line(width, C.panelBg);
    write(below, 1, width - 2, `v ${rows.length - end} item(s) below`, { fg: C.dim, bg: C.panelBg });
    out.push(below);
  }
  while (out.length < height) out.push(line(width, C.panelBg));
  return out.slice(0, height);
}

function selectedDetailLines(workspace: McpWorkspace, width: number): string[] {
  if (workspace.mode === 'form') {
    const field = workspace.formFields[workspace.formIndex];
    return [
      workspace.editingServerName ? `Editing server: ${workspace.editingServerName}` : 'Adding an MCP server',
      'This writes the selected project/global MCP config and reloads the runtime. External Claude/Desktop config files remain untouched.',
      field ? `${field.label}: ${field.help}` : '',
      'Use Up/Down to choose fields. Type to edit text fields. Left/Right cycles role and trust mode. Enter saves only on Save and reload.',
    ];
  }
  if (workspace.mode === 'delete-confirm') {
    return [
      `Remove configured server: ${workspace.editingServerName ?? '(unknown)'}`,
      'This removes the selected writable project/global config entry and reloads MCP runtime state.',
      'Press y to remove, n or Esc to cancel.',
    ];
  }
  const selected = workspace.selectedRow;
  if (!selected) return ['No MCP rows available.'];
  if (selected.type === 'action') {
    return [selected.label, selected.detail];
  }
  const server = selected.server;
  return [
    server.name,
    `Connected: ${server.connected ? 'yes' : 'no'}    Source: ${server.source}    Schema: ${server.freshness}`,
    `Role: ${server.role}    Trust: ${server.trustMode}`,
    `Command: ${server.command ? `${server.command}${server.args?.length ? ` ${server.args.join(' ')}` : ''}` : '(runtime only; no launch config found)'}`,
    `Allowed paths: ${server.allowedPaths.length > 0 ? server.allowedPaths.join(', ') : '(none)'}`,
    `Allowed hosts: ${server.allowedHosts.length > 0 ? server.allowedHosts.join(', ') : '(none)'}`,
    ...(server.quarantineReason ? [`Quarantine: ${server.quarantineReason}${server.quarantineDetail ? ` - ${server.quarantineDetail}` : ''}`] : []),
  ];
}

function renderDetails(workspace: McpWorkspace, width: number, height: number): Line[] {
  const out: Line[] = [];
  const header = line(width, C.detailBg);
  write(header, 1, width - 2, workspace.mode === 'browse' ? 'Selected MCP server' : 'MCP server form', {
    fg: C.section,
    bold: true,
    bg: C.detailBg,
  });
  out.push(header);
  const wrapped = selectedDetailLines(workspace, width - 4).flatMap((entry) => wrapText(entry, Math.max(1, width - 4)));
  for (const text of wrapped) {
    const next = line(width, C.detailBg);
    write(next, 1, width - 2, text, { fg: C.text, bg: C.detailBg });
    out.push(next);
    if (out.length >= height) break;
  }
  while (out.length < height) out.push(line(width, C.detailBg));
  return out.slice(0, height);
}

function renderForm(workspace: McpWorkspace, width: number, height: number): Line[] {
  const out: Line[] = [];
  const fields = workspace.formFields;
  const labelWidth = Math.min(22, Math.max(14, Math.floor(width * 0.24)));
  const visible = Math.max(1, height - 1);
  const start = fields.length <= visible ? 0 : Math.max(0, Math.min(workspace.formIndex - Math.floor(visible / 2), fields.length - visible));
  for (let index = start; index < fields.length && out.length < height; index += 1) {
    const field = fields[index]!;
    const selected = index === workspace.formIndex;
    const bg = selected ? C.selectedBg : C.panelBg;
    const row = line(width, bg);
    write(row, 1, 2, selected ? '>' : ' ', { fg: C.text, bg, bold: selected });
    write(row, 3, labelWidth, field.label, { fg: field.id === 'save' ? C.good : field.id === 'cancel' ? C.warn : C.muted, bg, bold: selected });
    if (field.id === 'save' || field.id === 'cancel') {
      write(row, labelWidth + 5, width - labelWidth - 6, field.help, { fg: C.muted, bg });
    } else {
      const display = field.value.length > 0 ? field.value : '(empty)';
      write(row, labelWidth + 5, width - labelWidth - 6, display, { fg: field.editable ? C.text : C.info, bg, bold: selected });
    }
    out.push(row);
  }
  while (out.length < height) out.push(line(width, C.panelBg));
  return out.slice(0, height);
}

function renderTools(workspace: McpWorkspace, width: number, height: number): Line[] {
  const out: Line[] = [];
  const server = workspace.selectedServer?.name;
  const tools = server ? workspace.tools.filter((tool) => tool.serverName === server) : workspace.tools;
  const header = line(width, C.panelBg);
  const label = workspace.loadingTools
    ? 'Tools: loading...'
    : server
      ? `Tools for ${server}: ${tools.length}`
      : `Tools: ${tools.length}`;
  write(header, 1, width - 2, label, { fg: C.section, bold: true, bg: C.panelBg });
  out.push(header);
  if (tools.length === 0) {
    const empty = line(width, C.panelBg);
    write(empty, 1, width - 2, workspace.loadingTools ? 'Loading tool list from connected MCP servers.' : 'No tools cached for the selected server. Press t to refresh.', { fg: C.muted, bg: C.panelBg });
    out.push(empty);
  } else {
    for (const tool of tools.slice(0, Math.max(0, height - 1))) {
      const row = line(width, C.panelBg);
      write(row, 1, Math.min(34, width - 2), `${tool.serverName}:${tool.toolName}`, { fg: C.info, bg: C.panelBg });
      write(row, Math.min(38, width - 2), Math.max(0, width - 40), tool.description ?? '', { fg: C.muted, bg: C.panelBg });
      out.push(row);
    }
  }
  while (out.length < height) out.push(line(width, C.panelBg));
  return out.slice(0, height);
}

function renderBody(workspace: McpWorkspace, width: number, height: number): Line[] {
  const leftWidth = Math.min(42, Math.max(28, Math.floor(width * 0.28)));
  const rightWidth = Math.max(10, width - leftWidth - 3);
  const topHeight = Math.max(8, Math.min(14, Math.floor(height * 0.34)));
  const bottomHeight = Math.max(1, height - topHeight - 1);
  const left = renderLeftRail(workspace, leftWidth, height);
  const details = renderDetails(workspace, rightWidth, topHeight);
  const bottom = workspace.mode === 'form'
    ? renderForm(workspace, rightWidth, bottomHeight)
    : renderTools(workspace, rightWidth, bottomHeight);
  const right = [...details, line(rightWidth, C.panelBg), ...bottom].slice(0, height);
  const out: Line[] = [];
  for (let i = 0; i < height; i += 1) {
    const row = content(width);
    const leftRow = left[i] ?? line(leftWidth, C.panelBg);
    const rightRow = right[i] ?? line(rightWidth, C.panelBg);
    for (let x = 0; x < leftWidth && x + 1 < row.length; x += 1) row[x + 1] = leftRow[x] ?? createStyledCell(' ');
    putVertical(row, leftWidth + 1);
    for (let x = 0; x < rightWidth && leftWidth + 3 + x < row.length - 1; x += 1) {
      row[leftWidth + 3 + x] = rightRow[x] ?? createStyledCell(' ');
    }
    out.push(row);
  }
  return out;
}

function renderFooter(width: number, workspace: McpWorkspace): Line[] {
  const status = content(width, C.detailBg);
  const statusText = workspace.lastError ? workspace.status : workspace.status;
  write(status, 2, width - 4, statusText, { fg: statusColor(statusText), bg: C.detailBg });
  const controls = content(width, C.detailBg);
  const text = workspace.mode === 'form'
    ? 'Up/Down field  Type edit  Left/Right cycle  Enter save/cancel row  Esc back'
    : workspace.mode === 'delete-confirm'
      ? 'y confirm  n/Esc cancel'
      : 'Up/Down choose  Enter edit/action  a add  e edit  d remove  r reload  t tools  Esc close';
  write(controls, 2, width - 4, text, { fg: C.muted, bg: C.detailBg });
  return [status, controls, hline(width, '+', '-', '+')];
}

export function renderMcpWorkspace(workspace: McpWorkspace, width: number, height: number): Line[] {
  const safeWidth = Math.max(40, width);
  const safeHeight = Math.max(12, height);
  const bodyHeight = Math.max(1, safeHeight - 4);
  const lines = [
    ...renderHeader(safeWidth, workspace),
    ...renderBody(workspace, safeWidth, bodyHeight),
    ...renderFooter(safeWidth, workspace),
  ];
  return lines.slice(0, safeHeight);
}
