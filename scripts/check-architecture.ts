import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..');
const SRC_ROOT = join(ROOT, 'src');
const SCRIPTS_ROOT = join(ROOT, 'scripts');
const MAX_SOURCE_LINES = 800;

type Rule = {
  readonly name: string;
  readonly files: readonly string[];
  readonly pattern: RegExp;
  readonly allow?: readonly string[];
  readonly message: string;
};

function walk(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(abs));
      continue;
    }
    if (entry.isFile() && abs.endsWith('.ts')) {
      files.push(abs);
    }
  }
  return files;
}

function isTestSource(path: string): boolean {
  return path.includes('/src/test/') || path.endsWith('.test.ts') || path.includes('/__tests__/');
}

function expandTargets(targets: readonly string[]): string[] {
  return targets.flatMap((target) => {
    const abs = join(ROOT, target);
    if (!existsSync(abs)) {
      return [];
    }
    const stats = statSync(abs);
    if (stats.isDirectory()) {
      return walk(abs).filter((file) => !isTestSource(file));
    }
    return [abs];
  });
}

function isGenericObjectSchema(schema: Record<string, unknown> | undefined): boolean {
  return Boolean(schema && schema.type === 'object' && !Object.hasOwn(schema, 'properties'));
}

const allSourceFiles = walk(SRC_ROOT);
const scriptFiles = walk(SCRIPTS_ROOT);
const nonTestFiles = allSourceFiles.filter((file) => !isTestSource(file));
const testFiles = allSourceFiles.filter((file) => isTestSource(file));
const explicitAnyFiles = [...allSourceFiles, ...scriptFiles];
const violations: string[] = [];

for (const file of nonTestFiles) {
  const text = readFileSync(file, 'utf-8');
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lineCount = normalized.length === 0 ? 0 : normalized.split('\n').length;
  if (lineCount > MAX_SOURCE_LINES) {
    violations.push(`${relative(ROOT, file)}: exceeds ${MAX_SOURCE_LINES} lines (${lineCount})`);
  }
}

