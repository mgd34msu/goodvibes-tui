import type { PanelManager } from '../panel-manager.ts';
import { MemoryPanel } from '../memory-panel.ts';
import { KnowledgeGraphPanel } from '../knowledge-graph-panel.ts';
import { requireKnowledgeApi, type ResolvedBuiltinPanelDeps } from './shared.ts';

export function registerKnowledgePanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  manager.registerType({
    id: 'knowledge',
    name: 'Knowledge',
    icon: 'K',
    category: 'agent',
    description: 'Live SDK knowledge graph: nodes, sources, issue review queue, and search',
    factory: () => new KnowledgeGraphPanel(requireKnowledgeApi(deps), () => manager.open('memory')),
  });
  if (deps.memoryRegistry) {
    const { memoryRegistry } = deps;
    manager.registerType({
      id: 'memory',
      name: 'Memory',
      icon: 'M',
      category: 'agent',
      description: 'Project memory: decisions, constraints, incidents, and patterns with provenance links',
      factory: () => new MemoryPanel(memoryRegistry),
    });
  }
}
