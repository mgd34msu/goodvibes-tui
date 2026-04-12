import type { CommandRegistry } from '../command-registry.ts';
import { requireWebhookNotifier } from './runtime-services.ts';

export function registerNotifyRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'notify',
    aliases: [],
    description: 'Manage webhook notification URLs (ntfy.sh format)',
    usage: 'add <url> | remove <url> | list | clear | test',
    argsHint: 'add|remove|list|clear|test',
    async handler(args, ctx) {
      const notifications = ctx.configManager.getCategory('notifications');
      const urls: string[] = Array.isArray(notifications.webhookUrls) ? [...notifications.webhookUrls] : [];
      const notifier = requireWebhookNotifier(ctx);
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
        notifier.setUrls(urls);
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
        notifier.setUrls(next);
        ctx.print(`Webhook removed: ${url}`);
        return;
      }

      if (sub === 'clear') {
        ctx.configManager.mergeCategory('notifications', { webhookUrls: [] });
        notifier.setUrls([]);
        ctx.print('All webhook URLs cleared.');
        return;
      }

      if (sub === 'test') {
        if (urls.length === 0) {
          ctx.print('No webhook URLs configured. Use: /notify add <url>');
          return;
        }
        ctx.print(`Testing ${urls.length} webhook${urls.length !== 1 ? 's' : ''}...`);
        notifier.setUrls(urls);
        const results = await notifier.test();
        ctx.print(results.map((r) => r.ok ? `  [ok] ${r.url}` : `  [fail] ${r.url} — ${r.error ?? 'unknown error'}`).join('\n'));
        return;
      }

      ctx.print('Usage: /notify add <url> | remove <url> | list | clear | test');
    },
  });
}
