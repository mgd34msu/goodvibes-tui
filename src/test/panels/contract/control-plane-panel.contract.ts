import { ControlPlanePanel } from '../../../panels/control-plane-panel.ts';
import { runBasePanelContractSuite } from './_shared.ts';

runBasePanelContractSuite({
  label: 'ControlPlanePanel (no readModel)',
  factory: () => new ControlPlanePanel(),
  hasSelectionGutter: true, // I5: non-color selection affordance
});
