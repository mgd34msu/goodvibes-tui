import { CommunicationPanel } from '../../../panels/communication-panel.ts';
import { runBasePanelContractSuite } from './_shared.ts';

runBasePanelContractSuite({
  label: 'CommunicationPanel (no readModel)',
  factory: () => new CommunicationPanel(),
  hasSelectionGutter: true, // I5: non-color selection affordance
});
