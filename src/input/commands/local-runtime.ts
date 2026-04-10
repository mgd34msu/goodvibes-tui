import { dirname, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';
import type { ContentPart } from '../../providers/interface.ts';
import type { ConfigKey } from '../../config/index.ts';
import { CONFIG_SCHEMA } from '../../config/index.ts';
import { resolveAndValidatePath } from '../../utils/path-safety.ts';
import { getBookmarkManager } from '../../bookmarks/manager.ts';
import { getSecretsManager } from '../../config/secrets.ts';
import { BUILTIN_SECRET_PROVIDER_SOURCES, describeSecretRef, isSecretRefInput, resolveSecretRef } from '../../config/secret-refs.ts';
import { pinModel, unpinModel, isModelPinned, getPinned } from '../../providers/favorites.ts';
import { getPluginDirectories } from '../../plugins/loader.ts';
import { getPanelManager } from '../../panels/panel-manager.ts';

function toggleBlocks(typeFilter: string, collapsed: boolean, ctx: CommandContext): void {
  const VALID_TYPES = ['all', 'thinking', 'tool', 'code'] as const;
  if (!VALID_TYPES.includes(typeFilter as typeof VALID_TYPES[number])) {
    ctx.print(`Unknown type: ${typeFilter}\nValid types: ${VALID_TYPES.join(', ')}`);
    return;
  }
  const blockRegistry = ctx.conversationManager.getBlockRegistry();
  if (!blockRegistry || blockRegistry.length === 0) {
    ctx.print('No blocks found.');
    return;
  }
  let count = 0;
  for (let i = 0; i < blockRegistry.length; i++) {
    const block = blockRegistry[i];
    const matchesType = typeFilter === 'all'
      || (typeFilter === 'tool' && block.type === 'tool')
      || (typeFilter === 'code' && block.type === 'code')
      || (typeFilter === 'thinking' && block.type === 'thinking');
    if (!matchesType) continue;
    const isCurrentlyCollapsed = ctx.conversationManager.isCollapsed(i);
    if (collapsed ? !isCurrentlyCollapsed : isCurrentlyCollapsed) {
      ctx.conversationManager.toggleCollapseAtLine(block.startLine);
      count++;
    }
  }
  ctx.print(`${collapsed ? 'Collapsed' : 'Expanded'} ${count} block${count !== 1 ? 's' : ''}${typeFilter !== 'all' ? ` (${typeFilter})` : ''}.`);
  ctx.renderRequest();
}

export function registerLocalRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'incident-review',
    aliases: [],
    description: 'Alias for /incident open',
    usage: '',
    handler(_args, ctx) {
      if (ctx.openIncidentPanel) {
        ctx.openIncidentPanel();
        return;
      }
      ctx.print('Incident panel is not available in this runtime.');
    },
  });

  registry.register({
    name: 'tools',
    aliases: ['t'],
    description: 'List available tools and review compact native tool capability surfaces',
    usage: '[review|panel]',
    handler(args, ctx) {
      const sub = (args[0] ?? '').toLowerCase();
      if (sub === 'panel' || sub === 'review') {
        try {
          if (ctx.showPanel) ctx.showPanel('tools');
          else {
            const panelManager = getPanelManager();
            panelManager.open('tools');
            panelManager.show();
            ctx.renderRequest();
          }
        } catch {
          // Panel registry may be unavailable in lightweight command-only contexts.
        }
        if (sub === 'review') {
          ctx.print([
            'Tool Surface Review',
            '  Native file tools stay compact by default.',
            '  Read/write/edit/notebook capabilities are available through the native tool stack, with detail routed to the tools panel and approval surfaces instead of transcript bloat.',
            '  Shell and native tool approvals classify work into read, mutation, destructive, dependency, config, notebook, network, remote, and lifecycle risk families.',
            '  Use /tools panel to inspect risk class, output-policy actions, spill posture, compact summaries, and approval posture for recent calls.',
            '  Use /approval review shell or /approval review file when you need the action-specific why-prompted posture.',
          ].join('\n'));
        }
        return;
      }
      const tools = ctx.toolRegistry.list();
      if (ctx.openSelection) {
        const items: SelectionItem[] = tools.map(t => ({
          id: t.definition.name,
          label: t.definition.name,
          detail: typeof t.definition.description === 'string' ? t.definition.description.slice(0, 50) : '',
        }));
        ctx.openSelection('Available Tools', items, { allowSearch: true }, (result) => {
          if (!result) return;
          const tool = tools.find(t2 => t2.definition.name === result.item.id);
          if (tool) ctx.print(`Tool: ${tool.definition.name}\n  ${tool.definition.description ?? ''}`);
        });
        return;
      }
      ctx.print(['Available tools:', ...tools.map(t => `  • ${t.definition.name}`)].join('\n'));
    },
  });

  registry.register({ name: 'expand', description: 'Expand blocks by type', usage: '[all|thinking|tool|code]', argsHint: '[all|thinking|tool|code]', handler(args, ctx) { toggleBlocks(args[0] || 'all', false, ctx); } });
  registry.register({ name: 'collapse', description: 'Collapse blocks by type', usage: '[all|thinking|tool|code]', argsHint: '[all|thinking|tool|code]', handler(args, ctx) { toggleBlocks(args[0] || 'all', true, ctx); } });

  registry.register({
    name: 'bookmarks',
    aliases: ['bm'],
    description: 'List bookmarked blocks',
    handler(_args, ctx) {
      if (ctx.openBookmarkModal) {
        ctx.openBookmarkModal();
        return;
      }
      const bm = getBookmarkManager();
      const entries = bm.list();
      if (ctx.openSelection) {
        const deleteAction = new Map([['d', 'delete' as const]]);
        const items: SelectionItem[] = entries.length === 0
          ? [{ id: '_empty', label: 'No bookmarks', detail: 'Use Ctrl+B to bookmark' }]
          : entries.map(entry => ({ id: entry.key, label: entry.label, detail: new Date(entry.timestamp).toLocaleTimeString(), actions: '[d] delete' }));
        ctx.openSelection('Bookmarks', items, { allowSearch: true, customActions: deleteAction }, (result) => {
          if (!result) return;
          if (result.action === 'delete') {
            bm.toggle(result.item.id);
            ctx.print(`Bookmark removed: ${result.item.id}`);
          } else {
            ctx.jumpToBookmark?.(result.item.id);
          }
        });
        return;
      }
      ctx.print(['Bookmarks:', '', ...entries.map(entry => `  ${entry.key.padEnd(32)} ${entry.label}  (${new Date(entry.timestamp).toLocaleTimeString()})`)].join('\n'));
    },
  });

  registry.register({
    name: 'secrets',
    description: 'Manage hierarchy-aware secrets, external secret refs, and secure/plaintext storage policy controls',
    usage: 'set <KEY> <value> [--user|--project] [--secure|--plaintext] | link <KEY> <secret-ref> [--user|--project] [--secure|--plaintext] | get <KEY> | test <secret-ref> | providers | list | delete <KEY> [--user|--project] [--secure|--plaintext]',
    argsHint: '<set|link|get|test|providers|list|delete> [KEY]',
    async handler(args, ctx) {
      const mgr = getSecretsManager();
      const [sub, ...rest] = args;
      if (!sub || sub === 'list') {
        const records = await mgr.listDetailed();
        const storedRecords = records.filter((record) => record.source !== 'env');
        ctx.print(storedRecords.length === 0
          ? '[secrets] No secrets stored. Use: /secrets set <KEY> <value>'
          : [
            '[secrets] Stored keys:',
            ...storedRecords.map((record) => `  ${record.key} (${record.source}${record.refSource ? `, ref:${record.refSource}` : ''}${record.overriddenByEnv ? ', env override' : ''})`),
          ].join('\n'));
        return;
      }
      if (sub === 'providers') {
        ctx.print([
          '[secrets] Built-in secret providers:',
          ...BUILTIN_SECRET_PROVIDER_SOURCES.map((source) => `  ${source}`),
          '',
          'Examples:',
          '  /secrets link OPENAI_API_KEY secret://env/OPENAI_API_KEY',
          '  /secrets link SLACK_BOT_TOKEN bw://GoodVibes%20Slack/password?sessionEnv=BW_SESSION',
          '  /secrets link SLACK_BOT_TOKEN vaultwarden://GoodVibes%20Slack/password?server=https%3A%2F%2Fvault.example.test',
          '  /secrets link STRIPE_TOKEN bws://00000000-0000-0000-0000-000000000000/value?accessTokenEnv=BWS_ACCESS_TOKEN',
          '  /secrets link OPENAI_API_KEY op://Private/GoodVibes%20OpenAI/API%20Key',
        ].join('\n'));
        return;
      }
      if (sub === 'test') {
        const refText = rest.join(' ').trim();
        if (!refText) {
          ctx.print('[secrets] Usage: /secrets test <secret-ref>');
          return;
        }
        if (!isSecretRefInput(refText)) {
          ctx.print('[secrets] Invalid secret reference. Use /secrets providers for examples.');
          return;
        }
        try {
          const resolved = await resolveSecretRef(refText, { resolveLocalSecret: (key) => mgr.get(key) });
          ctx.print(`[secrets] ${describeSecretRef(refText)}: ${resolved.value ? 'resolved <redacted>' : 'missing'}`);
        } catch (error) {
          ctx.print(`[secrets] ${describeSecretRef(refText)} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (sub === 'set' || sub === 'link') {
        const flags = new Set(rest.filter((value) => value.startsWith('--')));
        const valueParts = rest.filter((value) => !value.startsWith('--'));
        const [key, ...rawValueParts] = valueParts;
        if (!key || valueParts.length === 0) {
          ctx.print(`[secrets] Usage: /secrets ${sub} <KEY> <${sub === 'link' ? 'secret-ref' : 'value'}> [--user|--project] [--secure|--plaintext]`);
          return;
        }
        const value = rawValueParts.join(' ');
        if (sub === 'link' && !isSecretRefInput(value)) {
          ctx.print('[secrets] Invalid secret reference. Use /secrets providers for examples.');
          return;
        }
        const scope = flags.has('--user') ? 'user' : 'project';
        const medium = flags.has('--plaintext') ? 'plaintext' : 'secure';
        await mgr.set(key, value, { scope, medium });
        ctx.print(sub === 'link'
          ? `[secrets] Linked: ${key} -> ${describeSecretRef(value)} (${scope}, ${medium})`
          : `[secrets] Stored: ${key} (${scope}, ${medium})`);
        return;
      }
      if (sub === 'get') {
        const [key] = rest;
        if (!key) {
          ctx.print('[secrets] Usage: /secrets get <KEY>');
          return;
        }
        const value = await mgr.get(key);
        ctx.print(value === null ? `[secrets] Not found: ${key}` : `[secrets] ${key} = <stored> (use /secrets list to see all keys)`);
        return;
      }
      if (sub === 'delete') {
        const flags = new Set(rest.filter((value) => value.startsWith('--')));
        const [key] = rest.filter((value) => !value.startsWith('--'));
        if (!key) {
          ctx.print('[secrets] Usage: /secrets delete <KEY> [--user|--project] [--secure|--plaintext]');
          return;
        }
        await mgr.delete(key, {
          scope: flags.has('--user') ? 'user' : flags.has('--project') ? 'project' : undefined,
          medium: flags.has('--plaintext') ? 'plaintext' : flags.has('--secure') ? 'secure' : undefined,
        });
        ctx.print(`[secrets] Deleted: ${key}`);
        return;
      }
      ctx.print('[secrets] Usage: /secrets set <KEY> <value> [--user|--project] [--secure|--plaintext] | link <KEY> <secret-ref> [--user|--project] [--secure|--plaintext] | get <KEY> | test <secret-ref> | providers | list | delete <KEY> [--user|--project] [--secure|--plaintext]');
    },
  });

  registry.register({
    name: 'danger',
    argsHint: '[key] [value]',
    description: '⚠ Danger zone settings (agent recursion, daemon, HTTP listener)',
    usage: '[key] [value]',
    handler(args, ctx) {
      if (args.length === 0) {
        if (ctx.openSelection) {
          const cm = ctx.configManager;
          const dangerObj = cm.getAll().danger as Record<string, unknown>;
          const items: SelectionItem[] = Object.entries(dangerObj).map(([field, val]) => {
            const key = `danger.${field}`;
            const schema = CONFIG_SCHEMA.find(s => s.key === key);
            const toggleable = schema?.type === 'boolean';
            return {
              id: key,
              label: key,
              detail: String(val),
              fg: '#ef4444',
              adjustable: toggleable,
              primaryAction: toggleable ? 'toggle' : 'select',
              actions: schema ? `${toggleable ? '[Space/Enter] toggle  [←/→] set' : '[Enter] inspect'}  ${schema.description}` : undefined,
            };
          });
          ctx.openSelection('⚠ Danger Zone', items, { allowSearch: false }, (result) => {
            if (!result) return;
            const key = result.item.id as ConfigKey;
            const schema = CONFIG_SCHEMA.find(s => s.key === key);
            if (result.action === 'toggle' && schema) {
              const currentVal = cm.get(key);
              let newVal: unknown = currentVal;
              if (schema.type === 'boolean') {
                newVal = !currentVal;
                cm.setDynamic(key, newVal);
              } else if (schema.type === 'number') {
                ctx.print(`Current: ${key} = ${String(currentVal)}. Use /danger ${key.replace('danger.', '')} <value> to set.`);
                return;
              }
              result.item.detail = String(newVal);
              ctx.renderRequest();
            } else if ((result.action === 'increment' || result.action === 'decrement') && schema?.type === 'boolean') {
              const newVal = result.action === 'increment';
              cm.setDynamic(key, newVal);
              result.item.detail = String(newVal);
              ctx.renderRequest();
            }
          });
        } else {
          const dangerObj = ctx.configManager.getAll().danger as Record<string, unknown>;
          ctx.print(['⚠ Danger Zone Settings:', '', ...Object.entries(dangerObj).map(([field, val]) => `  ${`danger.${field}`.padEnd(36)} ${String(val)}`)].join('\n'));
        }
        return;
      }
      const key = args[0].startsWith('danger.') ? args[0] : `danger.${args[0]}`;
      if (args.length === 1) {
        try {
          ctx.print(`${key} = ${String(ctx.configManager.get(key as Parameters<typeof ctx.configManager.get>[0]))}`);
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
        return;
      }
      try {
        const schema = CONFIG_SCHEMA.find(s => s.key === key);
        if (!schema) {
          ctx.print(`Unknown danger key: ${key}`);
          return;
        }
        const rawValue = args.slice(1).join(' ');
        const coerced: unknown = schema.type === 'boolean' ? (rawValue === 'true' || rawValue === '1' || rawValue === 'yes') : schema.type === 'number' ? Number(rawValue) : rawValue;
        ctx.configManager.setDynamic(key as Parameters<typeof ctx.configManager.get>[0], coerced);
        ctx.print(`⚠ Set ${key} = ${String(coerced)}`);
      } catch (e) {
        ctx.print(`Error: ${(e as Error).message}`);
      }
    },
  });

  registry.register({
    name: 'image',
    aliases: ['img'],
    description: 'Attach an image file to the next message',
    usage: '<path> [prompt text]',
    argsHint: '<path> [prompt]',
    async handler(args, ctx) {
      if (args.length === 0) {
        ctx.print('Usage: /image <path> [prompt text]\nSupported formats: PNG, JPEG, WebP, GIF');
        return;
      }
      const rawPath = args[0];
      const promptText = args.slice(1).join(' ') || `Attached image: ${rawPath.split('/').pop() ?? rawPath}`;
      let resolvedPath: string;
      try {
        resolvedPath = resolveAndValidatePath(rawPath);
      } catch (err) {
        ctx.print(`Error: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (!existsSync(resolvedPath)) {
        ctx.print(`File not found: ${rawPath}`);
        return;
      }
      const ext = resolvedPath.slice(resolvedPath.lastIndexOf('.')).toLowerCase();
      const mediaType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' } as Record<string, string>)[ext];
      if (!mediaType) {
        ctx.print(`Unsupported image format: ${ext}\nSupported: .png, .jpg, .jpeg, .webp, .gif`);
        return;
      }
      const stat = statSync(resolvedPath);
      if (stat.size > 20 * 1024 * 1024) {
        ctx.print(`Image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Maximum: 20MB`);
        return;
      }
      let data: string;
      try {
        data = (await readFile(resolvedPath)).toString('base64');
      } catch (err) {
        ctx.print(`Failed to read image: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const currentModel = ctx.providerRegistry.getCurrentModel();
      if (!currentModel.capabilities.multimodal) {
        ctx.print(`Warning: ${currentModel.displayName} does not support image input. The image will be stripped when sending.`);
      }
      const content: ContentPart[] = [{ type: 'text', text: promptText }, { type: 'image', data, mediaType }];
      ctx.submitInput?.(promptText, content);
    },
  });

  registry.register({
    name: 'refresh-models',
    description: 'Refresh model catalog, benchmarks, and token limits',
    async handler(_args, ctx) {
      let catalogOk = false;
      let benchmarksOk = false;
      let limitsOk = false;
      ctx.print('Refreshing model catalog...');
      try {
        const { refreshCatalog, getCatalogModelDefinitions } = await import('../../providers/model-catalog.ts');
        await refreshCatalog();
        catalogOk = true;
        const models = getCatalogModelDefinitions();
        ctx.print(`Model catalog refreshed: ${models.length} models from ${new Set(models.map((m) => m.provider)).size} providers`);
      } catch (e) {
        ctx.print(`Catalog refresh failed: ${(e as Error).message}`);
      }
      ctx.print('Refreshing benchmarks...');
      try {
        const { refreshBenchmarks } = await import('../../providers/model-benchmarks.ts');
        await refreshBenchmarks();
        benchmarksOk = true;
        ctx.print('Benchmarks refreshed.');
      } catch (e) {
        ctx.print(`Benchmarks refresh failed: ${(e as Error).message}`);
      }
      ctx.print('Refreshing token limits...');
      try {
        const { refreshModelLimits } = await import('../../providers/model-limits.ts');
        const count = await refreshModelLimits();
        limitsOk = true;
        ctx.print(`Token limits refreshed: ${count} models updated.`);
      } catch (e) {
        ctx.print(`Token limits refresh failed: ${(e as Error).message}`);
      }
      if (!catalogOk || !benchmarksOk || !limitsOk) ctx.print('Some refreshes failed — see messages above.');
    },
  });

  registry.register({
    name: 'pin',
    description: 'Pin a model to the favorites list',
    usage: '<model-id>',
    argsHint: '<model-id>',
    async handler(args, ctx) {
      const modelId = args[0];
      if (!modelId) {
        const pinned = await getPinned();
        ctx.print(pinned.length === 0 ? 'No pinned models. Use /pin <model-id> to pin one.' : `Pinned models:\n${pinned.map(id => `  ★ ${id}`).join('\n')}`);
        return;
      }
      if (await isModelPinned(modelId)) {
        ctx.print(`Model already pinned: ${modelId}`);
        return;
      }
      await pinModel(modelId);
      ctx.print(`Pinned: ${modelId}`);
    },
  });

  registry.register({
    name: 'unpin',
    description: 'Unpin a model from the favorites list',
    usage: '<model-id>',
    argsHint: '<model-id>',
    async handler(args, ctx) {
      const modelId = args[0];
      if (!modelId) {
        ctx.print('Usage: /unpin <model-id>');
        return;
      }
      if (!await isModelPinned(modelId)) {
        ctx.print(`Model is not pinned: ${modelId}`);
        return;
      }
      await unpinModel(modelId);
      ctx.print(`Unpinned: ${modelId}`);
    },
  });
}
