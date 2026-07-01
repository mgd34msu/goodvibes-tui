import { SecurityPanel } from '../../../panels/security-panel.ts';
import { runBasePanelContractSuite, makeReadModelMock, EMPTY_SECURITY_SNAPSHOT } from './_shared.ts';

runBasePanelContractSuite({
  label: 'SecurityPanel',
  factory: () => new SecurityPanel(makeReadModelMock(EMPTY_SECURITY_SNAPSHOT) as never),
  hasSelectionGutter: true, // I5: non-color selection affordance
});
