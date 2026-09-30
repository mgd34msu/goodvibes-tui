/**
 * renderMcpWorkspace, the MCP server workspace as a kit modal with a list and a detail side:
 * the server and action list on the left (✦ servers / actions groups, a ● or
 * ○ connection marker, the selected row as the gradient) and the selected
 * row's details in an element inset on the right (connection, trust, launch
 * command, allowed paths and hosts, quarantine, the server's tools, and the
 * status line). The add/edit form and the remove confirmation are sub-views
 * of the same modal: Esc returns from them to the browser.
 */

import type { McpWorkspace, McpWorkspaceRow } from '../input/mcp-workspace.ts';
import { activeTokens } from './theme.ts';
import {
  beginModal,
  finishModal,
  searchRow,
  scrollCountText,
  type KitHint,
  type ModalFrame,
  type SurfaceLayer,
} from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';
import { inset } from './surface-kit-parts.ts';
import { drawTextBlock, splitListDetail, textBlockHeight, type TextLine } from './surface-kit-extra.ts';

function statusColor(text: string): string {
  const t = activeTokens();
  if (text.includes('failed')) return t.error;
  if (text.includes('attention') || text.includes('quarantine')) return t.warning;
  return t.textMuted;
}

function browseRows(workspace: McpWorkspace): KitRow[] {
  const t = activeTokens();
  const rows: KitRow[] = [];
  const visible = workspace.visibleRows;
  const servers = visible.filter((row) => row.type === 'server');
  rows.push({ header: 'Servers', headerRight: `${workspace.servers.filter((s) => s.connected).length}/${workspace.servers.length} connected` });
  if (servers.length === 0) {
    rows.push({ label: workspace.servers.length === 0 ? 'No configured servers' : 'No servers match', muted: true });
  }
  let sawAction = false;
  visible.forEach((row: McpWorkspaceRow, index) => {
    const selected = workspace.mode === 'browse' && index === workspace.selectedIndex;
    if (row.type === 'server') {
      rows.push({
        label: row.server.name,
        desc: row.server.source,
        mark: row.server.connected ? '●' : '○',
        markFg: row.server.connected ? t.success : t.warning,
        right: row.server.quarantineReason ? 'quarantined' : row.server.connected ? '' : 'offline',
        rightFg: row.server.quarantineReason ? t.error : t.textFaint,
        selected,
      });
      return;
    }
    if (!sawAction) {
      rows.push({ header: 'Actions' });
      sawAction = true;
    }
    rows.push({ label: row.label, mark: '+', markFg: t.info, selected });
  });
  return rows;
}

function detailLines(workspace: McpWorkspace): TextLine[] {
  const t = activeTokens();
  const title = (text: string): TextLine => ({ text, style: { fg: t.text, bold: true } });
  const body = (text: string): TextLine => ({ text, style: { fg: t.textMuted } });
  const lines: TextLine[] = [];
  const selected = workspace.selectedRow;
  if (!selected) {
    lines.push(body(workspace.query ? `No rows match "${workspace.query}".` : 'No MCP rows available.'));
  } else if (selected.type === 'action') {
    lines.push(title(selected.label), body(selected.detail));
  } else {
    const server = selected.server;
    lines.push(
      title(server.name),
      { text: `${server.connected ? 'connected' : 'offline'} · ${server.source} · schema ${server.freshness}`, style: { fg: server.connected ? t.success : t.warning } },
      { text: '' },
      body(`Role ${server.role} · trust ${server.trustMode}`),
      body(`Command ${server.command ? `${server.command}${server.args?.length ? ` ${server.args.join(' ')}` : ''}` : '(runtime only; no launch config found)'}`),
      body(`Allowed paths ${server.allowedPaths.length > 0 ? server.allowedPaths.join(', ') : '(none)'}`),
      body(`Allowed hosts ${server.allowedHosts.length > 0 ? server.allowedHosts.join(', ') : '(none)'}`),
    );
    if (server.quarantineReason) {
      lines.push({ text: `Quarantine: ${server.quarantineReason}${server.quarantineDetail ? ` - ${server.quarantineDetail}` : ''}`, style: { fg: t.error } });
    }
  }
  lines.push({ text: '' });
  const server = workspace.selectedServer?.name;
  const tools = server ? workspace.tools.filter((tool) => tool.serverName === server) : workspace.tools;
  lines.push(title(workspace.loadingTools ? 'Tools: loading' : server ? `Tools for ${server}: ${tools.length}` : `Tools: ${tools.length}`));
  if (tools.length === 0) {
    lines.push(body(workspace.loadingTools ? 'Loading the tool list from connected MCP servers.' : 'No tools cached for the selected server. Press t to refresh.'));
  } else {
    for (const tool of tools) {
      lines.push({ text: `${tool.toolName}${server ? '' : ` (${tool.serverName})`}${tool.description ? `  ${tool.description}` : ''}`, style: { fg: t.textMuted } });
    }
  }
  return lines;
}

