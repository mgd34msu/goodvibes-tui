import type { PanelManager } from '../panel-manager.ts';
import { MemoryPanel } from '../memory-panel.ts';
import { KnowledgeGraphPanel } from '../knowledge-graph-panel.ts';
import { requireKnowledgeApi, withUnconfiguredFallback, type ResolvedBuiltinPanelDeps } from './shared.ts';

export function registerKnowledgePanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  manager.registerType({
    id: 'knowledge',
    name: 'Knowledge',
    icon: 'K',
    category: 'agent',
    description: 'Live SDK knowledge graph: nodes, sources, issue review queue, and search',
    factory: () => new KnowledgeGraphPanel(requireKnowledgeApi(deps), () => manager.open('memory')),
  });
  // WO-152: always registered (was gated behind `if (deps.memoryRegistry)`,
  // so `/panel open memory` reported "Unknown panel" on builds without a
  // memory registry wired). Falls back to a "dependency not configured"
  // empty state.
  {
    const { memoryRegistry } = deps;
    manager.registerType({
      id: 'memory',
      name: 'Memory',
      icon: 'M',
      category: 'agent',
      description: 'Project memory: decisions, constraints, incidents, and patterns with provenance links',
      factory: withUnconfiguredFallback(
        memoryRegistry !== undefined,
        'memory', 'Memory', 'M', 'agent',
        ' Memory registry not configured for this session.',
        'This runtime was not wired with a project memory registry at bootstrap, so no memory data is available.',
        () => new MemoryPanel(memoryRegistry!),
      ),
    });
  }
}
