import { DiffPanel } from '../../../panels/diff-panel.ts';
import { runBasePanelContractSuite } from './_shared.ts';

runBasePanelContractSuite({
  label: 'DiffPanel (no entries)',
  factory: () => new DiffPanel('/tmp'),
});
