import { HooksPanel } from '../../../panels/hooks-panel.ts';
import { runBasePanelContractSuite, EMPTY_HOOKS_WORKBENCH } from './_shared.ts';

runBasePanelContractSuite({
  label: 'HooksPanel',
  factory: () => new HooksPanel(
    null as unknown as import('@pellux/goodvibes-sdk/platform/hooks').HookDispatcher,
    null as unknown as import('@pellux/goodvibes-sdk/platform/hooks').HookWorkbench,
    null as unknown as import('@pellux/goodvibes-sdk/platform/hooks').HookActivityTracker,
    {
      listContracts: () => [],
      listHooks: () => [],
      listChains: () => [],
      listRecentActivity: () => [],
      getWorkbench: () => EMPTY_HOOKS_WORKBENCH as never,
    },
  ),
  hasSelectionGutter: true, // S5
});
