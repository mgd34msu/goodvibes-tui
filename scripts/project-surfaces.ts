import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPeerContract } from '@pellux/goodvibes-sdk/contracts';
import { GatewayMethodCatalog, buildOperatorContract } from '@pellux/goodvibes-sdk/platform/control-plane';
import { getKnowledgeGraphqlSchemaText, renderKnowledgeSchemaSql } from '@pellux/goodvibes-sdk/platform/knowledge';
import { categorizeBuiltinCommands } from '../src/input/commands.ts';
import { renderCommandReferenceMarkdown } from '../src/input/command-reference.ts';

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

  const operatorContract = buildOperatorContract(new GatewayMethodCatalog());
  const peerContract = getPeerContract();

  writeJsonArtifact(outputDir, 'operator-contract.json', operatorContract);
  writeJsonArtifact(outputDir, 'peer-contract.json', peerContract);
  writeTextArtifact(outputDir, 'knowledge-graphql.graphql', getKnowledgeGraphqlSchemaText());
  writeTextArtifact(outputDir, 'knowledge-store.sql', renderKnowledgeSchemaSql());

  console.log(`foundation artifacts written to ${outputDir}`);
}

/**
 * Generate docs/commands-reference.md from the live slash-command registry.
 * The committed file is guarded against drift by
 * src/test/release-gates/command-reference-gate.test.ts, which regenerates and
 * byte-compares (the same idiom as the foundation-artifact goldens above).
 */
export function syncCommandReference(root = ROOT): void {
  const markdown = renderCommandReferenceMarkdown(categorizeBuiltinCommands());
  const target = join(root, 'docs', 'commands-reference.md');
  writeFileSync(target, markdown, 'utf8');
  console.log(`command reference written to ${target}`);
}

export function syncProjectSurfaces(root = ROOT): string {
  const version = syncVersionSurfaces(root);
  syncFoundationArtifacts(root);
  syncCommandReference(root);
  console.log(`prebuild: done (v${version})`);
  return version;
}
