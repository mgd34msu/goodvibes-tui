import { PluginsPanel } from '../../../panels/plugins-panel.ts';
import { runBasePanelContractSuite, EMPTY_PLUGIN_MANAGER } from './_shared.ts';

runBasePanelContractSuite({
  label: 'PluginsPanel',
  factory: () => new PluginsPanel(EMPTY_PLUGIN_MANAGER),
  hasSelectionGutter: true, // I5: non-color selection affordance
});
