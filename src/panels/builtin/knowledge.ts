import type { PanelManager } from '../panel-manager.ts';
import { MemoryPanel } from '../memory-panel.ts';
import { KnowledgeGraphPanel } from '../knowledge-graph-panel.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';

export function registerKnowledgePanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  // KnowledgeGraphPanel is a no-arg panel — always register it regardless of memoryRegistry.
  manager.registerType({
    id: 'knowledge',
    name: 'Knowledge',
    icon: 'K',
    category: 'agent',
    description: 'Structured project knowledge: risks, runbooks, architecture notes, incidents, and durable facts',
    factory: () => new KnowledgeGraphPanel(),
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
