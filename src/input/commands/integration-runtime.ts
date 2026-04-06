import { join, resolve } from 'path';
import { homedir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { pluginManager, type PluginStatus } from '../../plugins/manager.ts';
import { PLUGINS_DIR, getPluginDirectories } from '../../plugins/loader.ts';
import { GitService } from '../../git/service.ts';
import { handleReplayCommand } from '../../core/replay-command-handler.ts';
import { exportToHTML, exportToJSON, exportToMarkdownExtended, defaultExportPath } from '../../export/session-export.ts';
import { logger } from '../../utils/logger.ts';
import type { CommandRegistry } from '../command-registry.ts';
import { getPanelManager } from '../../panels/panel-manager.ts';
import {
  installEcosystemCatalogEntry,
  listInstalledEcosystemEntries,
  loadEcosystemCatalog,
  removeEcosystemCatalogEntry,
  reviewEcosystemCatalogEntry,
  searchEcosystemCatalog,
  updateInstalledEcosystemEntry,
  upsertEcosystemCatalogEntry,
  uninstallEcosystemCatalogEntry,
} from '../../runtime/ecosystem/catalog.ts';

async function enrichSemanticDiff(
  panel: InstanceType<typeof import('../../panels/diff-panel.ts').DiffPanel>,
  files: string[],
  ref: string,
  renderFn: () => void,
): Promise<void> {
  const { computeSemanticDiff, formatSemanticDiffSummary } = await import('../../renderer/semantic-diff.ts');
  const { relative: pathRelative } = await import('path');
  const repoRootProc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], { stdout: 'pipe', cwd: process.cwd() });
  await repoRootProc.exited;
  const repoRoot = (await new Response(repoRootProc.stdout).text()).trim() || process.cwd();
  await Promise.allSettled(
    files.map(async (filePath) => {
      try {
        const absPath = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath);
        const repoRelPath = filePath.startsWith('/') ? pathRelative(repoRoot, filePath) : filePath;
        const [beforeResult, afterResult] = await Promise.allSettled([
          (async () => {
            const proc = Bun.spawn(
              ['git', 'show', `${ref}:${repoRelPath}`],
              { stdout: 'pipe', stderr: 'pipe', cwd: repoRoot },
            );
            const [text, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
            if (exitCode !== 0) throw new Error(`git show failed for ${repoRelPath}`);
            return text;
          })(),
          Bun.file(absPath).text(),
        ]);
        if (beforeResult.status !== 'fulfilled' || afterResult.status !== 'fulfilled') return;
        const semanticDiff = await computeSemanticDiff(filePath, beforeResult.value, afterResult.value);
        if (!semanticDiff) return;
        const summary = formatSemanticDiffSummary(semanticDiff);
        if (summary) {
          panel.setSemanticSummary(filePath, summary);
          renderFn();
        }
      } catch {
        // best-effort only
      }
    }),
  );
}

