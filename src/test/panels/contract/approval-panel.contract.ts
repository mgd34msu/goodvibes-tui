import { ApprovalPanel } from '../../../panels/approval-panel.ts';
import { runBasePanelContractSuite, EMPTY_POLICY_RUNTIME_STATE } from './_shared.ts';

runBasePanelContractSuite({
  label: 'ApprovalPanel',
  factory: () => new ApprovalPanel(EMPTY_POLICY_RUNTIME_STATE),
  hasSelectionGutter: true, // I5: non-color selection affordance
});
