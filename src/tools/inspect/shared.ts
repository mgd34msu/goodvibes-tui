import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import type {
  InspectMode,
  ProjectInfo,
  ApiRoute,
  DatabaseInfo,
  ComponentInfo,
  LayoutInfo,
  A11yIssue,
  ApiSpec,
  ApiValidateResult,
  ApiSyncResult,
  ComponentStateInfo,
  RenderTriggersInfo,
  HooksInfo,
  OverflowInfo,
  SizingInfo,
  StackingInfo,
  ResponsiveInfo,
  EventsInfo,
  TailwindInfo,
  ClientBoundaryInfo,
  ErrorBoundaryInfo,
} from './schema.ts';

export const VALID_MODES: InspectMode[] = [
  'project',
  'api',
  'api_spec',
  'api_validate',
  'api_sync',
  'database',
  'components',
  'layout',
  'accessibility',
  'scaffold',
  'component_state',
  'render_triggers',
  'hooks',
  'overflow',
  'sizing',
  'stacking',
  'responsive',
  'events',
  'tailwind',
  'client_boundary',
  'error_boundary',
];

export const JSON_OUTPUT_INDENT = 2;
const SUMMARY_SAMPLE_LIMIT = 5;

export type InspectToolResult = { success: boolean; output?: string; error?: string };

export function resolvePath(projectRoot: string, inputPath: string): string {
  const resolved = resolve(inputPath.startsWith('/') ? inputPath : join(projectRoot, inputPath));
  const rel = relative(projectRoot, resolved);
  if (rel.startsWith('..')) {
    throw new Error(`Path '${inputPath}' resolves outside the project root`);
  }
  return resolved;
}

export function requireExistingFilePath(projectRoot: string, inputPath: string, notFoundPrefix: string): string {
  const filePath = resolvePath(projectRoot, inputPath);
  if (!existsSync(filePath)) {
    throw new Error(`${notFoundPrefix}: ${filePath}`);
  }
  return filePath;
}

function takeSample<T>(items: readonly T[] | undefined, limit = SUMMARY_SAMPLE_LIMIT): T[] {
  return Array.isArray(items) ? items.slice(0, limit) : [];
}