export function registerIntegrationRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'notify',
    aliases: [],
    description: 'Manage webhook notification URLs (ntfy.sh format)',
    usage: 'add <url> | remove <url> | list | clear | test',
    argsHint: 'add|remove|list|clear|test',
    async handler(args, ctx) {
      const { WebhookNotifier, getWebhookNotifier } = await import('../../integrations/webhooks.ts');
      const notifications = ctx.configManager.getCategory('notifications');
      const urls: string[] = Array.isArray(notifications.webhookUrls) ? [...notifications.webhookUrls] : [];
      const sub = args[0];

      if (!sub || sub === 'list') {
        if (urls.length === 0) ctx.print('No webhook URLs configured.\nUse: /notify add <url>');
        else ctx.print(`Webhook URLs (${urls.length}):\n${urls.map((u, i) => `  ${i + 1}. ${u}`).join('\n')}`);
        return;
      }

      if (sub === 'add') {
        const url = args[1];
        if (!url) {
          ctx.print('Usage: /notify add <url>\nExample: /notify add https://ntfy.sh/my-topic');
          return;
        }
        try { new URL(url); } catch {
          ctx.print(`Invalid URL: ${url}`);
          return;
        }
        if (urls.includes(url)) {
          ctx.print(`Already configured: ${url}`);
          return;
        }
        urls.push(url);
        ctx.configManager.mergeCategory('notifications', { webhookUrls: urls });
        getWebhookNotifier()?.setUrls(urls);
        ctx.print(`Webhook added: ${url}`);
        return;
      }

      if (sub === 'remove') {
        const url = args[1];
        if (!url) {
          ctx.print('Usage: /notify remove <url>');
          return;
        }
        const next = urls.filter((u) => u !== url);
        if (next.length === urls.length) {
          ctx.print(`Not found: ${url}`);
          return;
        }
        ctx.configManager.mergeCategory('notifications', { webhookUrls: next });
        getWebhookNotifier()?.setUrls(next);
        ctx.print(`Webhook removed: ${url}`);
        return;
      }

      if (sub === 'clear') {
        ctx.configManager.mergeCategory('notifications', { webhookUrls: [] });
        getWebhookNotifier()?.setUrls([]);
        ctx.print('All webhook URLs cleared.');
        return;
      }

      if (sub === 'test') {
        if (urls.length === 0) {
          ctx.print('No webhook URLs configured. Use: /notify add <url>');
          return;
        }
        ctx.print(`Testing ${urls.length} webhook${urls.length !== 1 ? 's' : ''}...`);
        const notifier = getWebhookNotifier() ?? WebhookNotifier.fromConfig(urls);
        const results = await notifier.test();
        ctx.print(results.map((r) => r.ok ? `  [ok] ${r.url}` : `  [fail] ${r.url} — ${r.error ?? 'unknown error'}`).join('\n'));
        return;
      }

      ctx.print('Usage: /notify add <url> | remove <url> | list | clear | test');
    },
  });

  registry.register({
    name: 'diff',
    aliases: ['d'],
    description: 'Show unified diff of session file changes. Uses git diff HEAD if in a git repo.',
    usage: '[session|head|working|staged|<git-ref>]',
    argsHint: '[session|head|working|staged|<ref>]',
    async handler(args, ctx) {
      const { getPanelManager } = await import('../../panels/panel-manager.ts');
      const { DiffPanel } = await import('../../panels/diff-panel.ts');
      const { getChangedFiles } = await import('../../sessions/change-tracker.ts');

      const pm = getPanelManager();
      let panel = pm.getAllOpen().find(p => p.id === 'diff');
      if (!panel) {
        try {
          panel = pm.open('diff');
        } catch {
          ctx.print('Could not open diff panel.');
          return;
        }
      }
      pm.activateById('diff');
      if (!pm.isVisible()) pm.show();

      const diffPanel = panel as InstanceType<typeof DiffPanel>;
      const sub = (args[0] ?? 'session').toLowerCase();

      switch (sub) {
        case 'working': {
          ctx.print('Loading working-tree diff...');
          await diffPanel.showGitDiff();
          ctx.print('Diff panel updated: working tree changes.');
          const workingChangedFiles = await (async () => {
            const proc = Bun.spawn(['git', 'diff', '--name-only'], { stdout: 'pipe', cwd: process.cwd() });
            await proc.exited;
            return (await new Response(proc.stdout).text()).trim().split('\n').filter(Boolean);
          })();
          if (workingChangedFiles.length > 0) {
            enrichSemanticDiff(diffPanel, workingChangedFiles, 'HEAD', () => ctx.renderRequest()).catch(() => {});
          }
          break;
        }
        case 'staged': {
          ctx.print('Loading staged diff...');
          const proc = Bun.spawn(['/bin/sh', '-c', 'git diff --cached'], { stdout: 'pipe', stderr: 'pipe', cwd: process.cwd() });
          const [raw, errText] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            ctx.print(`git diff --cached failed: ${errText.trim() || 'unknown error'}`);
            return;
          }
          if (!raw.trim()) {
            ctx.print('No staged changes.');
            diffPanel.showDiff('(no staged changes)', '@@ -0,0 +0,0 @@\n No staged changes.');
          } else {
            diffPanel.loadRawDiff(raw);
            ctx.print('Diff panel updated: staged changes.');
            const stagedChangedFiles = await (async () => {
              const stagedProc = Bun.spawn(['git', 'diff', '--cached', '--name-only'], { stdout: 'pipe', cwd: process.cwd() });
              await stagedProc.exited;
              return (await new Response(stagedProc.stdout).text()).trim().split('\n').filter(Boolean);
            })();
            if (stagedChangedFiles.length > 0) {
              enrichSemanticDiff(diffPanel, stagedChangedFiles, 'HEAD', () => ctx.renderRequest()).catch(() => {});
            }
          }
          break;
        }
        case 'head': {
          ctx.print('Loading diff vs HEAD...');
          await diffPanel.showGitDiff('HEAD');
          ctx.print('Diff panel updated: all changes vs HEAD.');
          const headChangedFiles = await (async () => {
            const proc = Bun.spawn(['/bin/sh', '-c', 'git diff HEAD --name-only'], { stdout: 'pipe', cwd: process.cwd() });
            await proc.exited;
            return (await new Response(proc.stdout).text()).trim().split('\n').filter(Boolean);
          })();
          if (headChangedFiles.length > 0) {
            enrichSemanticDiff(diffPanel, headChangedFiles, 'HEAD', () => ctx.renderRequest()).catch(() => {});
          }
          break;
        }
        case 'session':
        default: {
          const sessionFiles = getChangedFiles();
          if (sessionFiles.length > 0) {
            ctx.print(`Loading session diff (${sessionFiles.length} file${sessionFiles.length === 1 ? '' : 's'} changed this session)...`);
            await diffPanel.showFileDiffs(sessionFiles, 'HEAD');
            ctx.print(`Diff panel updated: ${sessionFiles.length} session file${sessionFiles.length === 1 ? '' : 's'}.`);
            enrichSemanticDiff(diffPanel, sessionFiles, 'HEAD', () => ctx.renderRequest()).catch(() => {});
          } else {
            ctx.print('No session changes tracked yet. Showing diff vs HEAD...');
            await diffPanel.showGitDiff('HEAD');
            ctx.print('Diff panel updated: all changes vs HEAD.');
            const fallbackFiles = await (async () => {
              const proc = Bun.spawn(['/bin/sh', '-c', 'git diff HEAD --name-only'], { stdout: 'pipe', cwd: process.cwd() });
              await proc.exited;
              return (await new Response(proc.stdout).text()).trim().split('\n').filter(Boolean);
            })();
            if (fallbackFiles.length > 0) {
              enrichSemanticDiff(diffPanel, fallbackFiles, 'HEAD', () => ctx.renderRequest()).catch(() => {});
            }
          }
          break;
        }
      }

      ctx.renderRequest();
    },
  });

  registry.register({
    name: 'mcp',
    aliases: [],
    description: 'List connected MCP servers and their tools',
    usage: '[tools [<server>]]',
    argsHint: '[tools [server]]',
    async handler(args, ctx) {
      const subcommand = args[0];
      if (!subcommand && ctx.openMcpPanel) {
        ctx.openMcpPanel();
      }
      if (subcommand === 'tools') {
        const filterServer = args[1];
        ctx.print('Fetching MCP tool list...');
        let allTools;
        try {
          allTools = await ctx.mcpRegistry.listAllTools();
        } catch (e) {
          ctx.print(`Error listing tools: ${(e as Error).message}`);
          return;
        }
        const tools = filterServer ? allTools.filter(t => t.serverName === filterServer) : allTools;
        if (tools.length === 0) {
          ctx.print(filterServer
            ? `No tools found for server "${filterServer}". Is it connected? Run /mcp to see server status.`
            : 'No MCP tools available. Configure servers in .goodvibes/mcp.json or ~/.config/mcp/mcp.json.');
          return;
        }
        const lines: string[] = [`MCP Tools (${tools.length} total):`];
        let lastServer = '';
        for (const tool of tools) {
          if (tool.serverName !== lastServer) {
            lines.push(`\n  [${tool.serverName}]`);
            lastServer = tool.serverName;
          }
          lines.push(`    ${tool.toolName}${tool.description ? `  — ${tool.description}` : ''}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (subcommand === 'trust') {
        const serverName = args[1];
        const mode = args[2] as 'constrained' | 'ask-on-risk' | 'allow-all' | 'blocked' | undefined;
        if (serverName && mode) {
          if (mode === 'allow-all') {
            ctx.print(`Use /settings → MCP to explicitly enable allow-all for ${serverName}. Direct CLI escalation is blocked.`);
            ctx.openSettingsModal?.();
            return;
          }
          ctx.mcpRegistry.setServerTrustMode(serverName, mode);
          ctx.print(`Updated MCP trust mode for ${serverName} to ${mode}.`);
          return;
        }
        if (serverName || mode) {
          ctx.print('Usage: /mcp trust <server> <constrained|ask-on-risk|blocked>\nUse /settings → MCP to explicitly enable allow-all.');
          return;
        }
      }

      if (subcommand === 'role') {
        const serverName = args[1];
        const role = args[2] as 'general' | 'docs' | 'filesystem' | 'git' | 'database' | 'browser' | 'automation' | 'ops' | 'remote' | undefined;
        if (serverName && role) {
          ctx.mcpRegistry.setServerRole(serverName, role);
          ctx.print(`Updated MCP role for ${serverName} to ${role}.`);
          return;
        }
        if (serverName || role) {
          ctx.print('Usage: /mcp role <server> <general|docs|filesystem|git|database|browser|automation|ops|remote>');
          return;
        }
      }

      if (subcommand === 'quarantine') {
        const serverName = args[1];
        const action = args[2];
        if (!serverName) {
          ctx.print('Usage: /mcp quarantine <server> [detail]\n       /mcp quarantine <server> approve [operatorId]');
          return;
        }
        if (action === 'approve') {
          const operatorId = args[3] || 'operator';
          ctx.mcpRegistry.approveSchemaQuarantine(serverName, operatorId);
          ctx.print(`Approved MCP schema quarantine override for ${serverName} as ${operatorId}. Refresh is still recommended.`);
          return;
        }
        const detail = args.slice(2).join(' ') || 'quarantined by operator';
        ctx.mcpRegistry.quarantineSchema(serverName, 'operator_flagged', detail);
        ctx.print(`Quarantined MCP schema for ${serverName}.\nReason: ${detail}`);
        return;
      }

      const servers = ctx.mcpRegistry.listServerSecurity();
      if (servers.length === 0) {
        ctx.print(
          'No MCP servers configured.\n'
          + 'Add servers to one of these locations (scanned in order):\n'
          + '  ~/.config/mcp/mcp.json               (global XDG)\n'
          + '  ~/.mcp/mcp.json                      (global dotdir)\n'
          + '  ~/.config/claude/claude_desktop_config.json  (Claude Desktop)\n'
          + '  .mcp/mcp.json                        (project-local)\n'
          + '  .goodvibes/mcp.json                  (goodvibes project)\n'
          + '\nFormat: { "servers": [{ "name": "my-server", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }] }'
        );
        return;
      }

      const connected = servers.filter(s => s.connected);
      const disconnected = servers.filter(s => !s.connected);
      const lines: string[] = [`MCP Servers (${connected.length}/${servers.length} connected):`];
      for (const s of servers) {
        const pathScope = s.allowedPaths.length > 0 ? ` paths=${s.allowedPaths.length}` : '';
        const hostScope = s.allowedHosts.length > 0 ? ` hosts=${s.allowedHosts.length}` : '';
        const freshness = ` freshness=${s.schemaFreshness}`;
        const quarantine = s.schemaFreshness === 'quarantined' ? ` quarantine=${s.quarantineReason ?? 'unknown'}` : '';
        lines.push(`  ${s.connected ? '[connected]   ' : '[disconnected]'}  ${s.name}  trust=${s.trustMode}  role=${s.role}${freshness}${quarantine}${pathScope}${hostScope}`);
      }
      if (connected.length > 0) {
        lines.push('');
        lines.push('Run "/mcp tools" to list all tools, or "/mcp tools <server>" for a specific server.');
        lines.push('Run "/mcp trust <server> <mode>" to change trust mode, or "/mcp role <server> <role>" to change its coherence role.');
        lines.push('Run "/mcp quarantine <server> [detail]" to block a server, or "/mcp quarantine <server> approve [operatorId]" to approve a temporary override.');
        lines.push('Use /settings → MCP to explicitly enable allow-all for a server.');
      }
      if (disconnected.length > 0) {
        lines.push('');
        lines.push(`${disconnected.length} server(s) failed to connect. Check server command and args in your config.`);
      }
      ctx.print(lines.join('\n'));
    },
  });

  registry.register({
    name: 'share',
    aliases: [],
    description: 'Export the current session to a shareable format (html, json, md)',
    usage: '<html|json|md> [path] [--redact]',
    argsHint: '<html|json|md> [path]',
    async handler(args, ctx) {
      const FORMATS = ['html', 'json', 'md'] as const;
      type Format = typeof FORMATS[number];

      const format = args[0]?.toLowerCase() as Format | undefined;
      if (!format || !FORMATS.includes(format)) {
        ctx.print(
          'Usage: /share <html|json|md> [path] [--redact]\n'
          + '  html  — self-contained HTML with syntax highlighting\n'
          + '  json  — structured JSON (machine-readable)\n'
          + '  md    — Markdown\n\n'
          + 'Options:\n'
          + '  --redact  Redact API keys and personal paths from output\n\n'
          + 'Default path: ~/goodvibes-exports/session-<timestamp>.<ext>',
        );
        return;
      }

      const remainingArgs = args.slice(1);
      const redact = remainingArgs.includes('--redact');
      const pathArgs = remainingArgs.filter(a => a !== '--redact');
      const outputPath = pathArgs.length > 0 ? resolve(pathArgs[0].replace(/^~/, homedir())) : defaultExportPath(format);

      const convData = ctx.conversationManager.toJSON() as {
        messages: Array<{
          role: string;
          content: unknown;
          toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
          callId?: string;
          toolName?: string;
          reasoningContent?: string;
          reasoningSummary?: string;
          usage?: {
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
          };
          cancelled?: boolean;
        }>;
      };

      if (!convData.messages || convData.messages.length === 0) {
        ctx.print('Nothing to export — conversation is empty.');
        return;
      }

      type ExportMsg = import('../../export/session-export.ts').ExportMessage;
      const messages: ExportMsg[] = convData.messages.map(m => ({
        role: m.role as ExportMsg['role'],
        content: m.content as string,
        toolCalls: m.toolCalls,
        callId: m.callId,
        toolName: m.toolName,
        reasoningContent: m.reasoningContent,
        reasoningSummary: m.reasoningSummary,
        usage: m.usage,
        cancelled: m.cancelled,
      }));
      const metadata = {
        model: ctx.runtime.model,
        provider: ctx.runtime.provider,
        sessionId: ctx.runtime.sessionId,
        title: ctx.conversationManager.title || undefined,
      };
      const options = { redact };

      let outputContent: string;
      try {
        if (format === 'html') outputContent = exportToHTML(messages, metadata, options);
        else if (format === 'json') outputContent = exportToJSON(messages, metadata, options);
        else outputContent = exportToMarkdownExtended(messages, metadata, options);
      } catch (err) {
        ctx.print(`Export failed: ${(err as Error).message}`);
        return;
      }

      const { mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      try {
        mkdirSync(dirname(outputPath), { recursive: true });
      } catch (mkdirErr) {
        logger.warn(`[share] mkdir failed for ${dirname(outputPath)}:`, mkdirErr instanceof Error ? { message: mkdirErr.message } : undefined);
      }

      try {
        await writeFile(outputPath, outputContent, 'utf-8');
      } catch (err) {
        ctx.print(`Failed to write export: ${(err as Error).message}`);
        return;
      }

      ctx.print(`Exported ${format.toUpperCase()} session to ${outputPath}${redact ? ' (sensitive data redacted)' : ''}`);
    },
  });

  registry.register({
    name: 'plugin',
    aliases: [],
    description: 'Manage plugins, trust, review, and ecosystem paths',
    usage: 'list | dirs | inspect <name> | review | installed | catalog-review <id> | publish-local <id> <path> <summary...> | unpublish <id> | install <id> [project|user] | update <id> [project|user] | uninstall <id> [project|user] | enable <name> | disable <name> | reload',
    argsHint: 'list | dirs | inspect | review | installed | catalog-review | publish-local | unpublish | install | update | uninstall | enable | disable | reload',
    async handler(args, ctx) {
      const sub = args[0];

      if (!sub || sub === 'open' || sub === 'panel') {
        const panelManager = getPanelManager();
        panelManager.open('plugins');
        panelManager.show();
        ctx.renderRequest();
        return;
      }

      if (sub === 'list') {
        const plugins = pluginManager.list() as PluginStatus[];
        if (plugins.length === 0) {
          const directories = getPluginDirectories()
            .map((dir) => `  ${dir}`)
            .join('\n');
          ctx.print(
            `No plugins installed.\nPlugin search directories:\n${directories}\nPlace a plugin folder in one of those locations with manifest.json and index.ts.`
          );
          return;
        }
        const lines: string[] = ['Installed plugins:'];
        for (const p of plugins) {
          const statusIcon = p.active ? '[active]  ' : p.enabled ? '[loading] ' : '[disabled]';
          lines.push(`  ${statusIcon}  ${p.name.padEnd(24)} v${p.version}  —  ${p.description}`);
          if (p.author) lines.push(`            by ${p.author}`);
        }
        lines.push('');
        lines.push('Use /plugin enable <name> or /plugin disable <name> to toggle plugins.');
        ctx.print(lines.join('\n'));
        return;
      }
      if (sub === 'dirs') {
        const directories = getPluginDirectories();
        ctx.print([
          'Plugin Search Directories',
          ...directories.map((dir) => `  ${dir}`),
        ].join('\n'));
        return;
      }
      if (sub === 'inspect') {
        const name = args[1];
        if (!name) {
          ctx.print('Usage: /plugin inspect <name>');
          return;
        }
        const status = pluginManager.list().find((plugin) => plugin.name === name);
        if (!status) {
          ctx.print(`Error: Plugin '${name}' not found.`);
          return;
        }
        const capabilities = pluginManager.capabilities(name);
        const trust = pluginManager.getTrustRecord(name);
        const quarantine = pluginManager.getQuarantineRecord(name);
        ctx.print([
          `Plugin ${name}`,
          `  version: ${status.version}`,
          `  state: ${status.active ? 'active' : status.enabled ? 'enabled' : 'disabled'}`,
          `  trustTier: ${status.trustTier}`,
          `  quarantined: ${status.quarantined ? 'yes' : 'no'}`,
          `  requestedCapabilities: ${capabilities?.requested.length ?? 0}`,
          `  highRiskCapabilities: ${capabilities?.highRisk.length ?? 0}`,
          `  blockedCapabilities: ${capabilities?.blocked.length ?? 0}`,
          `  signedFingerprint: ${trust?.signatureFingerprint ?? 'n/a'}`,
          `  quarantineReason: ${quarantine?.reason ?? 'n/a'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'review') {
        const plugins = pluginManager.list();
        ctx.print([
          'Plugin Security Review',
          `  total: ${plugins.length}`,
          `  active: ${plugins.filter((plugin) => plugin.active).length}`,
          `  trusted: ${plugins.filter((plugin) => plugin.trustTier === 'trusted').length}`,
          `  limited: ${plugins.filter((plugin) => plugin.trustTier === 'limited').length}`,
          `  untrusted: ${plugins.filter((plugin) => plugin.trustTier === 'untrusted').length}`,
          `  quarantined: ${plugins.filter((plugin) => plugin.quarantined).length}`,
        ].join('\n'));
        return;
      }
      if (sub === 'browse' || sub === 'catalog') {
        const query = args.slice(1).join(' ');
        const entries = query
          ? searchEcosystemCatalog('plugin', query)
          : loadEcosystemCatalog('plugin');
        if (entries.length === 0) {
          ctx.print(query
            ? `No curated plugin catalog entries matched "${query}".`
            : 'No curated plugin catalog entries found. Add .goodvibes/tui/ecosystem/plugins.json to publish a local-first plugin catalog.');
          return;
        }
        ctx.print([
          `Curated Plugin Catalog (${entries.length})`,
          ...entries.map((entry) => `  ${entry.id}  ${entry.name}  [${entry.tags.join(', ') || 'untagged'}]  ${entry.summary}`),
        ].join('\n'));
        return;
      }
      if (sub === 'installed') {
        const receipts = listInstalledEcosystemEntries('plugin');
        if (receipts.length === 0) {
          ctx.print('No curated plugins installed from local catalogs yet.');
          return;
        }
        ctx.print([
          `Installed Curated Plugins (${receipts.length})`,
          ...receipts.map((receipt) => `  ${receipt.entry.id}  ${receipt.scope}  ${receipt.targetPath}`),
        ].join('\n'));
        return;
      }
      if (sub === 'catalog-review') {
        const entryId = args[1];
        if (!entryId) {
          ctx.print('Usage: /plugin catalog-review <catalog-id>');
          return;
        }
        const entry = loadEcosystemCatalog('plugin').find((candidate) => candidate.id === entryId);
        if (!entry) {
          ctx.print(`Unknown curated plugin entry: ${entryId}`);
          return;
        }
        const review = reviewEcosystemCatalogEntry(entry);
        ctx.print([
          `Plugin Catalog Review: ${entry.name}`,
          `  id: ${entry.id}`,
          `  source: ${entry.source}`,
          `  sourceKind: ${review.sourceKind}`,
          `  sourceExists: ${review.sourceExists ? 'yes' : 'no'}`,
          `  recommendedScope: ${review.recommendedScope}`,
          `  risk: ${review.riskLevel}`,
          `  trust notes: ${entry.trustNotes ?? '(none)'}`,
          `  provenance: ${entry.provenance ?? '(none)'}`,
          `  update hint: ${entry.updateHint ?? '(none)'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'install-hint') {
        const entryId = args[1];
        if (!entryId) {
          ctx.print('Usage: /plugin install-hint <catalog-id>');
          return;
        }
        const entry = loadEcosystemCatalog('plugin').find((candidate) => candidate.id === entryId);
        if (!entry) {
          ctx.print(`Unknown curated plugin entry: ${entryId}`);
          return;
        }
        ctx.print([
          `Plugin Install Guidance: ${entry.name}`,
          `  id: ${entry.id}`,
          `  source: ${entry.source}`,
          `  tags: ${entry.tags.join(', ') || '(none)'}`,
          `  trust notes: ${entry.trustNotes ?? '(none)'}`,
          `  install hint: ${entry.installHint ?? 'Place the plugin under a configured plugin search directory and use /plugin reload.'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'publish-local') {
        const entryId = args[1];
        const sourcePath = args[2];
        const summary = args.slice(3).join(' ').trim();
        if (!entryId || !sourcePath || !summary) {
          ctx.print('Usage: /plugin publish-local <catalog-id> <path> <summary...>');
          return;
        }
        const result = upsertEcosystemCatalogEntry({
          id: entryId,
          kind: 'plugin',
          name: entryId.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
          summary,
          source: sourcePath,
          tags: ['local-first', 'published'],
          provenance: 'operator-published',
          updateHint: 'Use /plugin publish-local again to refresh catalog metadata after edits.',
        });
        ctx.print(result.ok
          ? `Published curated plugin ${entryId} into ${result.path}`
          : `Error: ${result.error}`);
        return;
      }
      if (sub === 'unpublish') {
        const entryId = args[1];
        if (!entryId) {
          ctx.print('Usage: /plugin unpublish <catalog-id>');
          return;
        }
        const result = removeEcosystemCatalogEntry('plugin', entryId);
        ctx.print(result.ok
          ? `Removed curated plugin ${entryId} from ${result.path}`
          : `Error: ${result.error}`);
        return;
      }
      if (sub === 'install') {
        const entryId = args[1];
        const scopeArg = args[2];
        if (!entryId) {
          ctx.print('Usage: /plugin install <catalog-id> [project|user]');
          return;
        }
        const scope = scopeArg === 'user' ? 'user' : 'project';
        const result = installEcosystemCatalogEntry('plugin', entryId, { scope });
        ctx.print(result.ok
          ? `Installed curated plugin ${entryId} into ${result.receipt.targetPath}`
          : `Error: ${result.error}`);
        return;
      }
      if (sub === 'update') {
        const entryId = args[1];
        const scopeArg = args[2];
        if (!entryId) {
          ctx.print('Usage: /plugin update <catalog-id> [project|user]');
          return;
        }
        const scope = scopeArg === 'user' ? 'user' : 'project';
        const result = updateInstalledEcosystemEntry('plugin', entryId, { scope });
        ctx.print(result.ok
          ? `Updated curated plugin ${entryId} in ${result.receipt.targetPath}`
          : `Error: ${result.error}`);
        return;
      }
      if (sub === 'uninstall') {
        const entryId = args[1];
        const scopeArg = args[2];
        if (!entryId) {
          ctx.print('Usage: /plugin uninstall <catalog-id> [project|user]');
          return;
        }
        const scope = scopeArg === 'user' ? 'user' : 'project';
        const result = uninstallEcosystemCatalogEntry('plugin', entryId, { scope });
        ctx.print(result.ok
          ? `Uninstalled curated plugin ${entryId} from ${result.removedPath}`
          : `Error: ${result.error}`);
        return;
      }
      if (sub === 'enable') {
        const name = args[1];
        if (!name) { ctx.print('Usage: /plugin enable <name>'); return; }
        const result = await pluginManager.enable(name);
        ctx.print(result.ok ? `Plugin '${name}' enabled and activated.` : `Error: ${result.error}`);
        return;
      }
      if (sub === 'disable') {
        const name = args[1];
        if (!name) { ctx.print('Usage: /plugin disable <name>'); return; }
        const result = await pluginManager.disable(name);
        ctx.print(result.ok ? `Plugin '${name}' disabled.` : `Error: ${result.error}`);
        return;
      }
      if (sub === 'reload') {
        ctx.print('Reloading plugins...');
        const { reloaded, failed } = await pluginManager.reload();
        ctx.print(`Done. ${reloaded} plugin(s) reloaded${failed > 0 ? `, ${failed} failed` : ''}.`);
        return;
      }
      if (sub === 'trust') {
        const name = args[1];
        const rawTier = args[2];
        if (!name || !rawTier) {
          ctx.print('Usage: /plugin trust <name> <untrusted|limited|trusted> [note]');
          return;
        }
        if (rawTier !== 'untrusted' && rawTier !== 'limited' && rawTier !== 'trusted') {
          ctx.print(`Error: Invalid trust tier '${rawTier}'. Must be: untrusted, limited, or trusted.`);
          return;
        }
        const tier = rawTier as 'untrusted' | 'limited' | 'trusted';
        const note = args.slice(3).join(' ') || undefined;
        if (tier === 'trusted') {
          const sigResult = pluginManager.trustSigned(name);
          if (sigResult.ok) {
            ctx.print(`Plugin '${name}' elevated to 'trusted' via signed manifest${sigResult.fingerprint ? ` (fingerprint: ${sigResult.fingerprint})` : ''}.\nReload the plugin to apply updated capability grants.`);
            return;
          }
          ctx.print(`Warning: Signature validation failed (${sigResult.error}).\nGranting 'trusted' tier by operator override. High-risk capabilities will be available on next reload.`);
        }
        const result = pluginManager.trust(name, tier, note);
        ctx.print(result.ok
          ? `Plugin '${name}' trust tier set to '${tier}'.${tier === 'trusted' ? '\nReload the plugin to apply high-risk capability grants.' : ''}`
          : `Error: ${result.error}`);
        return;
      }
      if (sub === 'verify') {
        const name = args[1];
        if (!name) { ctx.print('Usage: /plugin verify <name>'); return; }
        const result = pluginManager.verify(name);
        if (!result.ok && result.reason?.includes('not found')) {
          ctx.print(`Error: ${result.reason}`);
          return;
        }
        ctx.print(result.valid
          ? `Plugin '${name}' manifest signature is VALID.${result.fingerprint ? `\nFingerprint: ${result.fingerprint}` : ''}`
          : `Plugin '${name}' manifest signature is INVALID.\nReason: ${result.reason ?? 'Unknown'}`);
        return;
      }
      if (sub === 'capabilities') {
        const name = args[1];
        if (!name) { ctx.print('Usage: /plugin capabilities <name>'); return; }
        const info = pluginManager.capabilities(name);
        if (!info) {
          ctx.print(`Error: Plugin '${name}' not found.`);
          return;
        }
        const lines: string[] = [`Plugin: ${name}`, `Trust tier: ${info.tier}`, '', `Requested capabilities (${info.requested.length}):`];
        if (info.requested.length === 0) lines.push('  (none)');
        else {
          for (const cap of info.requested) {
            const tag = info.blocked.includes(cap)
              ? '[BLOCKED - requires trusted tier]'
              : info.highRisk.includes(cap) ? '[high-risk, granted]' : '[safe]';
            lines.push(`  ${cap.padEnd(32)} ${tag}`);
          }
        }
        if (info.blocked.length > 0) {
          lines.push('');
          lines.push(`${info.blocked.length} high-risk capability/capabilities blocked by trust tier '${info.tier}'.`);
          lines.push(`Use /plugin trust ${name} trusted to escalate.`);
        }
        ctx.print(lines.join('\n'));
        return;
      }
      if (sub === 'quarantine') {
        const name = args[1];
        const action = args[2] ?? 'add';
        if (!name) {
          ctx.print('Usage: /plugin quarantine <name> [add|lift] [reason]');
          return;
        }
        if (action === 'lift') {
          const result = pluginManager.liftQuarantine(name);
          ctx.print(result.ok ? `Plugin '${name}' quarantine lifted. Reload to restore safe capabilities.` : `Error: ${result.error}`);
          return;
        }
        const reason = args.slice(2).join(' ') || 'quarantined by operator';
        const result = pluginManager.quarantine(name, reason);
        ctx.print(result.ok
          ? `Plugin '${name}' quarantined.\nReason: ${reason}\nHigh-risk capabilities revoked. Reload to fully apply. Use /plugin quarantine <name> lift to restore.`
          : `Error: ${result.error}`);
        return;
      }

      ctx.print(
        'Usage: /plugin <subcommand>\n'
        + '  list                       — show installed plugins and their status\n'
        + '  enable <name>              — enable a plugin\n'
        + '  disable <name>             — disable a plugin\n'
        + '  reload                     — reload all enabled plugins\n'
        + '  trust <name> <tier> [note] — set trust tier (untrusted|limited|trusted)\n'
        + '  verify <name>              — inspect a plugin manifest signature\n'
        + '  capabilities <name>        — show capability grants and blocks\n'
        + '  browse [query]             — browse curated local-first plugin catalog entries\n'
        + '  installed                  — list curated catalog installs with provenance receipts\n'
        + '  catalog-review <id>        — review source, provenance, and risk for a curated plugin\n'
        + '  publish-local <id> <path> <summary...> — publish a local plugin directory into the curated catalog\n'
        + '  unpublish <id>             — remove a local curated plugin catalog entry\n'
        + '  install-hint <catalog-id>  — show install guidance for a curated plugin entry\n'
        + '  install <catalog-id> [scope]   — install a local-path curated plugin into project|user scope\n'
        + '  uninstall <catalog-id> [scope] — remove a curated plugin install receipt and target path\n'
        + '  quarantine <name> [reason] — quarantine a plugin (revoke high-risk caps)\n'
        + '  quarantine <name> lift     — lift quarantine from a plugin'
      );
    },
  });

  registry.register({
    name: 'git',
    aliases: ['g'],
    description: 'Git repository commands — status, log, diff',
    usage: '[status|log|diff]',
    argsHint: '[status|log|diff]',
    async handler(args, ctx) {
      const sub = args[0] ?? 'status';
      const cwd = process.cwd();
      if (!GitService.isGitRepo(cwd)) {
        const initResult = GitService.initRepo(cwd);
        if (!initResult.success) {
          ctx.print(`Failed to initialise git repository: ${initResult.error ?? 'unknown error'}`);
          return;
        }
        ctx.print(`Initialized git repository in ${cwd}`);
      }

      const git = GitService.getInstance(cwd);
      switch (sub) {
        case 'status': {
          try {
            const st = await git.status();
            const lines: string[] = ['Git status:'];
            if (st.isClean()) {
              lines.push('  Working tree clean — nothing to commit.');
            } else {
              if (st.staged.length > 0) {
                lines.push(`  Staged (${st.staged.length}):`);
                for (const f of st.staged) lines.push(`    + ${f}`);
              }
              if (st.modified.length > 0) {
                lines.push(`  Modified (${st.modified.length}):`);
                for (const f of st.modified) lines.push(`    ~ ${f}`);
              }
              if (st.not_added.length > 0) {
                lines.push(`  Untracked (${st.not_added.length}):`);
                for (const f of st.not_added) lines.push(`    ? ${f}`);
              }
              if (st.deleted.length > 0) {
                lines.push(`  Deleted (${st.deleted.length}):`);
                for (const f of st.deleted) lines.push(`    - ${f}`);
              }
            }
            ctx.print(lines.join('\n'));
          } catch (e) {
            ctx.print(`Git status failed: ${(e as Error).message}`);
          }
          break;
        }
        case 'log': {
          try {
            const entries = await git.log(10);
            ctx.print([`Recent commits (${entries.length}):`, ...entries.map((entry) => `  ${entry.hash.slice(0, 7)}  ${entry.date.slice(0, 10)}  ${entry.message}`)].join('\n'));
          } catch (e) {
            ctx.print(`Git log failed: ${(e as Error).message}`);
          }
          break;
        }
        case 'diff': {
          try {
            const diffText = await git.diff();
            if (!diffText.trim()) ctx.print('No unstaged changes.');
            else ctx.print(diffText.length > 4000 ? `${diffText.slice(0, 4000)}\n\n...(diff truncated)` : diffText);
          } catch (e) {
            ctx.print(`Git diff failed: ${(e as Error).message}`);
          }
          break;
        }
        default:
          ctx.print('Usage: /git [status|log|diff]\n  /git          — working tree status (default)\n  /git status   — working tree status\n  /git log      — recent commits\n  /git diff     — unstaged changes');
      }
    },
  });

  registry.register({
    name: 'replay',
    aliases: ['rep'],
    description: 'Deterministic replay: load, step, seek, diff, and export recorded runs',
    usage: '[load [runId] | step [n] | seek <rev> | diff | export <path>]',
    argsHint: '[load|step|seek|diff|export]',
    handler(args, ctx) {
      const result = handleReplayCommand(args[0] ?? 'help', args.slice(1));
      ctx.print(result.output);
    },
  });
}
