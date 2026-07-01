import { SubscriptionPanel } from '../../../panels/subscription-panel.ts';
import { runBasePanelContractSuite, EMPTY_SERVICE_REGISTRY, EMPTY_SUBSCRIPTION_MANAGER } from './_shared.ts';

runBasePanelContractSuite({
  label: 'SubscriptionPanel',
  factory: () => new SubscriptionPanel(
    EMPTY_SERVICE_REGISTRY as never,
    EMPTY_SUBSCRIPTION_MANAGER as never,
  ),
  hasSelectionGutter: true, // I5: non-color selection affordance
});
