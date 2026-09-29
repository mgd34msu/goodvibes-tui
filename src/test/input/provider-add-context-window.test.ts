/**
 * `/provider add` writes a model's context window only when the endpoint
 * reported one. It used to write `contextWindow: 8192` for every model it
 * could not measure (every https endpoint), and that guess then read as the
 * model's real window: the live run on abacusai route-llm showed
 * `29.9k / 8.2k` and small-window compaction on every turn.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerLocalProviderRuntimeCommands } from '../../input/commands/local-provider-runtime.ts';

const realFetch = globalThis.fetch;
const roots: string[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function addProvider(baseURL: string, modelIds: readonly string[]): Promise<{ file: Record<string, unknown>; printed: string }> {
  const root = makeProjectTempDir('gv-provider-add');
  roots.push(root);
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: modelIds.map((id) => ({ id })) }), { status: 200 })) as unknown as typeof fetch;
  const printed: string[] = [];
  const context = {
    workspace: { shellPaths: { resolveUserPath: (...parts: string[]) => join(root, ...parts) } },
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
  };
  const registry = new CommandRegistry();
  registerLocalProviderRuntimeCommands(registry);
  await registry.execute('provider', ['add', 'router', baseURL], context as never);
  const file = JSON.parse(readFileSync(join(root, 'tui', 'providers', 'router.json'), 'utf-8')) as Record<string, unknown>;
  return { file, printed: printed.join('\n') };
}

describe('/provider add context windows', () => {
  test('an https endpoint that reports no window gets no guessed contextWindow', async () => {
    const { file, printed } = await addProvider('https://routellm.example/v1', ['route-llm', 'gpt-x']);
    const models = file['models'] as Array<Record<string, unknown>>;
    expect(models.map((m) => m['id'])).toEqual(['route-llm', 'gpt-x']);
    for (const model of models) expect('contextWindow' in model).toBe(false);
    expect(printed).toContain('route-llm (context window unknown)');
    expect(printed).not.toContain('8,192');
  });

  test('the starter entry for an endpoint that lists no models has no guessed window either', async () => {
    const { file } = await addProvider('https://empty.example/v1', []);
    const models = file['models'] as Array<Record<string, unknown>>;
    expect(models).toHaveLength(1);
    expect('contextWindow' in models[0]!).toBe(false);
  });
});
