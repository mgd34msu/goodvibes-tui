import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretsManager } from '../../config/secrets.ts';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-secret-refs-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function goodVibesRef(source: string, id: string): string {
  return `goodvibes://secrets/${source}/${encodeURIComponent(id)}`;
}

describe('secret refs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    delete process.env.GV_EXTERNAL_REF_TEST;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('SecretsManager resolves stored SecretRef values with local indirection', async () => {
    const manager = new SecretsManager({ projectRoot: tmpDir, globalHome: join(tmpDir, 'home') });
    await manager.set('GV_INNER_SECRET', 'stored-secret', { scope: 'project', medium: 'secure' });
    await manager.set('GV_OUTER_SECRET', goodVibesRef('goodvibes', 'GV_INNER_SECRET'), { scope: 'project', medium: 'secure' });

    expect(await manager.get('GV_OUTER_SECRET')).toBe('stored-secret');
    const records = await manager.listDetailed();
    expect(records.find((record) => record.key === 'GV_OUTER_SECRET')?.refSource).toBe('goodvibes');
  });

  test('SecretsManager keeps env provider-style values raw unless they are GoodVibes secret refs', async () => {
    const manager = new SecretsManager({ projectRoot: tmpDir, globalHome: join(tmpDir, 'home') });
    const externalProviderValue = `op:${'//'}Private/GoodVibes/API%20Key`;
    process.env.GV_EXTERNAL_REF_TEST = externalProviderValue;

    expect(await manager.get('GV_EXTERNAL_REF_TEST')).toBe(externalProviderValue);
  });
});
