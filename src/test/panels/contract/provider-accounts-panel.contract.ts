import { ProviderAccountsPanel } from '../../../panels/provider-accounts-panel.ts';
import { runBasePanelContractSuite, EMPTY_PROVIDER_ACCOUNTS_DEPS } from './_shared.ts';

runBasePanelContractSuite({
  label: 'ProviderAccountsPanel',
  factory: () => new ProviderAccountsPanel(EMPTY_PROVIDER_ACCOUNTS_DEPS),
  hasSelectionGutter: true, // I5: non-color selection affordance
});
