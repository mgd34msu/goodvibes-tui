import { ServiceRegistry } from '../../config/service-registry.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { evaluateSessionMaintenance, formatSessionMaintenanceLines } from '@pellux/goodvibes-sdk/platform/runtime/session-maintenance';
import { estimateConversationTokens } from '@pellux/goodvibes-sdk/platform/core/context-compaction';
import type { CommandRegistry } from '../command-registry.ts';
import { buildSetupReviewSnapshot } from './local-setup-review.ts';
import { buildProviderAccountSnapshot } from '@pellux/goodvibes-sdk/platform/runtime/provider-accounts/registry';
import { getSettingsControlPlaneSnapshot } from '@pellux/goodvibes-sdk/platform/runtime/settings/control-plane';
import { listPersistedWorktreeMeta, summarizeWorktreeOwnership } from '@pellux/goodvibes-sdk/platform/runtime/worktree/registry';
import { checkRecoveryFile, readLastSessionPointer } from '@pellux/goodvibes-sdk/platform/runtime/session-persistence';
import {
  openCommandPanel,
  requireLocalUserAuthManager,
  requireOperatorClient,
  requireProviderApi,
  requireReadModels,
  requireSecretsManager,
  requireServiceRegistry,
  requireSubscriptionManager,
  requireSessionMemoryStore,
} from './runtime-services.ts';

function renderSandboxHealthSummary(configManager: ConfigManager): string[] {
  const backend = String(configManager.get('sandbox.vmBackend') ?? 'local');
  const imagePath = String(configManager.get('sandbox.qemuImagePath') ?? '').trim();
  const wrapperPath = String(configManager.get('sandbox.qemuExecWrapper') ?? '').trim();
  const lines = [
    `  backend: ${backend}`,
    `  qemu image: ${imagePath || '(not configured)'}`,
    `  qemu wrapper: ${wrapperPath || '(not configured)'}`,
  ];
  if (backend === 'qemu' && !imagePath) lines.push('  issue: qemu backend selected without qemuImagePath');
  if (backend === 'qemu' && !wrapperPath) lines.push('  issue: qemu backend selected without qemuExecWrapper');
  return lines;
}

