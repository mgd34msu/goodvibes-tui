import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type {
  McpConfigScope,
  McpEffectiveConfig,
  McpServerConfig,
  McpServerConfigEntry,
  McpServerSecurityRecord,
  RegisteredTool,
} from '@pellux/goodvibes-sdk/platform/mcp';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { CommandContext } from './command-registry.ts';
import { requireMcpApi, requireShellPaths } from './commands/runtime-services.ts';

export const MCP_WORKSPACE_MODAL_NAME = 'mcpWorkspace';

const MCP_ROLES = ['general', 'docs', 'filesystem', 'git', 'database', 'browser', 'automation', 'ops', 'remote'] as const;
const MCP_FORM_TRUST_MODES = ['constrained', 'ask-on-risk', 'blocked'] as const;

export type McpWorkspaceMode = 'browse' | 'form' | 'delete-confirm';

export interface McpWorkspaceServerRow {
  readonly name: string;
  readonly connected: boolean;
  readonly role: string;
  readonly trustMode: string;
  readonly freshness: string;
  readonly source: 'project' | 'global' | 'external' | 'runtime';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly quarantineReason?: string;
  readonly quarantineDetail?: string;
}

export interface McpWorkspaceActionRow {
  readonly type: 'action';
  readonly id: 'add' | 'reload' | 'refresh-tools' | 'config';
  readonly label: string;
  readonly detail: string;
}

export type McpWorkspaceRow =
  | { readonly type: 'server'; readonly server: McpWorkspaceServerRow }
  | McpWorkspaceActionRow;

export interface McpWorkspaceFormField {
  readonly id: keyof McpWorkspaceForm | 'save' | 'cancel';
  readonly label: string;
  readonly value: string;
  readonly help: string;
  readonly editable: boolean;
}

export interface McpWorkspaceForm {
  scope: McpConfigScope;
  name: string;
  command: string;
  args: string;
  role: NonNullable<McpServerConfig['role']>;
  trustMode: Exclude<NonNullable<McpServerConfig['trustMode']>, 'allow-all'>;
  env: string;
  allowedPaths: string;
  allowedHosts: string;
}

interface McpWorkspaceSnapshot {
  readonly projectPath: string;
  readonly globalPath: string;
  readonly effectiveConfig: McpEffectiveConfig;
  readonly servers: readonly McpWorkspaceServerRow[];
}