const rules: readonly Rule[] = [
  {
    name: 'no-runtime-globals',
    files: nonTestFiles,
    pattern: /__goodvibesRuntime(Store|Dispatch)/,
    message: 'runtime store/dispatch globals are forbidden; use RuntimeServices ownership instead',
  },
  {
    name: 'no-ambient-integration-helper-usage',
    files: nonTestFiles,
    pattern: /\b(setIntegrationHelpersContext|clearIntegrationHelpersContext|getIntegrationHelpersContextOptional|getLegacyIntegrationHelperService)\b/,
    allow: ['src/runtime/integration/helpers.ts'],
    message: 'ambient integration-helper access is forbidden outside the helper module',
  },
  {
    name: 'no-legacy-runtime-singletons',
    files: nonTestFiles,
    pattern: /\b(getPolicyRuntimeState|getMemoryRegistry|getMemoryStore|getSubscriptionManager|getLocalUserAuthManager|getRemoteRunnerRegistry|getDistributedRuntimeManagerForTesting|resetDistributedRuntimeManagerForTesting|_setKnowledgeRegistryForTesting|_resetMemoryRegistryForTesting|FeatureFlagManager\.getInstance|getSecretsManager)\b/,
    allow: ['src/config/secrets.ts'],
    message: 'legacy singleton/service-locator access is forbidden; use explicit RuntimeServices ownership or explicit instances',
  },
  {
    name: 'no-ambient-tool-singletons',
    files: nonTestFiles,
    pattern: /\b(fetchTool|findTool|execTool)\b/,
    message: 'ambient tool singletons are forbidden; construct tool instances explicitly',
  },
  {
    name: 'no-singleton-core-lookups-in-adapters',
    files: expandTargets([
      'src/daemon',
      'src/control-plane/routes',
      'src/runtime/bootstrap.ts',
      'src/runtime/bootstrap-services.ts',
      'src/daemon/cli.ts',
      'src/daemon/control-plane.ts',
    ]),
    pattern: /\b(AutomationManager|SharedSessionBroker|ApprovalBroker|RouteBindingManager|SurfaceRegistry|WatcherRegistry|ChannelPolicyManager)\.getInstance\(|\bgetDistributedRuntimeManager\(/,
    message: 'adapter/composition code must use explicit RuntimeServices ownership instead of singleton lookups',
  },
  {
    name: 'no-service-active-lookups-in-adapters',
    files: expandTargets([
      'src/daemon',
      'src/control-plane/routes',
      'src/channels/delivery',
    ]),
    pattern: /\b(ArtifactStore|KnowledgeService|VoiceService|WebSearchService|MediaProviderRegistry|MultimodalService|GatewayMethodCatalog|ControlPlaneGateway)\.getActive\(/,
    message: 'adapter-layer code must receive app-owned services instead of pulling active instances',
  },
  {
    name: 'no-singleton-lookups-in-shell-bridges',
    files: expandTargets([
      'src/main.ts',
      'src/runtime/bootstrap-command-context.ts',
      'src/runtime/bootstrap-runtime-events.ts',
      'src/panels/control-plane-panel.ts',
      'src/panels/schedule-panel.ts',
      'src/channels/builtin-runtime.ts',
      'src/channels/builtin/rendering.ts',
    ]),
    pattern: /\b(AutomationManager|SharedSessionBroker|ApprovalBroker|AgentManager|ModeManager|ChannelPolicyManager|FileUndoManager)\.getInstance\(|\bChannelDeliveryRouter\.getActive\(/,
    message: 'shell adapters and builtin channel bridges must receive explicit app-owned dependencies',
  },
  {
    name: 'future-foundation-surfaces-no-server-or-shell-imports',
    files: expandTargets([
      'src/runtime/operator-client.ts',
      'src/runtime/peer-client.ts',
      'src/runtime/transports',
      'src/runtime/runtime-provider-api.ts',
      'src/runtime/runtime-knowledge-api.ts',
      'src/runtime/runtime-hook-api.ts',
      'src/runtime/runtime-mcp-api.ts',
      'src/providers/provider-api.ts',
      'src/knowledge/knowledge-api.ts',
      'src/hooks/hook-api.ts',
      'src/mcp/mcp-api.ts',
    ]),
    pattern: /from ['"][.\/]+(?:\.\.\/)*(?:daemon|input|panels|renderer)(?:\/|\.ts['"])/,
    message: 'future foundation/client surfaces must not depend on daemon or shell modules',
  },
  {
    name: 'future-server-surfaces-no-shell-imports',
    files: expandTargets([
      'src/daemon',
      'src/control-plane/routes',
    ]),
    pattern: /from ['"][.\/]+(?:\.\.\/)*(?:input|panels|renderer)(?:\/|\.ts['"])/,
    message: 'future server surfaces must not depend on TUI shell modules',
  },
  {
    name: 'no-raw-generic-object-contract-schemas',
    files: expandTargets([
      'src/control-plane/operator-contract-schemas-admin.ts',
      'src/control-plane/operator-contract-schemas-channels.ts',
      'src/control-plane/operator-contract-schemas-knowledge.ts',
      'src/control-plane/operator-contract-schemas-media.ts',
      'src/control-plane/operator-contract-schemas-permissions.ts',
      'src/control-plane/operator-contract-schemas-remote.ts',
      'src/control-plane/operator-contract-schemas.ts',
      'src/control-plane/media-contract-schemas.ts',
      'src/control-plane/operator-contract.ts',
    ]),
    pattern: /\bJSON_OBJECT_SCHEMA\b/,
    message: 'contract schema modules must use explicit DTO schemas or named typed JSON record/document schemas instead of raw JSON_OBJECT_SCHEMA',
  },
  {
    name: 'no-implicit-project-root-literals',
    files: nonTestFiles,
    allow: [
      'src/main.ts',
      'src/daemon/cli.ts',
      'src/runtime/worktree/registry.ts',
    ],
    pattern: /join\(\s*['"]\.goodvibes['"]|join\(\s*['"]\.['"]\s*,\s*['"]\.goodvibes['"]|workspaceRoot:\s*['"]\.['"]/,
    message: 'reusable code must not hide project-root ownership behind relative .goodvibes paths or "." workspace roots; inject explicit owned roots instead',
  },
  {
    name: 'no-ambient-root-discovery-in-reusable-code',
    files: nonTestFiles,
    allow: [
      'src/main.ts',
      'src/daemon/cli.ts',
    ],
    pattern: /\bprocess\.cwd\(\)|\bhomedir\(\)/,
    message: 'reusable code must not discover cwd/home implicitly; composition roots must pass owned roots explicitly',
  },
];

for (const rule of rules) {
  for (const file of rule.files) {
    const rel = relative(ROOT, file);
    if (rule.allow?.includes(rel)) continue;
    const text = readFileSync(file, 'utf-8');
    if (rule.pattern.test(text)) {
      violations.push(`${rel}: ${rule.message} [${rule.name}]`);
    }
  }
}

for (const file of explicitAnyFiles) {
  const text = readFileSync(file, 'utf-8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const rel = relative(ROOT, file);
  const seenPositions = new Set<number>();

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const start = node.getStart(source);
      if (!seenPositions.has(start)) {
        seenPositions.add(start);
        const { line, character } = source.getLineAndCharacterOfPosition(start);
        violations.push(`${rel}:${line + 1}:${character + 1}: explicit any is forbidden`);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
}

for (const file of testFiles) {
  const text = readFileSync(file, 'utf-8');
  if (text.includes('mock.module(')) {
    violations.push(`${relative(ROOT, file)}: process-global mock.module() is forbidden in tests; use explicit dependency injection or local spies instead`);
  }
}

const requiredSnippets: Array<{ file: string; snippets: readonly string[]; message: string }> = [
  {
    file: 'scripts/project-surfaces.ts',
    snippets: [
      'GatewayMethodCatalog',
      '@pellux/goodvibes-sdk/platform/control-plane/operator-contract',
    ],
    message: 'foundation artifacts must be generated from SDK control-plane surfaces',
  },
  {
    file: 'src/daemon/facade.ts',
    snippets: [
      '@pellux/goodvibes-sdk/platform/daemon/http/router',
      '@pellux/goodvibes-sdk/platform/control-plane/index',
    ],
    message: 'daemon runtime composition must stay wired through the SDK package surface',
  },
];

for (const requirement of requiredSnippets) {
  const file = join(ROOT, requirement.file);
  const text = readFileSync(file, 'utf-8');
  if (!requirement.snippets.some((snippet) => text.includes(snippet))) {
    violations.push(`${requirement.file}: ${requirement.message}`);
  }
}

const { GatewayMethodCatalog } = await import('@pellux/goodvibes-sdk/platform/control-plane/method-catalog');
const catalog = new GatewayMethodCatalog();
const methodIds = new Set(catalog.list().map((method) => method.id));
if (!methodIds.has('control.contract')) {
  violations.push('operator-contract: control.contract must stay cataloged');
}
if (!methodIds.has('remote.node_host.contract')) {
  violations.push('operator-contract: remote.node_host.contract must stay cataloged');
}
for (const method of catalog.list()) {
  if (isGenericObjectSchema(method.inputSchema)) {
    violations.push(`operator-contract: ${method.id} still exposes a generic object input schema`);
  }
  if (isGenericObjectSchema(method.outputSchema)) {
    violations.push(`operator-contract: ${method.id} still exposes a generic object output schema`);
  }
}

if (violations.length > 0) {
  console.error('Architecture check failed:\n');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(`Architecture check passed for ${nonTestFiles.length} non-test source files.`);
