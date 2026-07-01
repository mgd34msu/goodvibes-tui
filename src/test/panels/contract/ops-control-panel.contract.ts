import { OpsControlPanel } from '../../../panels/ops-control-panel.ts';
import { runBasePanelContractSuite, EMPTY_OPS_EVENT_FEED } from './_shared.ts';

runBasePanelContractSuite({
  label: 'OpsControlPanel',
  factory: () => new OpsControlPanel(EMPTY_OPS_EVENT_FEED as never),
  hasSelectionGutter: true, // I5: non-color selection affordance
});