function isTextField(field: keyof McpWorkspaceForm | 'save' | 'cancel'): field is 'name' | 'command' | 'args' | 'env' | 'allowedPaths' | 'allowedHosts' {
  return field === 'name' || field === 'command' || field === 'args' || field === 'env' || field === 'allowedPaths' || field === 'allowedHosts';
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseArgs(value: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (const ch of value) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += '\\';
  if (current.length > 0) args.push(current);
  return args;
}

function parseEnv(value: string): Record<string, string> | undefined {
  const entries: Array<[string, string]> = [];
  for (const raw of splitList(value)) {
    const eq = raw.indexOf('=');
    if (eq <= 0) throw new Error(`Invalid env entry "${raw}". Use KEY=VALUE.`);
    entries.push([raw.slice(0, eq).trim(), raw.slice(eq + 1)]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function serverConfigToForm(server?: McpServerConfig): McpWorkspaceForm {
  return {
    scope: 'project',
    name: server?.name ?? '',
    command: server?.command ?? '',
    args: server?.args?.join(' ') ?? '',
    role: server?.role ?? 'general',
    trustMode: server?.trustMode === 'blocked' || server?.trustMode === 'ask-on-risk' ? server.trustMode : 'constrained',
    env: server?.env ? Object.entries(server.env).map(([key, value]) => `${key}=${value}`).join(', ') : '',
    allowedPaths: server?.allowedPaths?.join(', ') ?? '',
    allowedHosts: server?.allowedHosts?.join(', ') ?? '',
  };
}

function formToServerConfig(form: McpWorkspaceForm): McpServerConfig {
  const name = form.name.trim();
  const command = form.command.trim();
  if (!name) throw new Error('Server name is required.');
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error('Server names may contain letters, numbers, dot, underscore, and dash only.');
  }
  if (!command) throw new Error('Command is required.');
  const args = parseArgs(form.args.trim());
  const env = parseEnv(form.env);
  const allowedPaths = splitList(form.allowedPaths);
  const allowedHosts = splitList(form.allowedHosts);
  return {
    name,
    command,
    ...(args.length > 0 ? { args } : {}),
    role: form.role,
    trustMode: form.trustMode,
    ...(env ? { env } : {}),
    ...(allowedPaths.length > 0 ? { allowedPaths } : {}),
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
  };
}

function nextEnumValue<T extends readonly string[]>(values: T, current: T[number], direction: 1 | -1): T[number] {
  const index = values.indexOf(current);
  const next = (index + direction + values.length) % values.length;
  return values[next]!;
}

function mergeServers(
  effectiveConfig: McpEffectiveConfig,
  runtimeServers: readonly McpServerSecurityRecord[],
): McpWorkspaceServerRow[] {
  const configByName = new Map<string, McpServerConfigEntry>();
  for (const entry of effectiveConfig.servers) configByName.set(entry.server.name, entry);
  const runtimeByName = new Map(runtimeServers.map((server) => [server.name, server]));
  const names = new Set<string>([
    ...effectiveConfig.servers.map((entry) => entry.server.name),
    ...runtimeServers.map((server) => server.name),
  ]);

  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => {
    const entry = configByName.get(name);
    const config = entry?.server;
    const runtime = runtimeByName.get(name);
    return {
      name,
      connected: runtime?.connected ?? false,
      role: runtime?.role ?? config?.role ?? 'general',
      trustMode: runtime?.trustMode ?? config?.trustMode ?? 'constrained',
      freshness: runtime?.schemaFreshness ?? 'unknown',
      source: entry?.source.scope === 'project' ? 'project' : entry?.source.scope === 'global' ? 'global' : config ? 'external' : 'runtime',
      command: config?.command,
      args: config?.args,
      allowedPaths: runtime?.allowedPaths ?? config?.allowedPaths ?? [],
      allowedHosts: runtime?.allowedHosts ?? config?.allowedHosts ?? [],
      quarantineReason: runtime?.quarantineReason,
      quarantineDetail: runtime?.quarantineDetail,
    };
  });
}

export class McpWorkspace {
  public active = false;
  public mode: McpWorkspaceMode = 'browse';
  public selectedIndex = 0;
  public formIndex = 0;
  public form: McpWorkspaceForm = serverConfigToForm();
  public editingServerName: string | null = null;
  public status = 'Ready. Add, edit, remove, reload, and inspect MCP servers without restarting the TUI.';
  public tools: readonly RegisteredTool[] = [];
  public loadingTools = false;
  public lastError: string | null = null;
  private context: CommandContext | null = null;
  private snapshot: McpWorkspaceSnapshot = {
    projectPath: '',
    globalPath: '',
    effectiveConfig: { servers: [], locations: [] },
    servers: [],
  };

  open(context: CommandContext): void {
    this.context = context;
    this.active = true;
    this.mode = 'browse';
    this.selectedIndex = 0;
    this.formIndex = 0;
    this.lastError = null;
    this.refreshSnapshot();
    void this.refreshTools();
  }

  reopen(): void {
    this.active = true;
  }

  close(): void {
    this.active = false;
    this.mode = 'browse';
  }

  get projectPath(): string {
    return this.snapshot.projectPath;
  }

  get servers(): readonly McpWorkspaceServerRow[] {
    return this.snapshot.servers;
  }

  get rows(): readonly McpWorkspaceRow[] {
    return [
      ...this.snapshot.servers.map((server): McpWorkspaceRow => ({ type: 'server', server })),
      { type: 'action', id: 'add', label: 'Add server', detail: `Write a server through the SDK config manager. Default scope: ${this.form.scope}.` },
      { type: 'action', id: 'reload', label: 'Reload runtime', detail: 'Reconnect all MCP servers from global, Claude, and project config files.' },
      { type: 'action', id: 'refresh-tools', label: 'Refresh tools', detail: 'Fetch the currently available MCP tool list from connected servers.' },
      { type: 'action', id: 'config', label: 'Config locations', detail: 'Show SDK-scanned config files and writable project/global paths.' },
    ];
  }

  get selectedRow(): McpWorkspaceRow | null {
    return this.rows[this.selectedIndex] ?? null;
  }

  get selectedServer(): McpWorkspaceServerRow | null {
    const row = this.selectedRow;
    return row?.type === 'server' ? row.server : null;
  }

  get formFields(): readonly McpWorkspaceFormField[] {
    return [
      { id: 'name', label: 'Server name', value: this.form.name, help: 'Unique MCP server id. Project config overrides matching global server names.', editable: true },
      { id: 'scope', label: 'Scope', value: this.form.scope, help: 'Cycle with Left/Right. Project writes to this workspace; global writes to your user MCP config.', editable: false },
      { id: 'command', label: 'Command', value: this.form.command, help: 'Executable to launch, for example npx, node, uvx, python, or an absolute path.', editable: true },
      { id: 'args', label: 'Arguments', value: this.form.args, help: 'Command arguments. Quotes are supported for values with spaces.', editable: true },
      { id: 'role', label: 'Role', value: this.form.role, help: `Cycle with Left/Right. Values: ${MCP_ROLES.join(', ')}.`, editable: false },
      { id: 'trustMode', label: 'Trust mode', value: this.form.trustMode, help: 'Cycle with Left/Right. allow-all is intentionally not offered here; use Settings MCP for explicit escalation.', editable: false },
      { id: 'env', label: 'Environment', value: this.form.env, help: 'Comma-separated KEY=VALUE entries. Prefer env var references or secure secrets for sensitive values.', editable: true },
      { id: 'allowedPaths', label: 'Allowed paths', value: this.form.allowedPaths, help: 'Comma-separated path prefixes for filesystem-oriented servers.', editable: true },
      { id: 'allowedHosts', label: 'Allowed hosts', value: this.form.allowedHosts, help: 'Comma-separated hostnames for network-oriented servers.', editable: true },
      { id: 'save', label: 'Save and reload', value: '', help: 'Write the selected scope config and reconnect the live MCP runtime.', editable: false },
      { id: 'cancel', label: 'Cancel', value: '', help: 'Return to the MCP server browser without changing config.', editable: false },
    ];
  }

  refreshSnapshot(): void {
    if (!this.context) return;
    const roots = requireShellPaths(this.context);
    const api = requireMcpApi(this.context);
    const effectiveConfig = api.getEffectiveConfig(roots);
    const runtimeServers = api.listServerSecurity();
    const projectPath = effectiveConfig.locations.find((location) => location.scope === 'project' && location.writable)?.path ?? `${roots.workingDirectory}/.goodvibes/mcp.json`;
    const globalPath = effectiveConfig.locations.find((location) => location.scope === 'global' && location.writable)?.path ?? `${roots.homeDirectory}/.config/mcp/mcp.json`;
    this.snapshot = {
      projectPath,
      globalPath,
      effectiveConfig,
      servers: mergeServers(effectiveConfig, runtimeServers),
    };
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.rows.length - 1));
  }

  async refreshTools(): Promise<void> {
    if (!this.context) return;
    this.loadingTools = true;
    this.lastError = null;
    try {
      const api = requireMcpApi(this.context);
      this.tools = await api.listAllTools();
      this.status = `Tool list refreshed: ${this.tools.length} tool(s) available.`;
    } catch (error) {
      this.lastError = summarizeError(error);
      this.status = `Tool refresh failed: ${this.lastError}`;
    } finally {
      this.loadingTools = false;
      this.context?.renderRequest();
    }
  }

  async reloadRuntime(): Promise<void> {
    if (!this.context) return;
    this.lastError = null;
    try {
      const api = requireMcpApi(this.context);
      const roots = requireShellPaths(this.context);
      const result = await api.reload(roots);
      this.refreshSnapshot();
      const connected = this.snapshot.servers.filter((server) => server.connected).length;
      this.status = `Reloaded MCP runtime: ${connected}/${this.snapshot.servers.length} server(s) connected. Result: +${result.added} ~${result.changed} -${result.removed}, unchanged ${result.unchanged}.`;
      void this.refreshTools();
    } catch (error) {
      this.lastError = summarizeError(error);
      this.status = `Reload failed: ${this.lastError}`;
    } finally {
      this.context?.renderRequest();
    }
  }

  openAddForm(): void {
    this.mode = 'form';
    this.formIndex = 0;
    this.editingServerName = null;
    this.form = serverConfigToForm();
    this.status = 'Add an MCP server. Choose project or global scope, then save and reload.';
  }

  openEditForm(serverName: string): void {
    const entry = this.snapshot.effectiveConfig.servers.find((configEntry) => configEntry.server.name === serverName);
    this.mode = 'form';
    this.formIndex = 0;
    this.editingServerName = serverName;
    this.form = { ...serverConfigToForm(entry?.server), scope: entry?.source.scope === 'global' ? 'global' : 'project' };
    this.status = entry
      ? `Editing ${serverName}. Saving writes a ${this.form.scope} config entry and reloads the live runtime.`
      : `Editing ${serverName}. Runtime status exists, but no launch config was found; enter command details before saving.`;
  }

  requestDelete(serverName: string): void {
    this.mode = 'delete-confirm';
    this.editingServerName = serverName;
    const entry = this.snapshot.effectiveConfig.servers.find((configEntry) => configEntry.server.name === serverName);
    const scope = entry?.source.scope === 'global' ? 'global' : 'project';
    this.status = `Remove ${scope} server "${serverName}"? Press y to confirm or n/Esc to cancel.`;
  }

  async saveForm(): Promise<void> {
    if (!this.context) return;
    try {
      const server = formToServerConfig(this.form);
      this.status = `Saving ${server.name} to ${this.form.scope} MCP config and reloading runtime...`;
      this.mode = 'browse';
      this.editingServerName = null;
      const api = requireMcpApi(this.context);
      const result = await api.upsertServerConfig(requireShellPaths(this.context), this.form.scope, server);
      this.refreshSnapshot();
      this.status = `Saved ${server.name} to ${result.path}. Reload result: +${result.reload.added} ~${result.reload.changed} -${result.reload.removed}, unchanged ${result.reload.unchanged}.`;
      void this.refreshTools();
    } catch (error) {
      this.lastError = summarizeError(error);
      this.status = `Save failed: ${this.lastError}`;
      this.context.renderRequest();
    }
  }

  async confirmDelete(): Promise<void> {
    if (!this.context || !this.editingServerName) return;
    const name = this.editingServerName;
    try {
      const server = this.snapshot.effectiveConfig.servers.find((entry) => entry.server.name === name);
      const scope = server?.source.scope === 'global' ? 'global' : 'project';
      const api = requireMcpApi(this.context);
      const result = await api.removeServerConfig(requireShellPaths(this.context), scope, name);
      this.mode = 'browse';
      this.editingServerName = null;
      this.refreshSnapshot();
      this.status = result.removed
        ? `Removed ${scope} server "${name}" from ${result.path}. Reload result: +${result.reload.added} ~${result.reload.changed} -${result.reload.removed}.`
        : `No ${scope} MCP server named "${name}" exists in ${result.path}.`;
      void this.refreshTools();
    } catch (error) {
      this.lastError = summarizeError(error);
      this.status = `Remove failed: ${this.lastError}`;
      this.context.renderRequest();
    }
  }

  cancelForm(): void {
    this.mode = 'browse';
    this.editingServerName = null;
    this.status = 'Returned to MCP server browser.';
  }

  moveSelection(delta: number): void {
    const total = this.mode === 'form' ? this.formFields.length : this.rows.length;
    if (total <= 0) return;
    if (this.mode === 'form') {
      this.formIndex = Math.max(0, Math.min(total - 1, this.formIndex + delta));
      return;
    }
    this.selectedIndex = Math.max(0, Math.min(total - 1, this.selectedIndex + delta));
  }

  async activateSelected(): Promise<void> {
    if (this.mode === 'form') {
      const field = this.formFields[this.formIndex];
      if (field?.id === 'save') await this.saveForm();
      else if (field?.id === 'cancel') this.cancelForm();
      return;
    }
    if (this.mode === 'delete-confirm') {
      await this.confirmDelete();
      return;
    }
    const row = this.selectedRow;
    if (!row) return;
    if (row.type === 'server') {
      this.openEditForm(row.server.name);
      return;
    }
    if (row.id === 'add') this.openAddForm();
    else if (row.id === 'reload') await this.reloadRuntime();
    else if (row.id === 'refresh-tools') await this.refreshTools();
    else if (row.id === 'config') {
      this.status = [
        `Project config: ${this.snapshot.projectPath}`,
        `Global config: ${this.snapshot.globalPath}`,
        `Scanned: ${this.snapshot.effectiveConfig.locations.map((location) => `${location.kind}:${location.writable ? 'writable' : 'read-only'}`).join(', ')}`,
      ].join(' ');
    }
  }

  adjustFormEnum(direction: 1 | -1): void {
    const field = this.formFields[this.formIndex];
    if (!field) return;
    if (field.id === 'role') {
      this.form.role = nextEnumValue(MCP_ROLES, this.form.role, direction);
    } else if (field.id === 'scope') {
      this.form.scope = nextEnumValue(['project', 'global'] as const, this.form.scope, direction);
    } else if (field.id === 'trustMode') {
      this.form.trustMode = nextEnumValue(MCP_FORM_TRUST_MODES, this.form.trustMode, direction);
    }
  }

  appendFormText(text: string): void {
    const field = this.formFields[this.formIndex];
    if (!field || !isTextField(field.id)) return;
    this.form[field.id] += text;
  }

  backspaceFormText(): void {
    const field = this.formFields[this.formIndex];
    if (!field || !isTextField(field.id)) return;
    this.form[field.id] = this.form[field.id].slice(0, -1);
  }
}

