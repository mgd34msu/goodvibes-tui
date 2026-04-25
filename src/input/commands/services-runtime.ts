import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CommandRegistry } from '../command-registry.ts';
import type { SelectionAction, SelectionItem } from '../selection-modal.ts';
import { openCommandPanel, requireServiceRegistry, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

export function registerServicesRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'services',
    aliases: ['svc'],
    description: 'Manage API service configurations',
    usage: '[open|list|inspect <name>|test <name>|resolve <name>|auth <name>|auth-review|doctor|export <path>|import <path>]',
    async handler(args, ctx) {
      const sub = args[0] ?? 'open';
      const shellPaths = requireShellPaths(ctx);
      if (sub === 'open' || sub === 'panel') {
        openCommandPanel(ctx, 'services');
        return;
      }
      const svcRegistry = requireServiceRegistry(ctx);
      const all = svcRegistry.getAll();
      const keys = Object.keys(all);
      if (sub === 'inspect') {
        const name = args[1];
        if (!name) {
          ctx.print('Usage: /services inspect <name>');
          return;
        }
        const inspection = await svcRegistry.inspect(name);
        if (!inspection) {
          ctx.print(`Unknown service: ${name}`);
          return;
        }
        ctx.print([
          `Service ${name}`,
          `  authType: ${inspection.config.authType}`,
          `  baseUrl: ${inspection.config.baseUrl ?? '(none)'}`,
          `  primaryCredential: ${inspection.hasPrimaryCredential ? 'present' : 'missing'}`,
          `  passwordCredential: ${inspection.hasPasswordCredential ? 'present' : 'missing'}`,
          `  webhookUrl: ${inspection.hasWebhookUrl ? 'present' : 'missing'}`,
          `  signingSecret: ${inspection.hasSigningSecret ? 'present' : 'missing'}`,
          `  publicKey: ${inspection.hasPublicKey ? 'present' : 'missing'}`,
          `  appToken: ${inspection.hasAppToken ? 'present' : 'missing'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'test') {
        const name = args[1];
        if (!name) {
          ctx.print('Usage: /services test <name>');
          return;
        }
        const result = await svcRegistry.testConnection(name);
        ctx.print([
          `Service test ${name}`,
          `  ok: ${result.ok ? 'yes' : 'no'}`,
          `  status: ${result.status ?? 'n/a'}`,
          `  url: ${result.testedUrl ?? 'n/a'}`,
          `  error: ${result.error ?? 'none'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'resolve') {
        const name = args[1];
        if (!name) {
          ctx.print('Usage: /services resolve <name>');
          return;
        }
        const headers = await svcRegistry.resolveAuth(name);
        if (!headers) {
          ctx.print(`Service ${name} has no resolvable auth headers right now.`);
          return;
        }
        ctx.print([
          `Resolved auth headers for ${name}`,
          ...Object.keys(headers).map((key) => `  ${key}: <redacted>`),
        ].join('\n'));
        return;
      }
      if (sub === 'auth') {
        const name = args[1];
        if (!name) {
          ctx.print('Usage: /services auth <name>');
          return;
        }
        const headers = await svcRegistry.resolveAuth(name);
        if (!headers) {
          ctx.print(`Service ${name} has no resolvable auth headers right now.`);
          return;
        }
        ctx.print([
          `Service auth ${name}`,
          ...Object.keys(headers).map((key) => `  ${key}: <resolved>`),
        ].join('\n'));
        return;
      }
      if (sub === 'doctor') {
        const inspections = await Promise.all(keys.map((name) => svcRegistry.inspect(name)));
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
          'Service Doctor',
          `  configured: ${keys.length}`,
          `  issues: ${issues.length}`,
          ...(issues.length > 0 ? issues.map((issue) => `  ${issue}`) : ['  all configured services passed readiness checks']),
        ].join('\n'));
        return;
      }
      if (sub === 'auth-review') {
        const inspections = await Promise.all(keys.map((name) => svcRegistry.inspect(name)));
        const authCounts = new Map<string, number>();
        const issues = inspections
          .filter((inspection): inspection is NonNullable<typeof inspection> => inspection !== null)
          .flatMap((inspection) => {
            authCounts.set(inspection.config.authType, (authCounts.get(inspection.config.authType) ?? 0) + 1);
            const findings: string[] = [];
            if (!inspection.config.baseUrl) findings.push(`${inspection.config.name}: missing baseUrl`);
            if ((inspection.config.authType === 'bearer' || inspection.config.authType === 'api-key') && !inspection.hasPrimaryCredential) {
              findings.push(`${inspection.config.name}: missing primary credential`);
            }
            if (inspection.config.authType === 'basic' && !inspection.hasPasswordCredential) {
              findings.push(`${inspection.config.name}: missing password credential`);
            }
            return findings;
          });
        ctx.print([
          'Service Auth Review',
          `  configured: ${keys.length}`,
          ...[...authCounts.entries()].map(([authType, count]) => `  ${authType}: ${count}`),
          ...(issues.length > 0 ? ['', ...issues.map((issue) => `  issue: ${issue}`)] : ['', '  all configured services have a complete auth posture']),
        ].join('\n'));
        return;
      }
      if (sub === 'export') {
        const pathArg = args[1];
        if (!pathArg) {
          ctx.print('Usage: /services export <path>');
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, JSON.stringify(all, null, 2) + '\n', 'utf-8');
        ctx.print(`Exported services config to ${targetPath}`);
        return;
      }
      if (sub === 'import') {
        const pathArg = args[1];
        if (!pathArg) {
          ctx.print('Usage: /services import <path>');
          return;
        }
        const sourcePath = shellPaths.resolveWorkspacePath(pathArg);
        try {
          const parsed = JSON.parse(readFileSync(sourcePath, 'utf-8')) as Record<string, unknown>;
          const targetPath = shellPaths.resolveProjectPath('tui', 'services.json');
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
          ctx.print(`Imported services config from ${sourcePath}`);
        } catch (error) {
          ctx.print(`Failed to import services config: ${summarizeError(error)}`);
        }
        return;
      }
      if (ctx.openSelection) {
        const testAction = new Map<string, SelectionAction>([['t', 'select' as const]]);
        const items: SelectionItem[] = keys.length === 0
          ? [{ id: '_empty', label: 'No services configured', detail: '.goodvibes/tui/services.json' }]
          : keys.map((key) => ({ id: key, label: all[key].name ?? key, detail: `${all[key].authType}  ${all[key].baseUrl ?? '(no url)'}`, actions: '[t] test' }));
        ctx.openSelection('Services', items, { allowSearch: true, customActions: testAction }, (result) => {
          if (!result || result.item.id === '_empty') return;
          const svc = all[result.item.id];
          if (!svc) return;
          if (result.action === 'select') {
            void svcRegistry.testConnection(result.item.id).then((testResult) => {
              ctx.print([
                `Service test ${result.item.id}`,
                `  ok: ${testResult.ok ? 'yes' : 'no'}`,
                `  status: ${testResult.status ?? 'n/a'}`,
                `  url: ${testResult.testedUrl ?? 'n/a'}`,
                `  error: ${testResult.error ?? 'none'}`,
              ].join('\n'));
            });
            return;
          }
          ctx.print([
            `Service ${result.item.id}`,
            `  authType: ${svc.authType}`,
            `  baseUrl: ${svc.baseUrl ?? '(none)'}`,
          ].join('\n'));
        });
        return;
      }
      if (keys.length === 0) {
        ctx.print('[services] No services configured. Add entries to .goodvibes/tui/services.json');
        return;
      }
      ctx.print(['Services:', '', ...keys.map((key) => `  ${key.padEnd(20)} ${all[key].authType.padEnd(10)} ${all[key].baseUrl ?? '(no url)'}`)].join('\n'));
    },
  });
}
