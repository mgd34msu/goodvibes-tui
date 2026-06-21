import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TRIAGE_METHOD_IDS,
  createTriageRegister,
  register,
  registerTriageMethods,
} from '../../../daemon/triage/register.ts';
import { createTriageStore, readTriageMetadata } from '../../../daemon/triage/pipeline.ts';
import { REQUIRE_CONFIRM, type OperatorContext } from '../../../daemon/operator/index.ts';

// ---------------------------------------------------------------------------
// Minimal in-memory catalog mirroring the SDK GatewayMethodCatalog surface
// actually used by declareOperatorMethod (register/invoke/list/get).
// ---------------------------------------------------------------------------

interface CatalogEntry {
  descriptor: Record<string, unknown>;
  handler: (input: {
    body: unknown;
    context: { principalId?: string; metadata?: Record<string, unknown> };
  }) => Promise<unknown>;
}

function makeCatalog() {
  const entries = new Map<string, CatalogEntry>();
  return {
    register(descriptor: Record<string, unknown>, handler: CatalogEntry['handler']) {
      const id = descriptor.id as string;
      entries.set(id, { descriptor, handler });
      return () => {
        entries.delete(id);
      };
    },
    async invoke(
      id: string,
      input: { body: unknown; context: { principalId?: string; metadata?: Record<string, unknown> } },
    ) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`no such method: ${id}`);
      return entry.handler(input);
    },
    list() {
      return [...entries.values()].map((e) => e.descriptor);
    },
    get(id: string) {
      return entries.get(id)?.descriptor ?? null;
    },
    has(id: string) {
      return entries.has(id);
    },
  };
}

let workDir: string;
let catalog: ReturnType<typeof makeCatalog>;

function makeCtx(): OperatorContext {
  return {
    catalog: catalog as unknown as OperatorContext['catalog'],
    secrets: {} as OperatorContext['secrets'],
    configManager: { get: () => undefined, getCategory: () => ({}) } as unknown as OperatorContext['configManager'],
    workingDirectory: workDir,
    homeDirectory: workDir,
    logger: { info() {}, warn() {}, error() {} },
  };
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'gv-triage-reg-'));
  catalog = makeCatalog();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('triage surface registration', () => {
  test('registers exactly the two internal-only methods', () => {
    const unregister = register(makeCtx());
    const ids = catalog.list().map((d) => d.id);
    expect(ids).toContain(TRIAGE_METHOD_IDS.list);
    expect(ids).toContain(TRIAGE_METHOD_IDS.tag);
    expect(TRIAGE_METHOD_IDS.list).toBe('inbox.triage.list');
    expect(catalog.list().length).toBe(2);
    unregister();
    expect(catalog.list().length).toBe(0);
  });

  test('methods use transport ["internal"] ONLY — never ws', () => {
    register(makeCtx());
    for (const id of [TRIAGE_METHOD_IDS.list, TRIAGE_METHOD_IDS.tag]) {
      const descriptor = catalog.get(id)!;
      expect(descriptor.transport).toEqual(['internal']);
      expect((descriptor.transport as string[])).not.toContain('ws');
    }
  });

  test('operator access maps to admin and source daemon maps to builtin', () => {
    register(makeCtx());
    const descriptor = catalog.get(TRIAGE_METHOD_IDS.list)!;
    expect(descriptor.access).toBe('admin');
    expect(descriptor.source).toBe('builtin');
    // effect/confirm are stripped before reaching the catalog.
    expect(descriptor.effect).toBeUndefined();
    expect(descriptor.confirm).toBeUndefined();
  });

  test('tag inputSchema does NOT advertise confirm (confirm-contract fidelity)', () => {
    register(makeCtx());
    const descriptor = catalog.get(TRIAGE_METHOD_IDS.tag)!;
    const schema = descriptor.inputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required).toEqual(['item']);
    expect(schema.required).not.toContain('confirm');
    expect(schema.properties).not.toHaveProperty('confirm');
  });

  test('registerTriageMethods is an alias of register', () => {
    expect(registerTriageMethods).toBe(register);
  });

  test('inbox.triage.list invokes the pipeline and persists scores', async () => {
    register(makeCtx());
    const result = (await catalog.invoke(TRIAGE_METHOD_IDS.list, {
      body: {
        items: [
          { id: 's1', surface: 'email', subject: 'free lottery winner', snippet: 'cash prize http://x http://y' },
          { id: 's2', surface: 'email', subject: 'lunch', snippet: 'next week?' },
        ],
      },
      context: { principalId: 'poller' },
    })) as { scored: number; persisted: number; items: Array<{ triage: { triageLabel: string } }> };

    expect(result.scored).toBe(2);
    expect(result.persisted).toBe(2);
    expect(result.items[0]!.triage.triageLabel).toBe('spam');

    const store = createTriageStore(workDir);
    await store.init();
    try {
      expect(readTriageMetadata(store, 's1')).not.toBeNull();
    } finally {
      store.close();
    }
  });

  test('inbox.triage.list with persist:false does not write', async () => {
    register(makeCtx());
    const result = (await catalog.invoke(TRIAGE_METHOD_IDS.list, {
      body: { persist: false, items: [{ id: 'd1', surface: 'email', subject: 'win cash', snippet: 'free' }] },
      context: { principalId: 'poller' },
    })) as { persisted: number };
    expect(result.persisted).toBe(0);

    const store = createTriageStore(workDir);
    await store.init();
    try {
      expect(readTriageMetadata(store, 'd1')).toBeNull();
    } finally {
      store.close();
    }
  });

  test('inbox.triage.list rejects malformed input', async () => {
    register(makeCtx());
    await expect(
      catalog.invoke(TRIAGE_METHOD_IDS.list, { body: { items: 'not-an-array' }, context: { principalId: 'p' } }),
    ).rejects.toMatchObject({ code: 'TRIAGE_INVALID_INPUT' });
  });

  test('inbox.triage.tag requires confirm + explicitUserRequest', async () => {
    // autotag enabled via injected option so we reach the confirm guard.
    const surfaceRegister = createTriageRegister({ tagger: { autoTagEnabled: true } });
    surfaceRegister(makeCtx());

    // Missing confirm in body — the declareOperatorMethod guard throws first.
    await expect(
      catalog.invoke(TRIAGE_METHOD_IDS.tag, {
        body: { item: { id: 'x', surface: 'slack' } },
        context: { principalId: 'p', metadata: { explicitUserRequest: true } },
      }),
    ).rejects.toMatchObject({ code: REQUIRE_CONFIRM });

    // confirm:true but no explicitUserRequest in metadata — still rejected.
    await expect(
      catalog.invoke(TRIAGE_METHOD_IDS.tag, {
        body: { item: { id: 'x', surface: 'slack' }, confirm: true },
        context: { principalId: 'p' },
      }),
    ).rejects.toMatchObject({ code: REQUIRE_CONFIRM });
  });

  test('inbox.triage.tag no-ops when autotag flag is disabled', async () => {
    // Default register() reads the (undefined) config flag => disabled.
    register(makeCtx());
    const result = (await catalog.invoke(TRIAGE_METHOD_IDS.tag, {
      body: { item: { id: 'x', surface: 'slack', conversationId: 'C1', metadata: { ts: '1.1' } }, confirm: true },
      context: { principalId: 'p', metadata: { explicitUserRequest: true } },
    })) as { skipped: boolean; reason?: string };
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('autotag-disabled');
  });
});
