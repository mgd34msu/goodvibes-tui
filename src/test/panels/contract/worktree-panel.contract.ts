import { WorktreePanel } from '../../../panels/worktree-panel.ts';
import { runBasePanelContractSuite, EMPTY_WORKTREE_REGISTRY } from './_shared.ts';

runBasePanelContractSuite({
  label: 'WorktreePanel',
  factory: () => new WorktreePanel(EMPTY_WORKTREE_REGISTRY),
  hasSelectionGutter: true, // I5: non-color selection affordance
});
