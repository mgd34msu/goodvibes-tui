import { KnowledgeGraphPanel } from '../../../panels/knowledge-graph-panel.ts';
import { runBasePanelContractSuite } from './_shared.ts';

// TASK-040: KnowledgeGraphPanel is now the registered 'knowledge' panel id
runBasePanelContractSuite({
  label: 'KnowledgeGraphPanel (graph front-door)',
  factory: () => new KnowledgeGraphPanel(),
});
