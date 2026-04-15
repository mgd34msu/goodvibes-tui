import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane/method-catalog';
import { buildOperatorContract } from '@pellux/goodvibes-sdk/platform/control-plane/operator-contract';
import { getKnowledgeGraphqlSchemaText, renderKnowledgeSchemaSql } from '@pellux/goodvibes-sdk/platform/knowledge/index';
import { getDistributedNodeHostContract } from '@pellux/goodvibes-sdk/platform/runtime/remote/distributed-runtime-contract';
import { renderFoundationClientTypes } from '../../../scripts/foundation-typegen.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');
const ARTIFACTS_DIR = join(ROOT, 'docs', 'foundation-artifacts');
const GENERATED_TYPES_PATH = join(ROOT, 'src', 'types', 'generated', 'foundation-client-types.ts');

function canonicalJson(value: unknown): string {
  function toSerializable(entry: unknown, stack = new Map<object, string>(), path = '$'): unknown {
    if (!entry || typeof entry !== 'object') return entry;
    const prior = stack.get(entry as object);
    if (prior) {
      return { $ref: prior };
    }
    const next = new Map(stack);
    next.set(entry as object, path);
    if (Array.isArray(entry)) {
      return entry.map((item, index) => toSerializable(item, next, `${path}[${index}]`));
    }
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>).map(([key, value]) => [
        key,
        toSerializable(value, next, `${path}.${key}`),
      ]),
    );
  }

  return `${JSON.stringify(toSerializable(value), null, 2)}\n`;
}

describe('foundation artifacts gate', () => {
  test('operator and peer contract artifacts stay in sync with the canonical runtime builders', () => {
    const catalog = new GatewayMethodCatalog();

    expect(readFileSync(join(ARTIFACTS_DIR, 'operator-contract.json'), 'utf8')).toBe(
      canonicalJson(buildOperatorContract(catalog)),
    );
    expect(readFileSync(join(ARTIFACTS_DIR, 'peer-contract.json'), 'utf8')).toBe(
      canonicalJson(getDistributedNodeHostContract()),
    );
  });

  test('canonical SQL and GraphQL artifacts stay in sync with the knowledge foundation surfaces', () => {
    const normalizeText = (value: string): string => value.endsWith('\n') ? value : `${value}\n`;
    expect(readFileSync(join(ARTIFACTS_DIR, 'knowledge-graphql.graphql'), 'utf8')).toBe(
      normalizeText(getKnowledgeGraphqlSchemaText()),
    );
    expect(readFileSync(join(ARTIFACTS_DIR, 'knowledge-store.sql'), 'utf8')).toBe(
      normalizeText(renderKnowledgeSchemaSql()),
    );
  });

  test('generated foundation client types stay in sync with the canonical contracts', () => {
    const catalog = new GatewayMethodCatalog();
    const operatorContract = buildOperatorContract(catalog);
    const peerContract = getDistributedNodeHostContract();
    expect(readFileSync(GENERATED_TYPES_PATH, 'utf8')).toBe(
      `${renderFoundationClientTypes(operatorContract, peerContract).replace(/\n?$/, '\n')}`,
    );
  });
});
