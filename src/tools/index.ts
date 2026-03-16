import { ToolRegistry } from './registry.ts';
import { FileStateCache } from '../state/file-cache.ts';
import { ProjectIndex } from '../state/project-index.ts';
import { ReadTool } from './read/index.ts';
import { createWriteTool } from './write/index.ts';
import { createEditTool } from './edit/index.ts';
import { findTool } from './find/index.ts';
import { execTool } from './exec/index.ts';
import { analyzeTool } from './analyze/index.ts';
import { InspectTool } from './inspect/index.ts';
import { agentTool } from './agent/index.ts';
import { fetchTool } from './fetch/index.ts';
import { createStateTool } from './state/index.ts';
import { workflowTool } from './workflow/index.ts';
import { createRegistryTool } from './registry-tool/index.ts';
import { KVState } from '../state/kv-state.ts';

/**
 * Register all built-in tools into the given registry.
 * Creates shared FileStateCache and ProjectIndex instances so read/write/edit
 * tools share cache state within a session.
 */
export function registerAllTools(registry: ToolRegistry): void {
  const fileCache = new FileStateCache();
  const projectIndex = ProjectIndex.getInstance();

  registry.register(new ReadTool(fileCache, projectIndex));
  registry.register(createWriteTool({ fileCache, projectIndex }));
  registry.register(createEditTool(fileCache));
  registry.register(findTool);
  registry.register(execTool);
  registry.register(analyzeTool);
  registry.register(new InspectTool());
  registry.register(agentTool);
  const kvState = new KVState();
  registry.register(createStateTool(kvState, projectIndex));
  registry.register(workflowTool);
  registry.register(fetchTool);
  registry.register(createRegistryTool(registry));
}
