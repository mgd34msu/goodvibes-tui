import { dirname, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';
import type { ContentPart } from '@pellux/goodvibes-sdk/platform/providers';
import { formatModelDiscoveryReport } from '@pellux/goodvibes-sdk/platform/providers';
import { resolveAndValidatePath } from '@pellux/goodvibes-sdk/platform/utils';
import { BUILTIN_SECRET_PROVIDER_SOURCES, describeSecretRef, isSecretRefInput, resolveSecretRef } from '@pellux/goodvibes-sdk/platform/config';
import { openCommandPanel, requireBookmarkManager, requireProviderApi, requireSecretsManager } from './runtime-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

function isGoodVibesSecretRefInput(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://secrets/') && isSecretRefInput(normalized);
}

function isMalformedGoodVibesSecretRefInput(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://') && !isGoodVibesSecretRefInput(normalized);
}

function toggleBlocks(typeFilter: string, collapsed: boolean, ctx: CommandContext): void {
  const VALID_TYPES = ['all', 'thinking', 'tool', 'code'] as const;
  if (!VALID_TYPES.includes(typeFilter as typeof VALID_TYPES[number])) {
    ctx.print(`Unknown type: ${typeFilter}\nValid types: ${VALID_TYPES.join(', ')}`);
    return;
  }
  const blockRegistry = ctx.session.conversationManager.getBlockRegistry();
  if (!blockRegistry || blockRegistry.length === 0) {
    ctx.print('No blocks found.');
    return;
  }
  let count = 0;
  for (let i = 0; i < blockRegistry.length; i++) {
    const block = blockRegistry[i];
    // A folded tool-result group (type 'tool_group', see conversation-tool-groups.ts)
    // is a run of tool results under one header, so '/expand tool'/'collapse tool'
    // treats it the same as a plain 'tool' block — toggling the header's collapse
    // key expands/collapses every member underneath it.
    const matchesType = typeFilter === 'all'
      || (typeFilter === 'tool' && (block.type === 'tool' || block.type === 'tool_group'))
      || (typeFilter === 'code' && block.type === 'code')
      || (typeFilter === 'thinking' && block.type === 'thinking');
    if (!matchesType) continue;
    const isCurrentlyCollapsed = ctx.session.conversationManager.isCollapsed(i);
    if (collapsed ? !isCurrentlyCollapsed : isCurrentlyCollapsed) {
      ctx.session.conversationManager.toggleCollapseAtLine(block.startLine);
      // Expanding a folded tool-result group also expands every member's own
      // collapse key in the same pass. A folded member pushes no BlockMeta of
      // its own while the group is collapsed, so it never surfaces from this
      // loop to be toggled individually — without this, '/expand tool' only
      // opens the group header and each member still renders at whatever its
      // own default collapse state is, needing a second '/expand tool' pass.
      // '/collapse tool' needs no matching step: collapsing the group hides
      // every member regardless of its own key.
      if (!collapsed && block.type === 'tool_group' && block.groupMemberIndexes) {
        for (const memberIdx of block.groupMemberIndexes) {
          const memberKey = `msg_${memberIdx}`;
          ctx.session.conversationManager.setCollapsed(memberKey, false);
          // An explicit /expand is a deliberate user action on this key, same
          // as Tab/Ctrl+Y/Ctrl+B — exempts it from search's close-time
          // auto-re-collapse (see ConversationManager.noteUserTouch).
          ctx.session.conversationManager.searchExpansion.noteUserTouch(memberKey);
        }
      }
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
        // (the purge): 'tools'/ToolInspectorPanel was DELETE-disposition
        // (no surviving human surface — tool results render inline in the
        // transcript, plus a per-node tool list in Fleet). There is no alias
        // to resolve through, so this prints an honest notice and opens
        // Fleet instead of the retired inspector.
        ctx.print('Tools panel retired — tool activity now renders inline in the transcript and per-agent in the Fleet panel. Opening Fleet.');
        try {
          openCommandPanel(ctx, 'fleet');
        } catch {
          // Panel registry may be unavailable in lightweight command-only contexts.
        }
        if (sub === 'review') {
          ctx.print([
            'Tool Surface Review',
            '  Native file tools stay compact by default.',
            '  Read/write/edit/notebook capabilities are available through the native tool stack, with detail routed inline and to approval surfaces instead of transcript bloat.',
            '  Shell and native tool approvals classify work into read, mutation, destructive, dependency, config, notebook, network, remote, and lifecycle risk families.',
            '  Use /tools panel to jump to the Fleet panel for live per-agent tool activity.',
            '  Use /approval review shell or /approval review file when you need the action-specific why-prompted posture.',
          ].join('\n'));
        }
        return;
      }
      const tools = ctx.extensions.toolRegistry.list();
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
      const bm = requireBookmarkManager(ctx);
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
    description: 'Persistent secret storage: hierarchy-aware, external secret refs, providers (a quick one-off masked value instead: /secret)',
    usage: 'set <KEY> <value> [--user|--project] [--secure|--plaintext] | link <KEY> <secret-ref> [--user|--project] [--secure|--plaintext] | get <KEY> | test <secret-ref> | providers | list | delete <KEY> [--user|--project] [--secure|--plaintext]',
    argsHint: '<set|link|get|test|providers|list|delete> [KEY]',
    async handler(args, ctx) {
      const mgr = requireSecretsManager(ctx);
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
          '  /secrets link OPENAI_API_KEY goodvibes://secrets/env/OPENAI_API_KEY',
          '  /secrets link SLACK_BOT_TOKEN goodvibes://secrets/bitwarden?item=GoodVibes%20Slack&field=password&sessionEnv=BW_SESSION',
          '  /secrets link SLACK_BOT_TOKEN goodvibes://secrets/vaultwarden?item=GoodVibes%20Slack&field=password&server=https%3A%2F%2Fvault.example.test',
          '  /secrets link STRIPE_TOKEN goodvibes://secrets/bws/00000000-0000-0000-0000-000000000000?field=value&accessTokenEnv=BWS_ACCESS_TOKEN',
          '  /secrets link OPENAI_API_KEY goodvibes://secrets/1password?vault=Private&item=GoodVibes%20OpenAI&field=API%20Key',
        ].join('\n'));
        return;
      }
      if (sub === 'test') {
        const refText = rest.join(' ').trim();
        if (!refText) {
          ctx.print('[secrets] Usage: /secrets test <secret-ref>');
          return;
        }
        if (!isGoodVibesSecretRefInput(refText)) {
          ctx.print('[secrets] Invalid secret reference. Use /secrets providers for examples.');
          return;
        }
        try {
          const resolved = await resolveSecretRef(refText, { resolveLocalSecret: (key) => mgr.get(key) });
          ctx.print(`[secrets] ${describeSecretRef(refText)}: ${resolved.value ? 'resolved <redacted>' : 'missing'}`);
        } catch (error) {
          ctx.print(`[secrets] ${describeSecretRef(refText)} failed: ${summarizeError(error)}`);
        }
        return;
      }
      if (sub === 'set' || sub === 'link') {
        const flags = new Set(rest.filter((value) => value.startsWith('--')));
        const valueParts = rest.filter((value) => !value.startsWith('--'));
        const [key, ...rawValueParts] = valueParts;
        if (!key) {
          ctx.print(`[secrets] Usage: /secrets ${sub} <KEY> <${sub === 'link' ? 'secret-ref' : 'value'}> [--user|--project] [--secure|--plaintext]`);
          return;
        }
        const scope = flags.has('--user') ? 'user' : 'project';
        const medium = flags.has('--plaintext') ? 'plaintext' : 'secure';
        // /secrets set KEY (no value) drops into the concealed prompt so the
        // value is typed with the keystrokes masked and never enters history.
        if (sub === 'set' && rawValueParts.length === 0) {
          if (!ctx.beginConcealedInput) {
            ctx.print('[secrets] Usage: /secrets set <KEY> <value> [--user|--project] [--secure|--plaintext]');
            return;
          }
          ctx.print(`[secrets] Enter value for ${key} (input is masked; press Enter to store, Esc to cancel).`);
          ctx.beginConcealedInput({
            label: key,
            onSubmit: (value) => {
              if (value.length === 0) {
                ctx.print(`[secrets] ${key} not set (empty value).`);
                return;
              }
              void (async () => {
                try {
                  await mgr.set(key, value, { scope, medium });
                  ctx.print(`[secrets] Stored: ${key} (${scope}, ${medium})`);
                } catch (error) {
                  ctx.print(`[secrets] Could not store ${key}: ${summarizeError(error)}`);
                }
              })();
            },
            onCancel: () => {
              ctx.print(`[secrets] ${key} cancelled.`);
            },
          });
          return;
        }
        const value = rawValueParts.join(' ');
        if (sub === 'link' && !isGoodVibesSecretRefInput(value)) {
          ctx.print('[secrets] Invalid secret reference. Use /secrets providers for examples.');
          return;
        }
        if (sub === 'set' && isMalformedGoodVibesSecretRefInput(value)) {
          ctx.print('[secrets] Invalid secret reference. Use /secrets providers for examples.');
          return;
        }
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
    name: 'image',
    aliases: ['img'],
    description: 'Attach an image file to the next message',
    usage: '<path> [prompt text]',
    argsHint: '<path> [prompt text]',
    async handler(args, ctx) {
      if (args.length === 0) {
        ctx.print('Usage: /image <path> [prompt text]\nSupported formats: PNG, JPEG, WebP, GIF');
        return;
      }
      const rawPath = args[0];
      const promptText = args.slice(1).join(' ') || `Attached image: ${rawPath.split('/').pop() ?? rawPath}`;
      const projectRoot = ctx.workspace.shellPaths?.workingDirectory ?? ctx.platform.configManager.getWorkingDirectory();
      if (!projectRoot) {
        ctx.print('Error: working directory is unavailable.');
        return;
      }
      let resolvedPath: string;
      try {
        resolvedPath = resolveAndValidatePath(rawPath, projectRoot);
      } catch (err) {
        ctx.print(`Error: ${summarizeError(err)}`);
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
        ctx.print(`Failed to read image: ${summarizeError(err)}`);
        return;
      }
      const currentModel = await requireProviderApi(ctx).getCurrentModel();
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
      const providerApi = requireProviderApi(ctx);
      let catalogOk = false;
      let benchmarksOk = false;
      let limitsOk = false;
      ctx.print('Refreshing model catalog...');
      try {
        const catalog = await providerApi.refreshCatalog();
        catalogOk = true;
        ctx.print(`Model catalog refreshed: ${catalog.modelCount} models from ${catalog.providerCount} providers`);
      } catch (e) {
        ctx.print(`Catalog refresh failed: ${summarizeError(e)}`);
      }
      ctx.print('Refreshing benchmarks...');
      try {
        const benchmarkCount = await providerApi.refreshBenchmarks();
        benchmarksOk = true;
        ctx.print(`Benchmarks refreshed${benchmarkCount > 0 ? `: ${benchmarkCount} model records available.` : '.'}`);
      } catch (e) {
        ctx.print(`Benchmarks refresh failed: ${summarizeError(e)}`);
      }
      ctx.print('Refreshing token limits...');
      try {
        const count = await providerApi.refreshModelLimits();
        limitsOk = true;
        ctx.print(`Token limits refreshed: ${count} models updated.`);
      } catch (e) {
        ctx.print(`Token limits refresh failed: ${summarizeError(e)}`);
      }
      ctx.print('Refreshing live provider model lists...');
      let discoveryOk = false;
      try {
        // Explicit user refresh → force past each provider's TTL cache and
        // report the delta ("3 new, 1 retired") or the honest fallback reason.
        const reports = await providerApi.refreshLiveModelDiscovery(undefined, { force: true });
        discoveryOk = true;
        if (reports.length === 0) {
          ctx.print('No providers perform live model discovery.');
        } else {
          for (const report of reports) {
            ctx.print(`  ${formatModelDiscoveryReport(report.providerId, report)}`);
          }
        }
      } catch (e) {
        ctx.print(`Live model discovery failed: ${summarizeError(e)}`);
      }
      if (!catalogOk || !benchmarksOk || !limitsOk || !discoveryOk) ctx.print('Some refreshes failed — see messages above.');
    },
  });

  registry.register({
    name: 'pin',
    description: 'Pin a model to the favorites list',
    usage: '<model-id>',
    argsHint: '<model-id>',
    async handler(args, ctx) {
      const providerApi = requireProviderApi(ctx);
      const modelId = args[0];
      if (!modelId) {
        const favorites = await providerApi.getFavorites();
        ctx.print(
          favorites.pinned.length === 0
            ? 'No pinned models. Use /pin <model-id> to pin one.'
            : `Pinned models:\n${favorites.pinned.map((entry) => `  ★ ${entry.registryKey ?? entry.modelId}`).join('\n')}`,
        );
        return;
      }
      const favorites = await providerApi.getFavorites();
      if (favorites.pinned.some((entry) => entry.modelId === modelId || entry.registryKey === modelId)) {
        ctx.print(`Model already pinned: ${modelId}`);
        return;
      }
      try {
        await providerApi.pinModel(modelId);
        ctx.print(`Pinned: ${modelId}`);
      } catch (e) {
        ctx.print(`Error: ${summarizeError(e)}`);
      }
    },
  });

  registry.register({
    name: 'unpin',
    description: 'Unpin a model from the favorites list',
    usage: '<model-id>',
    argsHint: '<model-id>',
    async handler(args, ctx) {
      const providerApi = requireProviderApi(ctx);
      const modelId = args[0];
      if (!modelId) {
        ctx.print('Usage: /unpin <model-id>');
        return;
      }
      const favorites = await providerApi.getFavorites();
      const pinned = favorites.pinned.find((entry) => entry.registryKey === modelId);
      if (!pinned) {
        ctx.print(`Model is not pinned: ${modelId}`);
        return;
      }
      await providerApi.unpinModel(pinned.registryKey);
      ctx.print(`Unpinned: ${modelId}`);
    },
  });
}
