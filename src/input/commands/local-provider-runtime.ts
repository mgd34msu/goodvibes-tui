import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import type { CommandRegistry } from '../command-registry.ts';
import { fetchModelContextWindows } from '../../discovery/scanner.ts';
import type { CustomProviderConfig } from '../../providers/custom-loader.ts';

function isValidProviderName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

export function registerLocalProviderRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'provider',
    aliases: ['p'],
    description: 'Switch provider or manage custom providers (add/remove)',
    usage: '[add <name> <baseURL> [apiKey] | remove <name> | <provider-name>]',
    argsHint: '[add|remove|name]',
    async handler(args, ctx) {
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
                .map((m) => String(m.id))
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
          : discoveredModelIds.map((id) => ({
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
        ctx.print(`Provider '${name}' added with ${models.length} model(s):\n${discoveredModelIds.length > 0 ? discoveredModelIds.map((id) => `  • ${id} (${(contextWindows[id] ?? 8192).toLocaleString()} ctx)`).join('\n') : `  • ${defaultModel} (starter entry)`}\nThe file watcher will auto-register it shortly.`);
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
        ctx.print(['Available providers:', ...providers.map((provider) => `  ${provider === ctx.runtime.provider ? '▶' : ' '} ${provider}`)].join('\n'));
        return;
      }

      const providerName = args[0];
      const match = ctx.providerRegistry.getSelectableModels().find((model) => model.provider === providerName);
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
}