export function registerHealthRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'health',
    aliases: ['doctor'],
    description: 'Health workspace for startup posture, service readiness, sandbox posture, and provider health',
    usage: '[open|review|setup|services|sandbox|provider|accounts|auth|settings|intelligence|remote|mcp|continuity|worktrees|maintenance|repair [domain]]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'review').toLowerCase();
      const readModels = requireReadModels(ctx);

      if (sub === 'open' || sub === 'panel' || sub === 'provider') {
        openCommandPanel(ctx, 'provider-health');
        return;
      }

      if (sub === 'services') {
        const registry = requireServiceRegistry(ctx);
        const all = registry.getAll();
        const keys = Object.keys(all);
        const inspections = await Promise.all(keys.map((name) => registry.inspect(name)));
        const issues = inspections
          .filter((inspection): inspection is NonNullable<typeof inspection> => inspection !== null)
          .flatMap((inspection) => {
            const findings: string[] = [];
            if (!inspection.hasPrimaryCredential) findings.push(`${inspection.config.name}: missing primary credential`);
            if (inspection.config.authType === 'basic' && !inspection.hasPasswordCredential) findings.push(`${inspection.config.name}: missing password credential`);
            if (!inspection.config.baseUrl) findings.push(`${inspection.config.name}: no baseUrl configured`);
            return findings;
          });
        ctx.print([
          'Health Review: Services',
          `  configured: ${keys.length}`,
          `  issues: ${issues.length}`,
          ...(issues.length > 0 ? issues.map((issue) => `  ${issue}`) : ['  all configured services passed readiness checks']),
        ].join('\n'));
        return;
      }

      if (sub === 'sandbox') {
        ctx.print([
          'Health Review: Sandbox',
          ...renderSandboxHealthSummary(ctx.platform.configManager),
        ].join('\n'));
        return;
      }

      if (sub === 'accounts') {
        const operatorClient = requireOperatorClient(ctx);
        const accounts = await operatorClient.providers.accountSnapshot();
        ctx.print([
          'Health Review: Accounts',
          `  providers: ${accounts.providers.length}`,
          `  configured: ${accounts.configuredCount}`,
          `  issues: ${accounts.issueCount}`,
          ...accounts.providers.flatMap((provider) => {
            const findings = [
              ...provider.issues.map((issue) => `  ${provider.providerId}: ${issue}`),
              ...(provider.fallbackRisk ? [`  ${provider.providerId}: ${provider.fallbackRisk}`] : []),
            ];
            return findings;
          }),
        ].join('\n'));
        return;
      }

      if (sub === 'auth') {
        const auth = readModels.localAuth.getSnapshot();
        ctx.print([
          'Health Review: Local Auth',
          `  users: ${auth.userCount}`,
          `  sessions: ${auth.sessionCount}`,
          `  bootstrap file: ${auth.bootstrapCredentialPresent ? 'present' : 'cleared'}`,
          ...(auth.userCount <= 1 ? ['  issue: only one local auth user configured'] : []),
          ...(auth.bootstrapCredentialPresent ? ['  issue: bootstrap credential file still present; rotate or clear it when no longer needed'] : []),
        ].join('\n'));
        return;
      }

      if (sub === 'settings') {
        const settings = readModels.settings.getSnapshot();
        const issues: string[] = [];
        if (settings.conflictCount > 0) issues.push(`${settings.conflictCount} conflicting setting import(s) need review`);
        if (settings.recentFailureCount > 0) issues.push(`${settings.recentFailureCount} recent sync/managed failure(s) recorded`);
        if (settings.hasStagedManagedBundle) issues.push('staged managed bundle is awaiting apply or rollback');
        if (settings.managedLockCount > 0) issues.push(`${settings.managedLockCount} managed lock(s) currently enforced`);
        ctx.print([
          'Health Review: Settings',
          `  available: ${settings.available ? 'yes' : 'no'}`,
          `  managed locks: ${settings.managedLockCount}`,
          `  conflicts: ${settings.conflictCount}`,
          `  recent failures: ${settings.recentFailureCount}`,
          `  staged bundle: ${settings.hasStagedManagedBundle ? 'present' : 'none'}`,
          ...(issues.length > 0 ? issues.map((issue) => `  issue: ${issue}`) : ['  no active settings-control issues detected']),
          '  next: /settingssync panel',
          '  next: /settingssync show <key>',
          '  next: /managed staged',
        ].join('\n'));
        return;
      }

      if (sub === 'intelligence') {
        const intelligence = readModels.intelligence.getSnapshot();
        const issues: string[] = [];
        if (intelligence.diagnosticsStatus !== 'ready') issues.push(`diagnostics=${intelligence.diagnosticsStatus}`);
        if (intelligence.symbolSearchStatus !== 'ready') issues.push(`symbols=${intelligence.symbolSearchStatus}`);
        if (intelligence.completionsStatus !== 'ready') issues.push(`completions=${intelligence.completionsStatus}`);
        if (intelligence.hoverStatus !== 'ready') issues.push(`hover=${intelligence.hoverStatus}`);
        ctx.print([
          'Health Review: Intelligence',
          `  diagnostics: ${intelligence.diagnosticsStatus}`,
          `  symbols: ${intelligence.symbolSearchStatus}`,
          `  completions: ${intelligence.completionsStatus}`,
          `  hover: ${intelligence.hoverStatus}`,
          `  errors: ${intelligence.errorCount}`,
          `  warnings: ${intelligence.warningCount}`,
          `  requests: ${intelligence.totalRequests}`,
          `  avg latency: ${Math.round(intelligence.avgLatencyMs)}ms`,
          ...(issues.length > 0
            ? issues.map((issue) => `  issue: ${issue}`)
            : ['  no active intelligence readiness issues detected']),
          '  next: /intelligence review',
          '  next: /setup review',
        ].join('\n'));
        return;
      }

      if (sub === 'remote') {
        const snapshot = readModels.remote.getSnapshot().supervisor;
        const issues = snapshot.sessions.flatMap((session) => {
          const lines: string[] = [];
          if (session.transportState === 'degraded' || session.transportState === 'reconnecting' || session.transportState === 'terminal_failure') {
            lines.push(`${session.runnerId}: transport=${session.transportState}`);
          }
          if (session.heartbeat.status !== 'fresh') {
            lines.push(`${session.runnerId}: heartbeat=${session.heartbeat.status}`);
          }
          if (session.lastError) {
            lines.push(`${session.runnerId}: ${session.lastError}`);
          }
          return lines;
        });
        ctx.print([
          'Health Review: Remote',
          `  sessions: ${snapshot.sessions.length}`,
          `  active connections: ${snapshot.activeConnections}`,
          `  degraded: ${snapshot.degradedConnections}`,
          ...(issues.length > 0 ? issues.map((issue) => `  issue: ${issue}`) : ['  no active remote recovery issues detected']),
          '  next: /remote supervisor',
          '  next: /remote recover <runnerId>',
        ].join('\n'));
        return;
      }

      if (sub === 'mcp') {
        const mcp = readModels.mcp.getSnapshot();
        const issues = mcp.servers.flatMap((server) => {
          const lines: string[] = [];
          if (server.status !== 'connected' && server.status !== 'configured') {
            lines.push(`${server.name}: status=${server.status}`);
          }
          if (server.schemaFreshness !== 'fresh') {
            lines.push(`${server.name}: schema=${server.schemaFreshness}`);
          }
          if (server.lastError) {
            lines.push(`${server.name}: ${server.lastError}`);
          }
          return lines;
        });
        ctx.print([
          'Health Review: MCP',
          `  servers: ${mcp.servers.length}`,
          `  connected: ${mcp.connectedServerNames.length}`,
          `  tools: ${mcp.availableToolCount}`,
          `  total calls: ${mcp.totalCalls}`,
          `  total errors: ${mcp.totalErrors}`,
          ...(issues.length > 0 ? issues.map((issue) => `  issue: ${issue}`) : ['  no active MCP lifecycle issues detected']),
          '  next: /mcp review',
          '  next: /mcp auth-review',
          '  next: /mcp repair',
        ].join('\n'));
        return;
      }

      if (sub === 'continuity') {
        const continuity = readModels.continuity.getSnapshot();
        const returnMode = String(ctx.platform.configManager.get('behavior.returnContextMode') ?? 'off');
        const issues: string[] = [];
        if (!continuity.lastSessionPointer) issues.push('no last-session pointer is recorded');
        if (continuity.recoveryFilePresent) issues.push(`recovery file present for ${continuity.sessionId || '(unknown session)'}`);
        if (returnMode === 'off') issues.push('return-context summaries are disabled');
        ctx.print([
          'Health Review: Continuity',
          `  return context mode: ${returnMode}`,
          `  last session pointer: ${continuity.lastSessionPointer ?? 'none'}`,
          `  recovery file: ${continuity.recoveryFilePresent ? 'present' : 'clear'}`,
          ...(continuity.returnContext ? [`  recovery activity: ${continuity.returnContext.activityLabel}`, `  recovery status: ${continuity.returnContext.statusLabel}`] : []),
          ...(issues.length > 0 ? issues.map((issue) => `  issue: ${issue}`) : ['  no active session continuity issues detected']),
          '  next: /session list',
          '  next: /session hotspots',
        ].join('\n'));
        return;
      }

      if (sub === 'maintenance') {
        const session = readModels.session.getSnapshot();
        const providerApi = requireProviderApi(ctx);
        const currentModel = await providerApi.getCurrentModel().catch(() => null);
        const llmMessages = typeof ctx.session.conversationManager.getMessagesForLLM === 'function'
          ? ctx.session.conversationManager.getMessagesForLLM()
          : [];
        const maintenance = evaluateSessionMaintenance({
          configManager: ctx.platform.configManager,
          currentTokens: estimateConversationTokens(llmMessages),
          contextWindow: currentModel?.contextWindow ?? 0,
          messageCount: llmMessages.length,
          sessionMemoryCount: requireSessionMemoryStore(ctx).list().length,
          session: session.session,
        });
        ctx.print([
          'Health Review: Maintenance',
          ...formatSessionMaintenanceLines(maintenance, 'guided'),
        ].join('\n'));
        return;
      }

      if (sub === 'worktrees') {
        const summary = readModels.worktrees.getSnapshot().summary;
        const issues: string[] = [];
        if (summary.discard > 0) issues.push(`${summary.discard} worktree(s) marked discard still tracked`);
        if (summary.cleanupPending > 0) issues.push(`${summary.cleanupPending} worktree(s) awaiting cleanup`);
        if ('kept' in summary && typeof (summary as { kept?: number }).kept === 'number' && (summary as { kept?: number }).kept! > 0) {
          // read-model summary may include kept in some implementations; ignored in rendering below if absent
        }
        if (summary.paused > 0) issues.push(`${summary.paused} paused worktree(s) may need resume or merge review`);
        ctx.print([
          'Health Review: Worktrees',
          `  total: ${summary.total}`,
          `  active: ${summary.active}`,
          `  paused: ${summary.paused}`,
          `  discard: ${summary.discard}`,
          `  cleanup pending: ${summary.cleanupPending}`,
          ...(issues.length > 0 ? issues.map((issue) => `  issue: ${issue}`) : ['  no active worktree lifecycle issues detected']),
          '  next: /worktree review',
          '  next: /worktree recover <session|task> <id>',
        ].join('\n'));
        return;
      }

      if (sub === 'repair') {
        const domain = (args[1] ?? 'review').toLowerCase();
        const lines = ['Health Repair'];
        if (domain === 'settings') {
          const settings = getSettingsControlPlaneSnapshot(ctx.platform.configManager);
          lines.push('  domain: settings');
          lines.push(...(
            settings.conflicts.length > 0
              ? ['  /settingssync panel', '  /settingssync show <key>', '  /managed staged']
              : ['  no active settings repair actions suggested']
          ));
          lines.push('  verify: /health settings');
        } else if (domain === 'auth') {
          const auth = requireLocalUserAuthManager(ctx).inspect();
          lines.push('  domain: auth');
          lines.push(...(
            auth.bootstrapCredentialPresent
              ? ['  /auth local review', '  /auth local rotate-password admin <password>', '  /auth local clear-bootstrap-file']
              : ['  /auth local review']
          ));
          lines.push('  verify: /health auth');
        } else if (domain === 'accounts') {
          lines.push('  domain: accounts');
          lines.push('  /accounts review');
          lines.push('  /accounts routes <provider>');
          lines.push('  /accounts repair <provider>');
          lines.push('  /auth show <provider>');
          lines.push('  verify: /health accounts');
        } else if (domain === 'services') {
          lines.push('  domain: services');
          lines.push('  /services doctor');
          lines.push('  /services auth-review');
          lines.push('  /health services');
          lines.push('  verify: /health services');
        } else if (domain === 'sandbox') {
          lines.push('  domain: sandbox');
          lines.push('  /sandbox review');
          lines.push('  /sandbox doctor');
          lines.push('  /health sandbox');
          lines.push('  verify: /health sandbox');
        } else if (domain === 'remote') {
          lines.push('  domain: remote');
          lines.push('  /remote supervisor');
          lines.push('  /remote recover <runnerId>');
          lines.push('  /remote setup');
          lines.push('  verify: /health remote');
        } else if (domain === 'mcp') {
          lines.push('  domain: mcp');
          lines.push('  /mcp review');
          lines.push('  /mcp auth-review');
          lines.push('  /mcp repair [server]');
          lines.push('  verify: /health mcp');
        } else if (domain === 'continuity') {
          lines.push('  domain: continuity');
          lines.push('  /session list');
          lines.push('  /session resume <id>');
          lines.push('  /session hotspots');
          lines.push('  verify: /health continuity');
        } else if (domain === 'maintenance') {
          lines.push('  domain: maintenance');
          lines.push('  /health maintenance');
          lines.push('  /guidance review');
          lines.push('  /compact');
          lines.push('  /panel tokens');
          lines.push('  verify: /health maintenance');
        } else if (domain === 'worktrees') {
          lines.push('  domain: worktrees');
          lines.push('  /worktree review');
          lines.push('  /worktree recover <session|task> <id>');
          lines.push('  verify: /health worktrees');
        } else if (domain === 'intelligence') {
          lines.push('  domain: intelligence');
          lines.push('  /intelligence review');
          lines.push('  /intelligence symbols <file>');
          lines.push('  /intelligence definition <file> <line> <column>');
          lines.push('  /setup review');
          lines.push('  verify: /health intelligence');
        } else {
          lines.push('  domains: settings, auth, accounts, services, sandbox, remote, mcp, continuity, maintenance, worktrees, intelligence');
          lines.push('  use: /health repair <domain>');
        }
        ctx.print(lines.join('\n'));
        return;
      }

      const session = readModels.session.getSnapshot();
      const providerApi = requireProviderApi(ctx);
      const currentModel = await providerApi.getCurrentModel().catch(() => null);
      const llmMessages = typeof ctx.session.conversationManager.getMessagesForLLM === 'function'
        ? ctx.session.conversationManager.getMessagesForLLM()
        : [];
      const contextWindow = currentModel?.contextWindow ?? 0;
      const maintenance = evaluateSessionMaintenance({
        configManager: ctx.platform.configManager,
        currentTokens: estimateConversationTokens(llmMessages),
        contextWindow,
        messageCount: llmMessages.length,
        sessionMemoryCount: requireSessionMemoryStore(ctx).list().length,
        session: session.session,
      });

      const snapshot = await buildSetupReviewSnapshot(ctx);
      const operatorClient = requireOperatorClient(ctx);
      const accountSnapshot = await operatorClient.providers.accountSnapshot();
      const settingsSnapshot = getSettingsControlPlaneSnapshot(ctx.platform.configManager);
      if (sub === 'setup') {
        ctx.print([
          'Health Review: Setup',
          ...snapshot.issues.map((issue) => `  [${issue.severity.toUpperCase()}] ${issue.area}: ${issue.message}`),
          ...(snapshot.serviceIssues.length > 0
            ? ['', '  Service issues:', ...snapshot.serviceIssues.map((issue) => `    - ${issue}`)]
            : []),
        ].join('\n'));
        return;
      }

      ctx.print([
        'Health Review',
        `  session: ${snapshot.sessionId}`,
        `  setup issues: ${snapshot.issues.length}`,
        `  service issues: ${snapshot.serviceIssues.length}`,
        `  active subscriptions: ${snapshot.activeSubscriptionCount}`,
        `  account issues: ${accountSnapshot.issueCount}`,
        `  settings conflicts: ${settingsSnapshot.conflicts.length}`,
        `  managed locks: ${settingsSnapshot.managedLockCount}`,
        `  local auth users: ${readModels.localAuth.getSnapshot().userCount}`,
        `  remote runners: ${snapshot.remoteRunnerCount}`,
        ...renderSandboxHealthSummary(ctx.platform.configManager),
        '',
        ...formatSessionMaintenanceLines(maintenance, 'guided').map((line) => `  ${line}`),
        ...(snapshot.issues.length > 0 ? ['', ...snapshot.issues.map((issue) => `  [${issue.severity.toUpperCase()}] ${issue.area}: ${issue.message}`)] : []),
        ...(snapshot.serviceIssues.length > 0 ? ['', ...snapshot.serviceIssues.map((issue) => `  service: ${issue}`)] : []),
        '',
        'Next steps:',
        '  /health open',
        '  /health services',
        '  /health sandbox',
        '  /health accounts',
        '  /health auth',
        '  /health settings',
        '  /health intelligence',
        '  /health remote',
        '  /health maintenance',
        '  /health worktrees',
        '  /health repair <domain>',
        '  /setup onboarding',
      ].join('\n'));
    },
  });
}
