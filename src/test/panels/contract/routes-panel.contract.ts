import { RoutesPanel } from '../../../panels/routes-panel.ts';
import { runBasePanelContractSuite } from './_shared.ts';

runBasePanelContractSuite({
  label: 'RoutesPanel (no readModel)',
  factory: () => new RoutesPanel(),
  hasSelectionGutter: true, // S5
});
