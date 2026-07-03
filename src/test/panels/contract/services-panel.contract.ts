import { ServicesPanel } from '../../../panels/services-panel.ts';
import { runBasePanelContractSuite, EMPTY_SERVICE_QUERY, EMPTY_SERVICES_SUBSCRIPTION_QUERY } from './_shared.ts';

runBasePanelContractSuite({
  label: 'ServicesPanel',
  factory: () => new ServicesPanel(EMPTY_SERVICE_QUERY, EMPTY_SERVICES_SUBSCRIPTION_QUERY),
  hasSelectionGutter: true, // I5: non-color selection affordance (already set in earlier wave)
});
