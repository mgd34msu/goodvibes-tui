import { TokenBudgetPanel } from '../../../panels/token-budget-panel.ts';
import { runBasePanelContractSuite, EMPTY_SESSION_MEMORY_QUERY, EMPTY_CONFIG_MANAGER } from './_shared.ts';

runBasePanelContractSuite({
  label: 'TokenBudgetPanel (no history)',
  factory: () => new TokenBudgetPanel(EMPTY_SESSION_MEMORY_QUERY, EMPTY_CONFIG_MANAGER),
});
