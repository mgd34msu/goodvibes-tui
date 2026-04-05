import { join } from 'path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { writeFile, unlink, readFile } from 'node:fs/promises';
import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';
import type { ContentPart } from '../../providers/interface.ts';
import type { ConfigKey } from '../../config/index.ts';
import { CONFIG_SCHEMA } from '../../config/index.ts';
import { fetchModelContextWindows } from '../../discovery/scanner.ts';
import type { CustomProviderConfig } from '../../providers/custom-loader.ts';
import { resolveAndValidatePath } from '../../utils/path-safety.ts';
import { getBookmarkManager } from '../../bookmarks/manager.ts';
import { getSecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '../../config/service-registry.ts';
import { pinModel, unpinModel, isModelPinned, getPinned } from '../../providers/favorites.ts';

let serviceRegistry: ServiceRegistry | undefined;
function getServiceRegistry(): ServiceRegistry {
  if (!serviceRegistry) serviceRegistry = new ServiceRegistry();
  return serviceRegistry;
}

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
    name: 'tools',
    aliases: ['t'],
    description: 'List available tools',
    handler(_args, ctx) {
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

  registry.register({
    name: 'provider',
    aliases: ['p'],
    description: 'Switch provider or manage custom providers (add/remove)',
    usage: '[add <name> <baseURL> [apiKey] | remove <name> | <provider-name>]',
    argsHint: '[add|remove|name]',
    async handler(args, ctx) {
      const isValidProviderName = (name: string): boolean => /^[a-zA-Z0-9_-]+$/.test(name);
      if (args[0] === 'add') {
        const addArgs = args.slice(1);
        if (addArgs.length < 2) {
          ctx.print('Usage: /provider add <name> <baseURL> [apiKey]\nExample: /provider add my-server http://192.168.0.85:8001/v1');
          return;
        }
        const [name, baseURL, apiKey] = addArgs;
        if (!isValidProviderName(name)) {
          ctx.print('Error: Provider name must contain only letters, numbers, hyphens, and underscores.');
          return;
        }
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(baseURL);
        } catch {
          ctx.print(`Error: '${baseURL}' is not a valid URL. Example: http://192.168.0.85:8001/v1`);
          return;
        }
        const providersDir = join(homedir(), '.goodvibes', 'tui', 'providers');
        const providerFile = join(providersDir, `${name}.json`);
        if (existsSync(providerFile)) {
          ctx.print(`Error: Provider '${name}' already exists at ${providerFile}\nRemove it first with: /provider remove ${name}`);
          return;
        }

        ctx.print(`Probing ${baseURL}/models ...`);
        let discoveredModelIds: string[] = [];
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
          const res = await fetch(`${baseURL}/models`, { signal: controller.signal, headers });
          clearTimeout(timeoutId);
          if (res.ok) {
            const body = await res.json() as unknown;
            if (body && typeof body === 'object' && 'data' in body && Array.isArray((body as Record<string, unknown>).data)) {
              discoveredModelIds = ((body as { data: unknown[] }).data)
                .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null && 'id' in m)
                .map(m => String(m.id))
                .filter(Boolean);
            }
          }
        } catch {
          ctx.print(`Could not reach ${baseURL}/models — creating provider with a minimal starter config.`);
        }

        let contextWindows: Record<string, number> = {};
        if (discoveredModelIds.length > 0) {
          if (parsedUrl.protocol === 'http:') {
            try {
              contextWindows = await fetchModelContextWindows(parsedUrl.hostname, parseInt(parsedUrl.port) || 80, 'unknown', discoveredModelIds);
            } catch {}
          } else {
            ctx.print('Note: Context window detection is only supported for http:// URLs. Using defaults.');
          }
        }
        const defaultModel = `${name}-model`;
        const models: CustomProviderConfig['models'] = discoveredModelIds.length === 0
          ? [{
              id: defaultModel,
              displayName: defaultModel,
              contextWindow: 8192,
              capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
            }]
          : discoveredModelIds.map(id => ({
              id,
              displayName: id,
              contextWindow: contextWindows[id] ?? 8192,
              capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
            }));
        const config: CustomProviderConfig = {
          name,
          displayName: name,
          type: 'openai-compat',
          baseURL,
          ...(apiKey ? { apiKey } : {}),
          models,
        };
        try {
          mkdirSync(providersDir, { recursive: true });
          await writeFile(providerFile, JSON.stringify(config, null, 2), 'utf-8');
        } catch (e) {
          ctx.print(`Error writing provider file: ${(e as Error).message}`);
          return;
        }
        ctx.print(`Provider '${name}' added with ${models.length} model(s):\n${discoveredModelIds.length > 0 ? discoveredModelIds.map(id => `  • ${id} (${(contextWindows[id] ?? 8192).toLocaleString()} ctx)`).join('\n') : `  • ${defaultModel} (starter entry)`}\nThe file watcher will auto-register it shortly.`);
        return;
      }

      if (args[0] === 'remove' || args[0] === 'rm') {
        const name = args[1];
        if (!name) {
          ctx.print('Usage: /provider remove <name>');
          return;
        }
        if (!isValidProviderName(name)) {
          ctx.print('Error: Provider name must contain only letters, numbers, hyphens, and underscores.');
          return;
        }
        const providerFile = join(homedir(), '.goodvibes', 'tui', 'providers', `${name}.json`);
        if (!existsSync(providerFile)) {
          ctx.print(`Error: No custom provider '${name}' found at ${providerFile}`);
          return;
        }
        try {
          await unlink(providerFile);
          ctx.print(`Provider '${name}' removed. The file watcher will deregister it shortly.`);
        } catch (e) {
          ctx.print(`Error removing provider file: ${(e as Error).message}`);
        }
        return;
      }

      if (args.length === 0) {
        if (ctx.openProviderPicker) {
          ctx.openProviderPicker();
          return;
        }
        const providers = ['openai', 'anthropic', 'gemini', 'inceptionlabs'];
        ctx.print(['Available providers:', ...providers.map(p => `  ${p === ctx.runtime.provider ? '▶' : ' '} ${p}`)].join('\n'));
        return;
      }

      const providerName = args[0];
      const match = ctx.providerRegistry.getSelectableModels().find(m => m.provider === providerName);
      if (!match) {
        ctx.print(`Unknown provider: ${providerName}. Available: openai, anthropic, gemini, inceptionlabs`);
        return;
      }
      try {
        ctx.providerRegistry.setCurrentModel(match.id);
        ctx.runtime.model = match.id;
        ctx.runtime.provider = providerName;
        ctx.configManager.set('provider.provider', providerName);
        ctx.configManager.set('provider.model', match.id);
        ctx.print(`Switched to provider: ${providerName} (model: ${match.id})`);
      } catch (e) {
        ctx.print(`Error: ${(e as Error).message}`);
      }
    },
  });

  registry.register({
    name: 'permissions',
    aliases: ['perms'],
    description: 'Show or set permission mode and per-tool settings',
    usage: '[allow-all|prompt|custom] | [tool <name> allow|prompt|deny]',
    argsHint: '[allow-all|prompt|custom]',
    handler(args, ctx) {
      const cm = ctx.configManager;
      const VALID_MODES = ['allow-all', 'prompt', 'custom'] as const;
      const VALID_ACTIONS = ['allow', 'prompt', 'deny'] as const;
      const VALID_TOOLS = ['read', 'write', 'edit', 'exec', 'find', 'fetch', 'analyze', 'inspect', 'agent', 'state', 'workflow', 'registry', 'delegate', 'mcp'] as const;
      type PermTool = typeof VALID_TOOLS[number];
      if (args.length === 0) {
        if (ctx.openSelection) {
          const cycleActions = new Map([['enter', 'toggle' as const]]);
          const items: SelectionItem[] = VALID_TOOLS.map(tool => ({
            id: tool,
            label: tool,
            detail: cm.get(`permissions.tools.${tool}` as Parameters<typeof cm.get>[0]) as string,
            category: 'tools',
            actions: '[Enter] cycle allow/prompt/deny',
          }));
          items.unshift({
            id: '__mode__',
            label: 'permission mode',
            detail: cm.get('permissions.mode') as string,
            category: 'global',
            actions: '[Enter] cycle allow-all/prompt/custom',
          });
          ctx.openSelection('Permissions', items, { allowSearch: true, customActions: cycleActions }, (result) => {
            if (!result) return;
            if (result.item.id === '__mode__') {
              const currentMode = cm.get('permissions.mode') as string;
              const nextMode = VALID_MODES[(VALID_MODES.indexOf(currentMode as typeof VALID_MODES[number]) + 1) % VALID_MODES.length];
              cm.setDynamic('permissions.mode', nextMode);
              result.item.detail = nextMode;
            } else {
              const toolKey = `permissions.tools.${result.item.id}` as Parameters<typeof cm.get>[0];
              const currentAction = cm.get(toolKey) as string;
              const nextAction = VALID_ACTIONS[(VALID_ACTIONS.indexOf(currentAction as typeof VALID_ACTIONS[number]) + 1) % VALID_ACTIONS.length];
              cm.setDynamic(toolKey, nextAction);
              result.item.detail = nextAction;
            }
            ctx.renderRequest();
          });
          return;
        }
        const lines = [`Permission mode: ${cm.get('permissions.mode')}`, '  Tool settings:'];
        for (const tool of VALID_TOOLS) lines.push(`    ${tool.padEnd(16)} ${cm.get(`permissions.tools.${tool}` as Parameters<typeof cm.get>[0])}`);
        lines.push('', '  Modes: prompt (default), allow-all, custom', '  Usage: /permissions <mode> | /permissions tool <name> allow|prompt|deny');
        ctx.print(lines.join('\n'));
        return;
      }
      if (args[0] === 'tool') {
        const toolName = args[1];
        const action = args[2];
        if (!toolName || !action) {
          ctx.print('Usage: /permissions tool <name> allow|prompt|deny');
          return;
        }
        if (!VALID_TOOLS.includes(toolName as PermTool)) {
          ctx.print(`Unknown tool: ${toolName}\nValid tools: ${VALID_TOOLS.join(', ')}`);
          return;
        }
        if (!VALID_ACTIONS.includes(action as typeof VALID_ACTIONS[number])) {
          ctx.print(`Invalid action: ${action}\nValid actions: allow, prompt, deny`);
          return;
        }
        try {
          cm.setDynamic(`permissions.tools.${toolName}` as Parameters<typeof cm.set>[0], action);
          ctx.print(`Permission for ${toolName} set to: ${action}`);
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
        return;
      }
      if (!VALID_MODES.includes(args[0] as typeof VALID_MODES[number])) {
        ctx.print(`Invalid mode: ${args[0]}\nValid modes: ${VALID_MODES.join(', ')}`);
        return;
      }
      try {
        cm.setDynamic('permissions.mode', args[0]);
        ctx.print(`Permission mode set to: ${args[0]}`);
      } catch (e) {
        ctx.print(`Error: ${(e as Error).message}`);
      }
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
    description: 'Manage encrypted API key secrets',
    usage: 'set <KEY> <value> | get <KEY> | list | delete <KEY>',
    argsHint: '<set|get|list|delete> [KEY]',
    async handler(args, ctx) {
      const mgr = getSecretsManager();
      const [sub, ...rest] = args;
      if (!sub || sub === 'list') {
        const keys = await mgr.list();
        ctx.print(keys.length === 0 ? '[secrets] No secrets stored. Use: /secrets set <KEY> <value>' : ['[secrets] Stored keys (values are encrypted at rest):', ...keys.map(k => `  ${k}`)].join('\n'));
        return;
      }
      if (sub === 'set') {
        const [key, ...valueParts] = rest;
        if (!key || valueParts.length === 0) {
          ctx.print('[secrets] Usage: /secrets set <KEY> <value>');
          return;
        }
        await mgr.set(key, valueParts.join(' '));
        ctx.print(`[secrets] Stored: ${key} (encrypted at rest)`);
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
        const [key] = rest;
        if (!key) {
          ctx.print('[secrets] Usage: /secrets delete <KEY>');
          return;
        }
        await mgr.delete(key);
        ctx.print(`[secrets] Deleted: ${key}`);
        return;
      }
      ctx.print('[secrets] Usage: /secrets set <KEY> <value> | get <KEY> | list | delete <KEY>');
    },
  });

  registry.register({
    name: 'services',
    aliases: ['svc'],
    description: 'Manage API service configurations',
    handler(_args, ctx) {
      const svcRegistry = getServiceRegistry();
      const all = svcRegistry.getAll();
      const keys = Object.keys(all);
      if (ctx.openSelection) {
        const testAction = new Map<string, import('../selection-modal.ts').SelectionAction>([['t', 'select' as const]]);
        const items: SelectionItem[] = keys.length === 0
          ? [{ id: '_empty', label: 'No services configured', detail: '.goodvibes/tui/services.json' }]
          : keys.map((key) => ({ id: key, label: all[key].name ?? key, detail: `${all[key].authType}  ${all[key].baseUrl ?? '(no url)'}`, actions: '[t] test' }));
        ctx.openSelection('Services', items, { allowSearch: true, customActions: testAction }, (result) => {
          if (!result || result.item.id === '_empty') return;
          const svc = all[result.item.id];
          if (!svc) return;
          const baseUrl = svc.baseUrl ?? '';
          if (!baseUrl) {
            ctx.print(`[services] ${result.item.id}: no baseUrl configured`);
            return;
          }
          const testUrl = baseUrl.replace(/\/$/, '') + '/health';
          ctx.print(`[services] Testing ${result.item.id} → GET ${testUrl} …`);
          void svcRegistry.resolveAuth(result.item.id).then(async (headers) => {
            const reqHeaders: Record<string, string> = { Accept: 'application/json', ...(headers ?? {}) };
            try {
              const resp = await fetch(testUrl, { method: 'GET', headers: reqHeaders, signal: AbortSignal.timeout(5000) });
              ctx.print(`[services] ${result.item.id}: HTTP ${resp.status} ${resp.ok ? '\u2713 OK' : '\u2717 error'}`);
            } catch {
              try {
                const resp2 = await fetch(baseUrl, { method: 'GET', headers: reqHeaders, signal: AbortSignal.timeout(5000) });
                ctx.print(`[services] ${result.item.id}: HTTP ${resp2.status} ${resp2.ok ? '\u2713 OK' : '\u2717 error'}`);
              } catch (err2) {
                ctx.print(`[services] ${result.item.id}: error — ${(err2 as Error).message}`);
              }
            }
            ctx.renderRequest();
          });
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
          const toggleAction = new Map<string, import('../selection-modal.ts').SelectionAction>([['enter', 'toggle' as const]]);
          const items: SelectionItem[] = Object.entries(dangerObj).map(([field, val]) => {
            const key = `danger.${field}`;
            const schema = CONFIG_SCHEMA.find(s => s.key === key);
            return { id: key, label: key, detail: String(val), fg: '#ef4444', actions: schema ? `[Enter] toggle  ${schema.description}` : undefined };
          });
          ctx.openSelection('⚠ Danger Zone', items, { allowSearch: false, customActions: toggleAction }, (result) => {
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
