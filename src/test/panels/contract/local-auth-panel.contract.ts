import { LocalAuthPanel } from '../../../panels/local-auth-panel.ts';
import { runBasePanelContractSuite, EMPTY_LOCAL_AUTH_MANAGER } from './_shared.ts';

runBasePanelContractSuite({
  label: 'LocalAuthPanel',
  factory: () => new LocalAuthPanel(EMPTY_LOCAL_AUTH_MANAGER),
  hasSelectionGutter: true, // I5: non-color selection affordance
});
