import { ToolRegistry } from './registry.ts';
import { FileStateCache } from '../state/file-cache.ts';
import { ProjectIndex } from '../state/project-index.ts';
import { ModeManager } from '../state/mode-manager.ts';
import { HookDispatcher } from '../hooks/dispatcher.ts';
import { FileUndoManager } from '../state/file-undo.ts';
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
import { taskTool } from './task/index.ts';
import { teamTool } from './team/index.ts';
import { worklistTool } from './worklist/index.ts';
import { mcpTool } from './mcp/index.ts';
import { packetTool } from './packet/index.ts';
import { queryTool } from './query/index.ts';
import { remoteTool } from './remote-trigger/index.ts';
import { replTool } from './repl/index.ts';
import { controlTool } from './control/index.ts';
import { channelTool } from './channel/index.ts';
import { webSearchTool } from './web-search/index.ts';

/**
 * Register all built-in tools into the given registry.
 * Creates shared FileStateCache and ProjectIndex instances so read/write/edit
 * tools share cache state within a session.
 */
export function registerAllTools(
  registry: ToolRegistry,
  deps?: { fileCache?: FileStateCache; projectIndex?: ProjectIndex },
): { fileCache: FileStateCache; projectIndex: ProjectIndex } {
  const fileCache = deps?.fileCache ?? new FileStateCache();
  const projectIndex = deps?.projectIndex ?? ProjectIndex.getInstance();
  const fileUndoManager = FileUndoManager.getInstance();

  registry.register(new ReadTool(fileCache, projectIndex));
  registry.register(createWriteTool({ fileCache, projectIndex, fileUndoManager }));
  registry.register(createEditTool(fileCache, { fileUndoManager }));
  registry.register(findTool);
  registry.register(execTool);
  registry.register(analyzeTool);
  registry.register(new InspectTool());
  registry.register(agentTool);
  const kvState = new KVState();
  const hookDispatcher = new HookDispatcher();
  const modeManager = ModeManager.getInstance();
  registry.register(createStateTool(kvState, projectIndex, hookDispatcher, modeManager));
  registry.register(workflowTool);
  registry.register(fetchTool);
  registry.register(webSearchTool);
  registry.register(createRegistryTool(registry));
  registry.register(taskTool);
  registry.register(teamTool);
  registry.register(worklistTool);
  registry.register(mcpTool);
  registry.register(packetTool);
  registry.register(queryTool);
  registry.register(remoteTool);
  registry.register(replTool);
  registry.register(controlTool);
  registry.register(channelTool);
  return { fileCache, projectIndex };
}
