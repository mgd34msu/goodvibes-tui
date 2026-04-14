import type { ApiFramework, InspectInput } from './schema.ts';
import { summarizeError } from '../../utils/error-display.ts';
import {
  createInspectFailure,
  createInspectSuccess,
  requireExistingFilePath,
  safeRead,
  readRequiredFile,
  type InspectToolResult,
} from './shared.ts';
import {
  detectProject,
  inspectApi,
  parsePrismaSchema,
  generateApiSpec,
  validateApiSpec,
  inspectApiSync,
  buildScaffold,
} from './project.ts';
import {
  inspectComponents,
  inspectLayout,
  inspectAccessibility,
  inspectComponentState,
  inspectRenderTriggers,
  inspectHooks,
  inspectOverflow,
  inspectSizing,
  inspectStacking,
  inspectResponsive,
  inspectEvents,
  inspectTailwind,
  inspectClientBoundary,
  inspectErrorBoundary,
} from './frontend.ts';

export async function executeInspectMode(
  input: InspectInput,
  projectRoot: string,
  format: string,
): Promise<InspectToolResult> {
  try {
    switch (input.mode) {
      case 'project':
        return createInspectSuccess(detectProject(projectRoot), format, input.mode);

      case 'api': {
        const framework: ApiFramework = (input.framework ?? 'auto') as ApiFramework;
        const routes = await inspectApi(projectRoot, framework);
        return createInspectSuccess({ routes, count: routes.length }, format, input.mode);
      }

      case 'database': {
        const schemaPath = input.schemaPath
          ? requireExistingFilePath(projectRoot, input.schemaPath, 'Database schema not found at')
          : requireExistingFilePath(projectRoot, 'prisma/schema.prisma', 'Database schema not found at');
        return createInspectSuccess(parsePrismaSchema(safeRead(schemaPath)), format, input.mode);
      }

      case 'components': {
        const file = readRequiredFile(projectRoot, input.file, 'components', 'File not found');
        if ('success' in file) return file;
        const comps = inspectComponents(file.content);
        return createInspectSuccess({ components: comps, count: comps.length }, format, input.mode);
      }

      case 'layout': {
        const file = readRequiredFile(projectRoot, input.file, 'layout', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectLayout(file.content, input.file!), format, input.mode);
      }

      case 'accessibility': {
        const file = readRequiredFile(projectRoot, input.file, 'accessibility', 'File not found');
        if ('success' in file) return file;
        const a11yIssues = inspectAccessibility(file.content);
        return createInspectSuccess({ issues: a11yIssues, count: a11yIssues.length }, format, input.mode);
      }

      case 'api_spec': {
        const framework: ApiFramework = (input.framework ?? 'auto') as ApiFramework;
        const routes = await inspectApi(projectRoot, framework);
        return createInspectSuccess(generateApiSpec(routes), format, input.mode);
      }

      case 'api_validate': {
        if (!input.specPath) {
          return createInspectFailure('specPath is required for api_validate mode');
        }
        const resolvedSpec = readRequiredFile(projectRoot, input.specPath, 'api_validate', 'Spec file not found at');
        if ('success' in resolvedSpec) return resolvedSpec;
        const framework: ApiFramework = (input.framework ?? 'auto') as ApiFramework;
        const routes = await inspectApi(projectRoot, framework);
        return createInspectSuccess(validateApiSpec(resolvedSpec.content, routes), format, input.mode);
      }

      case 'api_sync': {
        const framework: ApiFramework = (input.framework ?? 'auto') as ApiFramework;
        return createInspectSuccess(await inspectApiSync(projectRoot, framework), format, input.mode);
      }

      case 'scaffold': {
        if (!input.moduleName) {
          return createInspectFailure('moduleName is required for scaffold mode');
        }
        const dryRun = input.dryRun !== false;
        return createInspectSuccess(buildScaffold(input.moduleName, projectRoot, dryRun), format, input.mode);
      }

      case 'component_state': {
        const file = readRequiredFile(projectRoot, input.file, 'component_state', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectComponentState(file.content, input.file!), format, input.mode);
      }

      case 'render_triggers': {
        const file = readRequiredFile(projectRoot, input.file, 'render_triggers', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectRenderTriggers(file.content, input.file!), format, input.mode);
      }

      case 'hooks': {
        const file = readRequiredFile(projectRoot, input.file, 'hooks', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectHooks(file.content, input.file!), format, input.mode);
      }

      case 'overflow': {
        const file = readRequiredFile(projectRoot, input.file, 'overflow', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectOverflow(file.content, input.file!), format, input.mode);
      }

      case 'sizing': {
        const file = readRequiredFile(projectRoot, input.file, 'sizing', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectSizing(file.content, input.file!), format, input.mode);
      }

      case 'stacking': {
        const file = readRequiredFile(projectRoot, input.file, 'stacking', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectStacking(file.content, input.file!), format, input.mode);
      }

      case 'responsive': {
        const file = readRequiredFile(projectRoot, input.file, 'responsive', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectResponsive(file.content, input.file!), format, input.mode);
      }

      case 'events': {
        const file = readRequiredFile(projectRoot, input.file, 'events', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectEvents(file.content, input.file!), format, input.mode);
      }

      case 'tailwind': {
        const file = readRequiredFile(projectRoot, input.file, 'tailwind', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectTailwind(file.content, input.file!), format, input.mode);
      }

      case 'client_boundary': {
        const file = readRequiredFile(projectRoot, input.file, 'client_boundary', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectClientBoundary(file.content, input.file!), format, input.mode);
      }

      case 'error_boundary': {
        const file = readRequiredFile(projectRoot, input.file, 'error_boundary', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectErrorBoundary(file.content, input.file!), format, input.mode);
      }

      default:
        return createInspectFailure(`Unknown mode: ${input.mode}`);
    }
  } catch (err) {
    const message = summarizeError(err);
    return { success: false, error: `inspect (${input.mode}): ${message}` };
  }
}
