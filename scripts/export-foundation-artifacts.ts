import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '../src/control-plane/method-catalog.ts';
import { buildOperatorContract } from '../src/control-plane/operator-contract.ts';
import { getKnowledgeGraphqlSchemaText, renderKnowledgeSchemaSql } from '../src/knowledge/index.ts';
import { getDistributedNodeHostContract } from '../src/runtime/remote/distributed-runtime-contract.ts';
import { renderFoundationClientTypes } from './foundation-typegen.ts';

const ROOT = join(import.meta.dir, '..');
const OUTPUT_DIR = join(ROOT, 'docs', 'foundation-artifacts');
const GENERATED_TYPES_PATH = join(ROOT, 'src', 'types', 'generated', 'foundation-client-types.ts');

function toSerializable(value: unknown, stack = new Map<object, string>(), path = '$'): unknown {
  if (!value || typeof value !== 'object') return value;
  const prior = stack.get(value as object);
  if (prior) {
    return { $ref: prior };
  }
  const next = new Map(stack);
  next.set(value as object, path);
  if (Array.isArray(value)) {
    return value.map((entry, index) => toSerializable(entry, next, `${path}[${index}]`));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      toSerializable(entry, next, `${path}.${key}`),
    ]),
  );
}

function writeJsonArtifact(name: string, value: unknown): void {
  const target = join(OUTPUT_DIR, name);
  const normalized = JSON.stringify(toSerializable(value), null, 2);
  writeFileSync(target, `${normalized}\n`, 'utf8');
}

function writeTextArtifact(name: string, value: string): void {
  writeFileSync(join(OUTPUT_DIR, name), value.endsWith('\n') ? value : `${value}\n`, 'utf8');
}

function writeGeneratedFile(path: string, value: string): void {
  writeFileSync(path, value.endsWith('\n') ? value : `${value}\n`, 'utf8');
}

mkdirSync(OUTPUT_DIR, { recursive: true });

const catalog = new GatewayMethodCatalog();
const operatorContract = buildOperatorContract(catalog);
const peerContract = getDistributedNodeHostContract();

writeJsonArtifact('operator-contract.json', operatorContract);
writeJsonArtifact('peer-contract.json', peerContract);
writeTextArtifact('knowledge-graphql.graphql', getKnowledgeGraphqlSchemaText());
writeTextArtifact('knowledge-store.sql', renderKnowledgeSchemaSql());
mkdirSync(join(ROOT, 'src', 'types', 'generated'), { recursive: true });
writeGeneratedFile(GENERATED_TYPES_PATH, renderFoundationClientTypes(operatorContract, peerContract));

console.log(`foundation artifacts written to ${OUTPUT_DIR}`);
