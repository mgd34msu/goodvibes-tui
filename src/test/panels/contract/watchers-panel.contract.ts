import { WatchersPanel } from '../../../panels/watchers-panel.ts';
import { runBasePanelContractSuite } from './_shared.ts';

runBasePanelContractSuite({
  label: 'WatchersPanel (no readModel)',
  factory: () => new WatchersPanel(),
  hasSelectionGutter: true, // I5: non-color selection affordance
});
