import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane/method-catalog';
import { getKnowledgeGraphqlSchemaText, renderKnowledgeSchemaSql } from '@pellux/goodvibes-sdk/platform/knowledge/index';
import { getDistributedNodeHostContract } from '@pellux/goodvibes-sdk/platform/runtime/remote/distributed-runtime-contract';
import { buildOperatorContract } from '@pellux/goodvibes-sdk/platform/control-plane/operator-contract';

const ROOT = join(import.meta.dir, '..');

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

function writeJsonArtifact(outputDir: string, name: string, value: unknown): void {
  const target = join(outputDir, name);
  const normalized = JSON.stringify(toSerializable(value), null, 2);
  writeFileSync(target, `${normalized}\n`, 'utf8');
}

function writeTextArtifact(outputDir: string, name: string, value: string): void {
  writeFileSync(join(outputDir, name), value.endsWith('\n') ? value : `${value}\n`, 'utf8');
}

export function syncVersionSurfaces(root = ROOT): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const version = pkg.version;

  const versionTsPath = join(root, 'src', 'version.ts');
  try {
    let versionTs = readFileSync(versionTsPath, 'utf8');
    versionTs = versionTs.replace(/let _version = '[^']*'/, `let _version = '${version}'`);
    writeFileSync(versionTsPath, versionTs);
    console.log(`prebuild: src/version.ts fallback → ${version}`);
  } catch {
    console.log('prebuild: src/version.ts — not found, skipping');
  }

  const readmePath = join(root, 'README.md');
  try {
    let readme = readFileSync(readmePath, 'utf8');
    const versionRe = /version-[0-9]+\.[0-9]+\.[0-9]+-blue\.svg/;
    if (versionRe.test(readme)) {
      readme = readme.replace(versionRe, `version-${version}-blue.svg`);
      writeFileSync(readmePath, readme);
      console.log(`prebuild: README.md → ${version}`);
    } else {
      console.log('prebuild: README.md — no version badge found, skipping');
    }
  } catch {
    console.log('prebuild: README.md — not found, skipping');
  }

  return version;
}

export function syncFoundationArtifacts(root = ROOT): void {
  const outputDir = join(root, 'docs', 'foundation-artifacts');

  mkdirSync(outputDir, { recursive: true });

  const catalog = new GatewayMethodCatalog();
  const operatorContract = buildOperatorContract(catalog);
  const peerContract = getDistributedNodeHostContract();

  writeJsonArtifact(outputDir, 'operator-contract.json', operatorContract);
  writeJsonArtifact(outputDir, 'peer-contract.json', peerContract);
  writeTextArtifact(outputDir, 'knowledge-graphql.graphql', getKnowledgeGraphqlSchemaText());
  writeTextArtifact(outputDir, 'knowledge-store.sql', renderKnowledgeSchemaSql());

  console.log(`foundation artifacts written to ${outputDir}`);
}

export function syncProjectSurfaces(root = ROOT): string {
  const version = syncVersionSurfaces(root);
  syncFoundationArtifacts(root);
  console.log(`prebuild: done (v${version})`);
  return version;
}