export function handleMcpWorkspaceToken(
  workspace: McpWorkspace,
  token: InputToken,
  handleEscape: () => void,
  requestRender: () => void,
): boolean {
  if (!workspace.active) return false;

  if (token.type === 'mouse') {
    if (token.action === 'press' && token.button === 64) workspace.moveSelection(-3);
    else if (token.action === 'press' && token.button === 65) workspace.moveSelection(3);
    else return true;
    requestRender();
    return true;
  }

  if (token.type === 'text') {
    if (workspace.mode === 'form') {
      workspace.appendFormText(token.value);
    } else if (workspace.mode === 'delete-confirm') {
      if (token.value.toLowerCase() === 'y') void workspace.confirmDelete();
      else if (token.value.toLowerCase() === 'n') workspace.cancelForm();
    } else {
      const value = token.value.toLowerCase();
      if (value === 'a') workspace.openAddForm();
      else if (value === 'e' && workspace.selectedServer) workspace.openEditForm(workspace.selectedServer.name);
      else if (value === 'd' && workspace.selectedServer) workspace.requestDelete(workspace.selectedServer.name);
      else if (value === 'r') void workspace.reloadRuntime();
      else if (value === 't') void workspace.refreshTools();
    }
    requestRender();
    return true;
  }

  if (token.type !== 'key') return true;
  if (token.logicalName === 'escape') {
    if (workspace.mode === 'form' || workspace.mode === 'delete-confirm') {
      workspace.cancelForm();
      requestRender();
    } else {
      handleEscape();
    }
    return true;
  }

  if (token.logicalName === 'up') workspace.moveSelection(token.shift ? -5 : -1);
  else if (token.logicalName === 'down') workspace.moveSelection(token.shift ? 5 : 1);
  else if (token.logicalName === 'pageup') workspace.moveSelection(-10);
  else if (token.logicalName === 'pagedown') workspace.moveSelection(10);
  else if (token.logicalName === 'enter') void workspace.activateSelected();
  else if (token.logicalName === 'backspace' || token.logicalName === 'delete') {
    if (workspace.mode === 'form') workspace.backspaceFormText();
    else if (workspace.mode === 'browse' && workspace.selectedServer) workspace.requestDelete(workspace.selectedServer.name);
  } else if (token.logicalName === 'left') {
    if (workspace.mode === 'form') workspace.adjustFormEnum(-1);
  } else if (token.logicalName === 'right') {
    if (workspace.mode === 'form') workspace.adjustFormEnum(1);
  } else if (token.logicalName === 'space') {
    if (workspace.mode === 'form') workspace.appendFormText(' ');
  } else if (token.logicalName === 'a' && workspace.mode === 'browse') {
    workspace.openAddForm();
  } else if (token.logicalName === 'd' && workspace.mode === 'browse' && workspace.selectedServer) {
    workspace.requestDelete(workspace.selectedServer.name);
  } else if (token.logicalName === 'r' && workspace.mode === 'browse') {
    void workspace.reloadRuntime();
  } else if (token.logicalName === 't' && workspace.mode === 'browse') {
    void workspace.refreshTools();
  }

  requestRender();
  return true;
}
