import { AutomationControlPanel } from '../../../panels/automation-control-panel.ts';
import { runBasePanelContractSuite } from './_shared.ts';

runBasePanelContractSuite({
  label: 'AutomationControlPanel (no readModel)',
  factory: () => new AutomationControlPanel(),
  hasSelectionGutter: true, // I5: non-color selection affordance
});