function formRows(workspace: McpWorkspace): KitRow[] {
  const t = activeTokens();
  return workspace.formFields.map((field, index) => {
    const selected = index === workspace.formIndex;
    const isAction = field.id === 'save' || field.id === 'cancel';
    const value = isAction ? undefined : field.value.length > 0 ? field.value : '(empty)';
    return {
      label: field.label,
      desc: value !== undefined && selected && field.editable ? `${field.value}▏` : value,
      right: !isAction && !field.editable ? '←→' : undefined,
      labelFg: field.id === 'save' ? t.success : field.id === 'cancel' ? t.warning : undefined,
      bold: isAction,
      selected,
    };
  });
}

function formLines(workspace: McpWorkspace): TextLine[] {
  const t = activeTokens();
  const field = workspace.formFields[workspace.formIndex];
  // The selected field's help leads: it is what the user needs right now.
  return [
    ...(field ? [{ text: field.label, style: { fg: t.text, bold: true } }, { text: field.help, style: { fg: t.textMuted } }, { text: '' }] : []),
    { text: workspace.editingServerName ? `Editing server: ${workspace.editingServerName}` : 'Adding an MCP server', style: { fg: t.text, bold: true } },
    { text: 'Writes a server through the SDK MCP config manager, then reloads the live runtime without restarting the TUI.', style: { fg: t.textMuted } },
    { text: '' },
    { text: 'Project scope writes to this workspace. Global scope writes to your user MCP config. External Claude/Desktop config files are shown but not edited here.', style: { fg: t.textFaint } },
  ];
}

function hintsFor(workspace: McpWorkspace): KitHint[] {
  if (workspace.mode === 'form') return [['↑↓', 'field'], ['←→', 'cycle'], ['type', 'edit'], ['⏎', 'save or cancel row'], ['esc', 'back']];
  if (workspace.mode === 'delete-confirm') return [['y', 'remove'], ['n', 'cancel'], ['esc', 'back']];
  return [['↑↓', 'move'], ['⏎', 'edit or run'], ['a', 'add'], ['d', 'remove'], ['r', 'reload'], ['t', 'tools']];
}

function drawDetailInset(f: ModalFrame, split: ReturnType<typeof splitListDetail>, lines: readonly TextLine[]): void {
  const t = activeTokens();
  const p = inset(f.canvas, split.detailX, split.detailY, split.detailW, split.detailH);
  const width = p.r - p.l + 1;
  const need = textBlockHeight(lines, width);
  const room = p.bottom - p.top + 1;
  if (need <= room) {
    drawTextBlock(f.canvas, p.l, p.top, width, lines, p.bottom);
    return;
  }
  // Keep the last inset row for an honest count of what did not fit.
  drawTextBlock(f.canvas, p.l, p.top, width, lines, p.bottom - 1);
  f.canvas.put(p.l, p.bottom, `${need - room + 1} more lines`, { fg: t.textFaint });
}

export function renderMcpWorkspace(workspace: McpWorkspace, screenWidth: number, screenHeight: number): SurfaceLayer {
  const t = activeTokens();
  const crumbs = workspace.mode === 'form'
    ? [workspace.editingServerName ? 'Edit server' : 'Add server']
    : workspace.mode === 'delete-confirm' ? ['Remove server'] : [];
  const f = beginModal(screenWidth, screenHeight, { title: 'MCP servers', crumbs, hints: hintsFor(workspace) });

  // Status sits under both sides, wrapped in full.
  const status: TextLine[] = [{ text: `Status: ${workspace.status}`, style: { fg: statusColor(workspace.status) } }];
  const statusRows = textBlockHeight(status, f.r - f.l + 1);
  const bodyBottom = f.bottom - statusRows - 1;
  drawTextBlock(f.canvas, f.l, bodyBottom + 2, f.r - f.l + 1, status, f.bottom);

  let top = f.top;
  if (workspace.mode === 'browse') {
    const total = workspace.rows.length;
    searchRow(f, top, workspace.query, 'Filter servers and actions', workspace.query ? `${workspace.visibleRows.length} of ${total}` : `${workspace.tools.length} tools`);
    top += 2;
  }

  if (workspace.mode === 'delete-confirm') {
    const split = splitListDetail(f.l, f.r, top, bodyBottom, 0.45, 3);
    drawList(f.canvas, {
      rows: [
        { label: `Remove ${workspace.editingServerName ?? '(unknown)'}`, danger: true, selected: true, mark: '✕', markFg: t.error, right: 'y' },
        { label: 'Cancel and return to the server browser', right: 'n' },
      ],
      top: split.top, bottom: split.bottom, x0: split.x0, x1: split.x1,
    });
    drawDetailInset(f, split, [
      { text: `Remove configured server: ${workspace.editingServerName ?? '(unknown)'}`, style: { fg: t.text, bold: true } },
      { text: 'This removes the selected writable project or global config entry and reloads the MCP runtime.', style: { fg: t.textMuted } },
      { text: '' },
      { text: 'Press y to remove, n or Esc to cancel.', style: { fg: t.warning } },
    ]);
    return finishModal(f);
  }

  const rows = workspace.mode === 'form' ? formRows(workspace) : browseRows(workspace);
  const split = splitListDetail(f.l, f.r, top, bodyBottom, 0.45);
  const res = drawList(f.canvas, { rows, top: split.top, bottom: split.bottom, x0: split.x0, x1: split.x1 });
  f.hintRight = scrollCountText(res.above, res.below);
  drawDetailInset(f, split, workspace.mode === 'form' ? formLines(workspace) : detailLines(workspace));
  return finishModal(f);
}
