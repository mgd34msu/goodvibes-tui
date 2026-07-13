import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import type { CommandRegistry } from '../command-registry.ts';
import { fetchModelContextWindows } from '@pellux/goodvibes-sdk/platform/discovery';
import type { CustomProviderConfig } from '@pellux/goodvibes-sdk/platform/providers';
import { requireProviderApi, requireSecretsManager, requireShellPaths } from './runtime-services.ts';
import { ensureProviderKeyThenSelect } from '../provider-key-intake.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

function isValidProviderName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

/** Conventional secrets-store key a custom provider reads its API key from. */
function customProviderKeyName(providerName: string): string {
  return `${providerName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`;
}

export function registerLocalProviderRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'provider',
    aliases: ['p'],
    description: 'Switch provider or manage custom providers (add/remove)',
    usage: '[add <name> <baseURL> | remove <name> | <provider-name>]',
    argsHint: '[add|remove|name]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      if (args[0] === 'add') {
        const addArgs = args.slice(1);
        if (addArgs.length < 2) {
          ctx.print('Usage: /provider add <name> <baseURL>\nExample: /provider add my-server http://192.168.0.85:8001/v1\nAfter the provider is created you can enter its API key with the keystrokes masked (or skip it for keyless endpoints).');
          return;
        }
        const [name, baseURL] = addArgs;
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
        const providersDir = shellPaths.resolveUserPath('tui', 'providers');
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
        // The key is never embedded in the provider JSON. The config references
        // it by name (apiKeyEnv) and the actual value lands in the secrets
        // manager below, resolved live at request time.
        const keyName = customProviderKeyName(name);
        const config: CustomProviderConfig = {
          name,
          displayName: name,
          type: 'openai-compat',
          baseURL,
          apiKeyEnv: keyName,
          models,
        };
        try {
          mkdirSync(providersDir, { recursive: true });
          await writeFile(providerFile, JSON.stringify(config, null, 2), 'utf-8');
        } catch (e) {
          ctx.print(`Error writing provider file: ${summarizeError(e)}`);
          return;
        }
        ctx.print(`Provider '${name}' added with ${models.length} model(s):\n${discoveredModelIds.length > 0 ? discoveredModelIds.map((id) => `  • ${id} (${(contextWindows[id] ?? 8192).toLocaleString()} ctx)`).join('\n') : `  • ${defaultModel} (starter entry)`}\nThe file watcher will auto-register it shortly.`);
        // Capture the key with the keystrokes masked, straight into the secrets
        // manager — never a cleartext argument, never written into the JSON.
        if (ctx.beginConcealedInput) {
          const secretsManager = requireSecretsManager(ctx);
          ctx.print(`Enter the API key for provider '${name}' (input is masked; press Enter to store, Esc to skip if the endpoint needs no key).`);
          ctx.beginConcealedInput({
            label: name,
            onSubmit: (value) => {
              if (value.length === 0) {
                ctx.print(`No key stored for '${name}' (endpoint used without a key).`);
                return;
              }
              void (async () => {
                try {
                  await secretsManager.set(keyName, value, { scope: 'user', medium: 'secure' });
                  ctx.print(`Stored the API key for '${name}' (value hidden). It resolves live for this provider — no restart needed.`);
                } catch (error) {
                  ctx.print(`Could not store the key for '${name}': ${summarizeError(error)}`);
                }
              })();
            },
            onCancel: () => {
              ctx.print(`No key stored for '${name}' (endpoint used without a key).`);
            },
          });
        }
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
        const providerFile = shellPaths.resolveUserPath('tui', 'providers', `${name}.json`);
        if (!existsSync(providerFile)) {
          ctx.print(`Error: No custom provider '${name}' found at ${providerFile}`);
          return;
        }
        try {
          await unlink(providerFile);
          ctx.print(`Provider '${name}' removed. The file watcher will deregister it shortly.`);
        } catch (e) {
          ctx.print(`Error removing provider file: ${summarizeError(e)}`);
        }
        return;
      }

      if (args.length === 0) {
        if (ctx.openProviderPicker) {
          ctx.openProviderPicker();
          return;
        }
        const providers = requireProviderApi(ctx).listProviderIds();
        ctx.print(['Available providers:', ...providers.map((provider) => `  ${provider === ctx.session.runtime.provider ? '▶' : ' '} ${provider}`)].join('\n'));
        return;
      }

      const providerName = args[0];
      const providerApi = requireProviderApi(ctx);
      const selectable = await providerApi.listModels({
        providerId: providerName,
        selectableOnly: true,
      });
      const match = selectable[0];
      if (!match) {
        ctx.print(`Unknown provider: ${providerName}. Available: ${providerApi.listProviderIds().join(', ')}`);
        return;
      }
      try {
        const selected = await providerApi.selectModel(match.registryKey);
        // Unconfigured provider selected → capture its key inline, then finish
        // the switch so it lands ready to chat.
        ensureProviderKeyThenSelect(ctx, selected.providerId, () => {
          ctx.session.runtime.model = selected.registryKey;
          ctx.session.runtime.provider = selected.providerId;
          ctx.platform.configManager.set('provider.model', selected.registryKey);
          ctx.print(`Switched to provider: ${selected.providerId} (model: ${selected.modelId})`);
        });
      } catch (e) {
        ctx.print(`Error: ${summarizeError(e)}`);
      }
    },
  });
}
