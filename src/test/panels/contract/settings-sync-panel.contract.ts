import { SettingsSyncPanel } from '../../../panels/settings-sync-panel.ts';
import { runBasePanelContractSuite, EMPTY_CONFIG_MANAGER } from './_shared.ts';

runBasePanelContractSuite({
  label: 'SettingsSyncPanel',
  factory: () => new SettingsSyncPanel(EMPTY_CONFIG_MANAGER),
  hasSelectionGutter: true, // I5: non-color selection affordance
});