export function summarizeInspectValue(mode: InspectMode, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;

  switch (mode) {
    case 'project':
      return {
        type: record.type ?? null,
        name: record.name ?? null,
        packageManager: record.packageManager ?? null,
        hasTypeScript: record.hasTypeScript ?? false,
        testFramework: record.testFramework ?? null,
        dependencyCount: record.dependencies ?? 0,
        devDependencyCount: record.devDependencies ?? 0,
        entryPoints: takeSample(record.entryPoints as string[] | undefined),
      };
    case 'api':
      return {
        count: record.count ?? 0,
        routes: takeSample(record.routes as Array<Record<string, unknown>> | undefined).map((route) => ({
          method: route.method ?? null,
          path: route.path ?? null,
          file: route.file ?? null,
        })),
      };
    case 'database': {
      const models = takeSample(record.models as Array<Record<string, unknown>> | undefined).map((model) => ({
        name: model.name ?? null,
        fieldCount: Array.isArray(model.fields) ? model.fields.length : 0,
      }));
      const enums = takeSample(record.enums as Array<Record<string, unknown>> | undefined).map((entry) => ({
        name: entry.name ?? null,
        valueCount: Array.isArray(entry.values) ? entry.values.length : 0,
      }));
      return {
        modelCount: Array.isArray(record.models) ? record.models.length : 0,
        enumCount: Array.isArray(record.enums) ? record.enums.length : 0,
        models,
        enums,
      };
    }
    case 'components':
      return {
        count: record.count ?? 0,
        components: takeSample(record.components as Array<Record<string, unknown>> | undefined).map((component) => ({
          name: component.name ?? null,
          kind: component.kind ?? null,
          propCount: Array.isArray(component.props) ? component.props.length : 0,
          hookCount: Array.isArray(component.hooks) ? component.hooks.length : 0,
        })),
      };
    case 'layout':
      return {
        file: record.file ?? null,
        displays: takeSample(record.displays as string[] | undefined),
        flex: takeSample(record.flex as string[] | undefined),
        grid: takeSample(record.grid as string[] | undefined),
        sizing: takeSample(record.sizing as string[] | undefined),
        overflow: takeSample(record.overflow as string[] | undefined),
      };
    case 'accessibility':
      return {
        count: record.count ?? 0,
        issues: takeSample(record.issues as Array<Record<string, unknown>> | undefined).map((issue) => ({
          code: issue.code ?? null,
          line: issue.line ?? null,
          wcag: issue.wcag ?? null,
        })),
      };
    case 'api_spec':
      return {
        openapi: record.openapi ?? null,
        pathCount: record.paths && typeof record.paths === 'object' ? Object.keys(record.paths as Record<string, unknown>).length : 0,
        paths: takeSample(Object.keys((record.paths as Record<string, unknown>) ?? {})),
      };
    case 'api_validate':
      return {
        valid: record.valid ?? false,
        missingFromSpec: takeSample(record.missing_from_spec as string[] | undefined),
        missingFromCode: takeSample(record.missing_from_code as string[] | undefined),
      };
    case 'api_sync':
      return {
        driftDetected: record.drift_detected ?? false,
        fetchCallCount: Array.isArray(record.fetch_calls) ? record.fetch_calls.length : 0,
        unmatchedFetches: takeSample(record.unmatched_fetches as Array<Record<string, unknown>> | undefined).map((call) => ({
          url: call.url ?? null,
          file: call.file ?? null,
        })),
        unmatchedRoutes: takeSample(record.unmatched_routes as string[] | undefined),
      };
    case 'scaffold':
      return {
        moduleName: record.moduleName ?? null,
        dryRun: record.dryRun ?? false,
        fileCount: Array.isArray(record.files) ? record.files.length : 0,
        files: takeSample(record.files as Array<Record<string, unknown>> | undefined).map((file) => file.path ?? null),
      };
    case 'component_state':
      return {
        count: record.count ?? 0,
        stateVars: takeSample(record.stateVars as Array<Record<string, unknown>> | undefined).map((item) => ({
          kind: item.kind ?? null,
          name: item.name ?? null,
        })),
      };
    case 'render_triggers':
      return {
        count: record.count ?? 0,
        triggers: takeSample(record.triggers as Array<Record<string, unknown>> | undefined).map((trigger) => ({
          kind: trigger.kind ?? null,
          cause: trigger.cause ?? null,
        })),
      };
    case 'hooks':
      return {
        count: Array.isArray(record.hooks) ? record.hooks.length : 0,
        hooks: takeSample(record.hooks as Array<Record<string, unknown>> | undefined).map((hook) => ({
          hookKind: hook.hookKind ?? null,
          deps: takeSample(hook.deps as string[] | undefined),
        })),
      };
    case 'overflow':
      return {
        count: record.count ?? 0,
        issues: takeSample(record.issues as Array<Record<string, unknown>> | undefined).map((issue) => ({
          kind: issue.kind ?? null,
          line: issue.line ?? null,
        })),
      };
    case 'sizing':
      return {
        count: Array.isArray(record.items) ? record.items.length : 0,
        items: takeSample(record.items as Array<Record<string, unknown>> | undefined).map((item) => ({
          kind: item.kind ?? null,
          line: item.line ?? null,
        })),
      };
    case 'stacking':
      return {
        count: Array.isArray(record.zIndexItems) ? record.zIndexItems.length : 0,
        zIndexItems: takeSample(record.zIndexItems as Array<Record<string, unknown>> | undefined).map((item) => ({
          value: item.value ?? null,
          line: item.line ?? null,
        })),
      };
    case 'responsive':
      return {
        hasMobileFirst: record.hasMobileFirst ?? false,
        breakpointCount: Array.isArray(record.breakpoints) ? record.breakpoints.length : 0,
        breakpoints: takeSample(record.breakpoints as Array<Record<string, unknown>> | undefined).map((bp) => bp.prefix ?? null),
      };
    case 'events':
      return {
        count: record.count ?? 0,
        handlers: takeSample(record.handlers as Array<Record<string, unknown>> | undefined).map((handler) => ({
          event: handler.event ?? null,
          line: handler.line ?? null,
        })),
      };
    case 'tailwind':
      return {
        count: record.count ?? 0,
        conflicts: takeSample(record.conflicts as Array<Record<string, unknown>> | undefined).map((conflict) => ({
          reason: conflict.reason ?? null,
          classes: takeSample(conflict.classes as string[] | undefined),
        })),
      };
    case 'client_boundary':
      return {
        directive: record.directive ?? null,
        importsServerOnly: record.importsServerOnly ?? false,
        serverOnlyImports: takeSample(record.serverOnlyImports as string[] | undefined),
      };
    case 'error_boundary':
      return {
        hasErrorBoundary: record.hasErrorBoundary ?? false,
        boundaryComponents: takeSample(record.boundaryComponents as string[] | undefined),
      };
    default:
      return value;
  }
}

export function serializeInspectOutput(value: unknown, format: string, mode: InspectMode): string {
  const shaped = format === 'summary' ? summarizeInspectValue(mode, value) : value;
  return JSON.stringify(shaped, null, format === 'json' ? JSON_OUTPUT_INDENT : 0);
}

export async function walk(
  dir: string,
  filter: (p: string) => boolean,
  skipDirs: Set<string> = new Set(['.git', 'node_modules', 'dist', '.next', '.cache', '__pycache__']),
  depth = 0,
): Promise<string[]> {
  if (depth > 10) return [];
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) {
        const sub = await walk(full, filter, skipDirs, depth + 1);
        results.push(...sub);
      }
    } else if (filter(full)) {
      results.push(full);
    }
  }
  return results;
}

export function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

export function createInspectFailure(error: string): InspectToolResult {
  return { success: false, error };
}

export function createInspectSuccess(output: unknown, format: string, mode: InspectMode): InspectToolResult {
  return { success: true, output: serializeInspectOutput(output, format, mode) };
}

export function readRequiredFile(
  projectRoot: string,
  inputFile: string | undefined,
  mode: string,
  errorMessage: string,
): { filePath: string; content: string } | InspectToolResult {
  if (!inputFile) {
    return createInspectFailure(`file is required for ${mode} mode`);
  }
  const filePath = requireExistingFilePath(projectRoot, inputFile, errorMessage);
  return { filePath, content: safeRead(filePath) };
}

