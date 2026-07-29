import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerCloudflareRuntimeCommands } from '../../input/commands/cloudflare-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeContext(options: {
  readonly out?: string[];
  readonly opened?: string[];
  readonly homeDirectory?: string;
  readonly config?: Record<string, unknown>;
} = {}): CommandContext {
  const out = options.out ?? [];
  const opened = options.opened ?? [];
  const config: Record<string, unknown> = {
    'controlPlane.host': '127.0.0.1',
    'controlPlane.port': 3421,
    'controlPlane.publicBaseUrl': '',
    'batch.mode': 'off',
    'batch.queueBackend': 'local',
    ...options.config,
  };
  return {
    session: {
      conversationManager: {} as never,
      runtime: { model: 'gpt-5.4', provider: 'openai', debugMode: false, systemPrompt: '', reasoningEffort: 'medium', sessionId: 'sess' },
    },
    provider: { providerRegistry: {} as never },
    workspace: {
      shellPaths: {
        homeDirectory: options.homeDirectory ?? makeProjectTempDir('goodvibes-cloudflare-cmd'),
        workingDirectory: process.cwd(),
      } as never,
    },
    platform: {
      config: {} as never,
      configManager: {
        get(key: string) {
          return config[key];
        },
      } as never,
    },
    ops: {},
    extensions: { toolRegistry: {} as never, mcpRegistry: {} as never },
    renderRequest: () => {},
    print: (text) => out.push(text),
    exit: () => {},
    openOnboardingWizard: (modeOrOptions) => opened.push(JSON.stringify(modeOrOptions ?? null)),
  };
}

describe('Cloudflare runtime commands', () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit; body: unknown }> = [];

  beforeEach(() => {
    requests.length = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null;
      requests.push({ url: href, init, body });
      if (href.endsWith('/api/cloudflare/token/requirements')) {
        return Response.json({
          ok: true,
          components: (body as Record<string, unknown>).components,
          permissions: [{ component: 'dns', scope: 'zone', permission: 'DNS Edit', reason: 'custom hostname' }],
          bootstrapToken: { requiredForSdkCreation: true, storeInGoodVibes: false, instructions: ['Create a temporary token.'] },
        });
      }
      if (href.endsWith('/api/cloudflare/provision')) {
        return Response.json({
          ok: true,
          dryRun: false,
          steps: [{ name: 'worker', status: 'ok', message: 'created' }],
          account: { id: 'acc-1', name: 'Account' },
          worker: { name: 'goodvibes-batch-worker', baseUrl: 'https://worker.example.dev' },
        }, { status: 202 });
      }
      return Response.json({
        enabled: false,
        ready: false,
        configured: {},
        config: {},
        warnings: [],
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('/cloudflare setup opens onboarding at the Cloudflare flow', async () => {
    const registry = new CommandRegistry();
    registerCloudflareRuntimeCommands(registry);
    const out: string[] = [];
    const opened: string[] = [];
    const ctx = makeContext({ out, opened });

    await registry.execute('cloudflare', ['setup'], ctx);

    expect(opened).toEqual(['{"mode":"edit","reset":true}']);
    expect(out[0]).toContain('Opening onboarding wizard');
    expect(requests).toHaveLength(0);
  });

  test('/cloudflare requirements uses selected components through the daemon SDK route', async () => {
    const registry = new CommandRegistry();
    registerCloudflareRuntimeCommands(registry);
    const out: string[] = [];
    const ctx = makeContext({ out });

    await registry.execute('cloudflare', ['requirements', 'dns', '--no-component', 'queues'], ctx);

    expect(out.join('\n')).toContain('Cloudflare Token Requirements');
    expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/cloudflare/token/requirements');
    expect(requests[0]?.body).toMatchObject({
      components: { workers: true, queues: false, dns: true },
      includeBootstrap: true,
    });
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toMatch(/^Bearer /);
  });

  test('/cloudflare provision sends batch mode and resource fields to the daemon SDK route', async () => {
    const registry = new CommandRegistry();
    registerCloudflareRuntimeCommands(registry);
    const out: string[] = [];
    const ctx = makeContext({ out });

    await registry.execute('cloudflare', [
      'provision',
      '--account',
      'acc-1',
      '--batch-mode',
      'explicit',
      '--daemon-url',
      'https://daemon.example.com',
    ], ctx);

    expect(out.join('\n')).toContain('Cloudflare Provisioning');
    expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/cloudflare/provision');
    expect(requests[0]?.body).toMatchObject({
      accountId: 'acc-1',
      daemonBaseUrl: 'https://daemon.example.com',
      batchMode: 'explicit',
      persistConfig: true,
      verify: true,
      storeApiToken: true,
      enableWorkersDev: true,
    });
  });
});
