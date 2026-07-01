import { GitPanel } from '../../../panels/git-panel.ts';
import { runBasePanelContractSuite } from './_shared.ts';

// Wave C trackedRender adoptions
runBasePanelContractSuite({
  label: 'GitPanel (no commits)',
  factory: () => new GitPanel('/tmp'),
});
